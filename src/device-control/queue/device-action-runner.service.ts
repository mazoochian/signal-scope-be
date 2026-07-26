import { Injectable, Logger } from '@nestjs/common';
import { DeviceAction, DeviceActionKind } from '../adapters/vendor-adapter.interface';
import { AdapterRegistryService } from '../adapters/adapter-registry.service';
import { CapabilityRegistryService } from '../capabilities/capability-registry.service';
import { DeviceConnectionService } from '../connection/device-connection.service';
import { CommandAuditService, ActorKind } from '../audit/command-audit.service';
import { SshCliTransport } from '../transport/ssh-transport';
import { TelnetCliTransport } from '../transport/telnet-transport';
import { CliChannel } from '../transport/cli-channel.interface';
import { snmpGet, snmpSet, snmpWalk } from '../transport/snmp-transport';

export interface DeviceActionRequest {
  deviceId: number;
  /** Exactly one of action/rawLine is set — a structured DeviceAction, or (see executeRawLine below) a pre-sanitized raw CLI passthrough line. Routed through the same per-device queue so a raw command and a structured action against the same device never race against each other's transport session. */
  action?: DeviceAction;
  rawLine?: string;
  actorKind: ActorKind;
  actorId?: string | null;
  /** Skips the SNMP path entirely and forces CLI, or vice versa — mainly for testing each path independently against the simulator. */
  forceTransport?: 'cli' | 'snmp';
}

export interface DeviceActionResult {
  ok: boolean;
  usedTransport: 'ssh' | 'telnet' | 'snmp';
  linesSent: string[];
  readback?: string;
  error?: string;
  /** id of the last device_command_audit row written for this action — used by pending-changes.service.ts to link a drained offline change to the audit entry that applied it. */
  lastAuditId?: number;
}

const IF_NAME_OID_PREFIX = '1.3.6.1.2.1.31.1.1.1.1'; // ifXTable::ifName

/**
 * Executes one DeviceAction against one device: resolves the adapter,
 * decides CLI vs SNMP, dials, runs the literal plan, reads back, and
 * writes the audit trail. This is the single execution path used both for
 * live actions and for draining pending_changes (sync/pending-changes.service.ts)
 * — an agent-initiated or offline-queued change goes through exactly the
 * same code as a live human action, per gui-cli-snmp-unification.md.
 */
@Injectable()
export class DeviceActionRunnerService {
  private readonly log = new Logger(DeviceActionRunnerService.name);

  constructor(
    private readonly adapters: AdapterRegistryService,
    private readonly capabilities: CapabilityRegistryService,
    private readonly connections: DeviceConnectionService,
    private readonly audit: CommandAuditService,
  ) {}

  async execute(req: DeviceActionRequest): Promise<DeviceActionResult> {
    if (req.rawLine != null) {
      return this.executeRawLine(req.deviceId, req.rawLine, req.actorId ?? null);
    }
    if (!req.action) {
      return { ok: false, usedTransport: 'ssh', linesSent: [], error: 'Neither action nor rawLine was provided' };
    }

    const device = await this.connections.getDevice(req.deviceId);
    const adapter = this.adapters.resolve(device.vendorProfileId);
    const target = await this.connections.getPrimaryTarget(req.deviceId);
    if (!target) {
      return { ok: false, usedTransport: 'ssh', linesSent: [], error: 'No connection target configured for this device' };
    }

    const wantSnmp =
      req.forceTransport === 'snmp' ||
      (req.forceTransport !== 'cli' && target.transport === 'snmp');

    if (wantSnmp) {
      return this.executeViaSnmp({ ...req, action: req.action }, target, adapter);
    }
    return this.executeViaCli({ ...req, action: req.action }, target, adapter);
  }

  private async executeViaSnmp(
    req: DeviceActionRequest,
    target: Awaited<ReturnType<DeviceConnectionService['getPrimaryTarget']>>,
    adapter: ReturnType<AdapterRegistryService['resolve']>,
  ): Promise<DeviceActionResult> {
    if (!target) throw new Error('unreachable'); // narrowed by caller

    const supported = await this.capabilities.supportsSnmpWrite(req.deviceId, req.action.kind as DeviceActionKind);
    if (!supported) {
      return {
        ok: false,
        usedTransport: 'snmp',
        linesSent: [],
        error: `No documented SNMP write path for ${req.action.kind} on this device — see device_capabilities`,
      };
    }

    let ops = adapter.buildSnmpPlan(req.action);
    if (!ops) {
      return { ok: false, usedTransport: 'snmp', linesSent: [], error: `Adapter has no SNMP plan for ${req.action.kind}` };
    }

    const credential = await this.connections.getDecryptedCredential(req.deviceId, 'snmp_v2c_community');
    const snmpOpts = { host: target.host, port: target.port || 161, community: credential?.secret ?? 'public', version: 'v2c' as const };

    // Resolve <ifIndex> placeholder against ifXTable::ifName if this action targets an interface.
    if ('interfaceName' in req.action && ops.some((o) => o.oid.includes('<ifIndex>'))) {
      const ifIndex = await this.resolveIfIndex(snmpOpts, (req.action as { interfaceName: string }).interfaceName);
      if (ifIndex == null) {
        return { ok: false, usedTransport: 'snmp', linesSent: [], error: `Could not resolve ifIndex for ${(req.action as { interfaceName: string }).interfaceName}` };
      }
      ops = ops.map((o) => ({ ...o, oid: o.oid.replace('<ifIndex>', String(ifIndex)) }));
    }

    const commandTexts = ops.map((o) => `# SNMP SET ${o.description}`);
    try {
      await snmpSet(snmpOpts, ops);
      let lastAuditId: number | undefined;
      for (const text of commandTexts) {
        lastAuditId = await this.audit.record({
          deviceId: req.deviceId,
          actorKind: req.actorKind,
          actorId: req.actorId,
          transport: 'snmp',
          commandText: text,
          result: 'ok',
        });
      }
      return { ok: true, usedTransport: 'snmp', linesSent: commandTexts, lastAuditId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const text of commandTexts) {
        await this.audit.record({
          deviceId: req.deviceId, actorKind: req.actorKind, actorId: req.actorId,
          transport: 'snmp', commandText: text, rawResponse: message, result: 'error',
        });
      }
      return { ok: false, usedTransport: 'snmp', linesSent: commandTexts, error: message };
    }
  }

  private async resolveIfIndex(snmpOpts: Parameters<typeof snmpGet>[0], interfaceName: string): Promise<number | null> {
    const varbinds = await snmpWalk(snmpOpts, IF_NAME_OID_PREFIX);
    for (const vb of varbinds) {
      const value = vb.value instanceof Buffer ? vb.value.toString('utf8') : String(vb.value);
      if (value === interfaceName) {
        const parts = vb.oid.split('.');
        return Number(parts[parts.length - 1]);
      }
    }
    return null;
  }

  /**
   * Raw CLI passthrough — a human's literal typed command, forwarded as-is
   * after sanitization/cli-command-sanitizer.ts has already cleared it
   * (this method assumes the caller sanitized `line`; it does not
   * re-sanitize). Opens its own short-lived dial rather than reusing a
   * structured DeviceAction plan, since there's no adapter-independent way
   * to represent an arbitrary line. Unlike structured actions, a raw
   * command is never queued into pending_changes when the device is
   * unreachable — there's no safe way to "replay" an arbitrary typed line
   * later without the operator re-confirming it still makes sense against
   * whatever state the device is in by then, so this fails outright
   * instead (documented in device-control/README.md).
   */
  async executeRawLine(deviceId: number, line: string, actorId: string | null): Promise<DeviceActionResult> {
    const device = await this.connections.getDevice(deviceId);
    const adapter = this.adapters.resolve(device.vendorProfileId);
    const target = await this.connections.getPrimaryTarget(deviceId);
    if (!target || target.transport === 'snmp') {
      return { ok: false, usedTransport: 'ssh', linesSent: [], error: 'No CLI-capable connection target configured for this device' };
    }

    const transportKind = target.transport === 'telnet' ? 'telnet' : 'ssh';
    const channel: CliChannel = transportKind === 'telnet' ? new TelnetCliTransport() : new SshCliTransport();
    const credKind = transportKind === 'telnet' ? 'telnet_password' : 'ssh_password';
    const credential = await this.connections.getDecryptedCredential(deviceId, credKind);
    const sessionId = await this.audit.openSession(deviceId, transportKind);

    try {
      await channel.connect({ host: target.host, port: target.port, username: credential?.username ?? undefined, password: credential?.secret });
      await this.audit.markSessionOpen(sessionId);

      const promptAll = Object.values(adapter.cliDialect.promptPatterns).filter(Boolean) as RegExp[];
      if (adapter.cliDialect.enableSequence) {
        for (const seq of adapter.cliDialect.enableSequence) await channel.sendAndWait(seq, promptAll);
      }
      if (adapter.cliDialect.pagingDisableCmd) {
        await channel.sendAndWait(adapter.cliDialect.pagingDisableCmd, promptAll);
      }

      const out = await channel.sendAndWait(line, promptAll);
      const lastAuditId = await this.audit.record({
        deviceId, sessionId, actorKind: 'human-cli', actorId,
        transport: transportKind, commandText: line, rawResponse: out, result: 'ok',
      });

      await channel.close();
      await this.audit.closeSession(sessionId);
      return { ok: true, usedTransport: transportKind, linesSent: [line], readback: out, lastAuditId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.audit.record({ deviceId, sessionId, actorKind: 'human-cli', actorId, transport: transportKind, commandText: line, rawResponse: message, result: 'error' });
      await this.audit.closeSession(sessionId, undefined, message);
      try { await channel.close(); } catch { /* already broken */ }
      return { ok: false, usedTransport: transportKind, linesSent: [], error: message };
    }
  }

  private async executeViaCli(
    req: DeviceActionRequest,
    target: NonNullable<Awaited<ReturnType<DeviceConnectionService['getPrimaryTarget']>>>,
    adapter: ReturnType<AdapterRegistryService['resolve']>,
  ): Promise<DeviceActionResult> {
    const plan = adapter.buildCliPlan(req.action);
    if (!plan) {
      return { ok: false, usedTransport: target.transport === 'telnet' ? 'telnet' : 'ssh', linesSent: [], error: `Adapter has no CLI plan for ${req.action.kind}` };
    }

    const transportKind = target.transport === 'telnet' ? 'telnet' : 'ssh';
    const channel: CliChannel = transportKind === 'telnet' ? new TelnetCliTransport() : new SshCliTransport();
    const credKind = transportKind === 'telnet' ? 'telnet_password' : 'ssh_password';
    const credential = await this.connections.getDecryptedCredential(req.deviceId, credKind);

    const sessionId = await this.audit.openSession(req.deviceId, transportKind);
    const sent: string[] = [];
    let readback: string | undefined;

    try {
      await channel.connect({
        host: target.host,
        port: target.port,
        username: credential?.username ?? undefined,
        password: credential?.secret,
      });
      await this.audit.markSessionOpen(sessionId);

      const promptAll = Object.values(adapter.cliDialect.promptPatterns).filter(Boolean) as RegExp[];

      // Enable sequence (session setup — not itself part of the audited action plan, but still echoed/logged for traceability).
      if (adapter.cliDialect.enableSequence) {
        for (const line of adapter.cliDialect.enableSequence) {
          await channel.sendAndWait(line, promptAll);
        }
      }
      if (adapter.cliDialect.pagingDisableCmd) {
        await channel.sendAndWait(adapter.cliDialect.pagingDisableCmd, promptAll);
      }

      let lastAuditId: number | undefined;
      for (const line of plan) {
        const out = await channel.sendAndWait(line, promptAll);
        sent.push(line);
        lastAuditId = await this.audit.record({
          deviceId: req.deviceId, sessionId, actorKind: req.actorKind, actorId: req.actorId,
          transport: transportKind, commandText: line, rawResponse: out, result: 'ok',
        });
      }

      const readbackCmd = adapter.buildReadbackCommand(req.action);
      if (readbackCmd) {
        readback = await channel.sendAndWait(readbackCmd, promptAll);
        await this.audit.record({
          deviceId: req.deviceId, sessionId, actorKind: 'system', actorId: 'readback',
          transport: transportKind, commandText: readbackCmd, rawResponse: readback, result: 'ok',
        });
      }

      await channel.close();
      await this.audit.closeSession(sessionId);
      return { ok: true, usedTransport: transportKind, linesSent: sent, readback, lastAuditId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`Device action failed for device ${req.deviceId}: ${message}`);
      await this.audit.record({
        deviceId: req.deviceId, sessionId, actorKind: req.actorKind, actorId: req.actorId,
        transport: transportKind, commandText: sent.length < plan.length ? plan[sent.length] : '(session setup)',
        rawResponse: message, result: 'error',
      });
      await this.audit.closeSession(sessionId, undefined, message);
      try { await channel.close(); } catch { /* already broken */ }
      return { ok: false, usedTransport: transportKind, linesSent: sent, error: message };
    }
  }
}
