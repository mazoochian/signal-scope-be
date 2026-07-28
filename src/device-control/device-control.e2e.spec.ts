// Integration test against REAL transports — a real SSH connection to a
// scripted CLI stub server, a real SNMP GET/SET against a net-snmp-backed
// agent simulator, and real Postgres/Redis/BullMQ — not mocked. Requires a
// live Postgres (with migrations 017-022 applied) and a live Redis, same
// precondition as src/test/permissions.spec.ts already has for Postgres
// (see AUDIT-REPORT.md L4: this repo's test suite is already non-hermetic
// for that file; this spec follows the same established pattern rather
// than introducing a new one).
//
// See device-control/README.md and
// device-control/testing/{cli-stub-server,snmp-agent-simulator}.ts for what
// the simulators do and why they exist instead of a pulled Docker image
// (no registry egress in this environment).
import { ChildProcess, spawn } from 'child_process';
import { Socket } from 'net';
import { NestFactory } from '@nestjs/core';
import { INestApplicationContext } from '@nestjs/common';
import * as path from 'path';
import { AppModule } from '../app.module';
import { DbService } from '../db/db.service';
import { DeviceConnectionService } from './connection/device-connection.service';
import { CapabilityRegistryService } from './capabilities/capability-registry.service';
import { DeviceControlOrchestratorService } from './device-control-orchestrator.service';
import { CommandAuditService } from './audit/command-audit.service';
import { PendingChangesService } from './sync/pending-changes.service';
import { DeviceWorkerRegistryService } from './queue/device-worker-registry.service';
import { sanitizeRawCliLine } from './sanitization/cli-command-sanitizer';
import { snmpProbeReachable } from './transport/snmp-transport';
import { closeRedisConnection } from './queue/redis-connection';

jest.setTimeout(30_000);

const SSH_PORT = 2211;
const TELNET_PORT = 2311;
const SNMP_PORT = 1171;

// One CLI stub server per vendor in this phase, each on its own port pair,
// so the multi-vendor describe block below can exercise every adapter's
// real SSH round trip independently.
const VENDOR_STUBS: Record<string, { sshPort: number; telnetPort: number; interfaceName: string }> = {
  'juniper-junos': { sshPort: 2212, telnetPort: 2312, interfaceName: 'ge-0/0/1' },
  'arista-eos': { sshPort: 2213, telnetPort: 2313, interfaceName: 'Ethernet1' },
  'mikrotik-routeros': { sshPort: 2214, telnetPort: 2314, interfaceName: 'ether1' },
};

let cliStubProc: ChildProcess;
let vendorStubProcs: ChildProcess[] = [];
let snmpSimProc: ChildProcess;
let app: INestApplicationContext;
let db: DbService;
let connections: DeviceConnectionService;
let capabilities: CapabilityRegistryService;
let orchestrator: DeviceControlOrchestratorService;
let audit: CommandAuditService;
let pending: PendingChangesService;
let workers: DeviceWorkerRegistryService;

/** SNMP is UDP — a TCP connect probe (waitForPort below) never succeeds against it even once the agent is bound, so readiness here means "responds to a real SNMP GET." */
async function waitForSnmpReady(port: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await snmpProbeReachable({ host: '127.0.0.1', port, community: 'public' })) return;
    if (Date.now() > deadline) throw new Error(`SNMP simulator on port ${port} never became ready`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function waitForPort(port: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = new Socket();
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`Port ${port} never opened`));
        else setTimeout(attempt, 200);
      });
      socket.connect(port, '127.0.0.1');
    };
    attempt();
  });
}

async function upsertDevice(name: string, connectionKind: string, status: string, vendorProfileId = 'cisco-ios'): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO devices (name, ip, vendor, model, role, status, connection_kind)
     VALUES ($1, '10.254.0.1', 'Cisco', 'IOS-XE Switch', 'access-switch', $2, $3)
     ON CONFLICT (name) DO UPDATE SET status = $2, connection_kind = $3
     RETURNING id`,
    [name, status, connectionKind],
  );
  await connections.setVendorProfile(rows[0].id, vendorProfileId, 'switch');
  await capabilities.seedFromVendorDefaults(rows[0].id, vendorProfileId);
  return rows[0].id;
}

beforeAll(async () => {
  const tsNode = path.resolve(__dirname, '../../node_modules/.bin/ts-node');
  const stubServerPath = path.resolve(__dirname, 'testing/cli-stub-server.ts');

  cliStubProc = spawn(tsNode, [stubServerPath, 'cisco-ios', String(SSH_PORT), String(TELNET_PORT)], { stdio: 'pipe' });
  snmpSimProc = spawn(tsNode, [path.resolve(__dirname, 'testing/snmp-agent-simulator.ts'), String(SNMP_PORT), 'public'], { stdio: 'pipe' });
  cliStubProc.stdout?.on('data', (d) => process.stdout.write(`[cli-stub] ${d}`));
  cliStubProc.stderr?.on('data', (d) => process.stdout.write(`[cli-stub:err] ${d}`));
  snmpSimProc.stdout?.on('data', (d) => process.stdout.write(`[snmp-sim] ${d}`));
  snmpSimProc.stderr?.on('data', (d) => process.stdout.write(`[snmp-sim:err] ${d}`));

  vendorStubProcs = Object.entries(VENDOR_STUBS).map(([vendor, { sshPort, telnetPort }]) => {
    const proc = spawn(tsNode, [stubServerPath, vendor, String(sshPort), String(telnetPort)], { stdio: 'pipe' });
    proc.stdout?.on('data', (d) => process.stdout.write(`[cli-stub:${vendor}] ${d}`));
    proc.stderr?.on('data', (d) => process.stdout.write(`[cli-stub:${vendor}:err] ${d}`));
    return proc;
  });

  await Promise.all([
    waitForPort(SSH_PORT),
    waitForPort(TELNET_PORT),
    waitForSnmpReady(SNMP_PORT),
    ...Object.values(VENDOR_STUBS).map(({ sshPort }) => waitForPort(sshPort)),
  ]);

  app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  db = app.get(DbService);
  connections = app.get(DeviceConnectionService);
  capabilities = app.get(CapabilityRegistryService);
  orchestrator = app.get(DeviceControlOrchestratorService);
  audit = app.get(CommandAuditService);
  pending = app.get(PendingChangesService);
  workers = app.get(DeviceWorkerRegistryService);
});

afterAll(async () => {
  await db.query(`DELETE FROM devices WHERE name LIKE 'jest-device-control-%'`);
  await app?.close();
  await closeRedisConnection();
  cliStubProc?.kill();
  snmpSimProc?.kill();
  vendorStubProcs.forEach((p) => p.kill());
});

describe('device-control CLI path (real SSH transport)', () => {
  it('executes port.setDescription and captures the literal command + readback in the audit log', async () => {
    const deviceId = await upsertDevice('jest-device-control-cli', 'docker-simulator', 'up');
    await connections.setConnectionTarget(deviceId, { transport: 'ssh', host: '127.0.0.1', port: SSH_PORT, kind: 'docker-simulator' });
    await connections.storeCredential(deviceId, 'ssh_password', 'admin', 'admin');

    const outcome = await orchestrator.submit(
      deviceId,
      { kind: 'port.setDescription', interfaceName: 'GigabitEthernet0/1', description: 'jest-uplink' },
      'jest',
    );

    expect(outcome.mode).toBe('executed');
    if (outcome.mode !== 'executed') throw new Error('unreachable');
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.linesSent).toEqual([
      'configure terminal',
      'interface GigabitEthernet0/1',
      'description jest-uplink',
      'end',
    ]);
    expect(outcome.result.readback).toContain('jest-uplink');

    const rows = await audit.recentForDevice(deviceId);
    expect(rows.map((r: any) => r.command_text)).toEqual(
      expect.arrayContaining(['configure terminal', 'interface GigabitEthernet0/1', 'description jest-uplink', 'end']),
    );
  });
});

describe('device-control CLI path — Juniper/Arista/MikroTik (real SSH transport, per-vendor stub)', () => {
  it('Juniper: candidate-config plan (configure -> set -> readback), never auto-committing', async () => {
    const { sshPort, interfaceName } = VENDOR_STUBS['juniper-junos'];
    const deviceId = await upsertDevice('jest-device-control-juniper', 'docker-simulator', 'up', 'juniper-junos');
    await connections.setConnectionTarget(deviceId, { transport: 'ssh', host: '127.0.0.1', port: sshPort, kind: 'docker-simulator' });
    await connections.storeCredential(deviceId, 'ssh_password', 'admin', 'admin');

    const outcome = await orchestrator.submit(deviceId, { kind: 'port.setDescription', interfaceName, description: 'jest-uplink' }, 'jest');
    expect(outcome.mode).toBe('executed');
    if (outcome.mode !== 'executed') throw new Error('unreachable');
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.linesSent).toEqual(['configure', `set interfaces ${interfaceName} description "jest-uplink"`]);
    expect(outcome.result.readback).toContain('jest-uplink');
  });

  it('Arista: IOS-parity plan against Ethernet1 naming', async () => {
    const { sshPort, interfaceName } = VENDOR_STUBS['arista-eos'];
    const deviceId = await upsertDevice('jest-device-control-arista', 'docker-simulator', 'up', 'arista-eos');
    await connections.setConnectionTarget(deviceId, { transport: 'ssh', host: '127.0.0.1', port: sshPort, kind: 'docker-simulator' });
    await connections.storeCredential(deviceId, 'ssh_password', 'admin', 'admin');

    const outcome = await orchestrator.submit(deviceId, { kind: 'port.setDescription', interfaceName, description: 'jest-uplink' }, 'jest');
    expect(outcome.mode).toBe('executed');
    if (outcome.mode !== 'executed') throw new Error('unreachable');
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.linesSent).toEqual(['configure terminal', `interface ${interfaceName}`, 'description jest-uplink', 'end']);
    expect(outcome.result.readback).toContain('jest-uplink');
  });

  it('MikroTik: single fully-qualified menu-path line, no mode-entry sequence', async () => {
    const { sshPort, interfaceName } = VENDOR_STUBS['mikrotik-routeros'];
    const deviceId = await upsertDevice('jest-device-control-mikrotik', 'docker-simulator', 'up', 'mikrotik-routeros');
    await connections.setConnectionTarget(deviceId, { transport: 'ssh', host: '127.0.0.1', port: sshPort, kind: 'docker-simulator' });
    await connections.storeCredential(deviceId, 'ssh_password', 'admin', 'admin');

    const outcome = await orchestrator.submit(deviceId, { kind: 'port.setDescription', interfaceName, description: 'jest-uplink' }, 'jest');
    expect(outcome.mode).toBe('executed');
    if (outcome.mode !== 'executed') throw new Error('unreachable');
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.linesSent).toEqual([`/interface set ${interfaceName} comment="jest-uplink"`]);
    expect(outcome.result.readback).toContain('jest-uplink');
  });
});

describe('device-control SNMP path (real net-snmp transport)', () => {
  it('SETs CISCO-VLAN-MEMBERSHIP-MIB::vmVlan, a Cisco-documented write path', async () => {
    const deviceId = await upsertDevice('jest-device-control-snmp', 'docker-simulator', 'up');
    await connections.setConnectionTarget(deviceId, { transport: 'snmp', host: '127.0.0.1', port: SNMP_PORT, kind: 'docker-simulator' });
    await connections.storeCredential(deviceId, 'snmp_v2c_community', null, 'public');

    const outcome = await orchestrator.submit(deviceId, { kind: 'vlan.setPvid', interfaceName: 'GigabitEthernet0/1', vlanId: 77 }, 'jest');

    expect(outcome.mode).toBe('executed');
    if (outcome.mode !== 'executed') throw new Error('unreachable');
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.linesSent[0]).toContain('# SNMP SET CISCO-VLAN-MEMBERSHIP-MIB::vmVlan');
  });

  it('refuses to SET an action with no documented Cisco SNMP write path (vlan.setTrunkAllowed)', async () => {
    const deviceId = await upsertDevice('jest-device-control-snmp-refuse', 'docker-simulator', 'up');
    await connections.setConnectionTarget(deviceId, { transport: 'snmp', host: '127.0.0.1', port: SNMP_PORT, kind: 'docker-simulator' });
    await connections.storeCredential(deviceId, 'snmp_v2c_community', null, 'public');

    const outcome = await orchestrator.submit(
      deviceId,
      { kind: 'vlan.setTrunkAllowed', interfaceName: 'GigabitEthernet0/1', vlanIds: [10, 20] },
      'jest',
    );

    // No CLI target configured on this device either, so the "no SNMP
    // path" application-level error correctly falls through to executed:false
    // rather than being silently retried/queued (queuing wouldn't help —
    // no vendor path exists for this action at all on this transport).
    expect(outcome.mode).toBe('executed');
    if (outcome.mode !== 'executed') throw new Error('unreachable');
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error).toMatch(/no documented snmp write path/i);
  });
});

describe('device-control offline queue + drain', () => {
  it('queues an action against a planned/ghost device instead of dialing, then drains it once a target is attached', async () => {
    const deviceId = await upsertDevice('jest-device-control-ghost', 'planned', 'unknown');

    const queued = await orchestrator.submit(deviceId, { kind: 'port.setAdminStatus', interfaceName: 'GigabitEthernet0/1', adminStatus: 'down' }, 'jest');
    expect(queued.mode).toBe('queued');

    const beforeDrain = await pending.listForDevice(deviceId);
    expect(beforeDrain).toHaveLength(1);
    expect(beforeDrain[0].status).toBe('queued');

    // Simulate the device coming online (what ReachabilityWorkerService
    // does automatically on a down->up transition).
    await connections.setConnectionTarget(deviceId, { transport: 'ssh', host: '127.0.0.1', port: SSH_PORT, kind: 'docker-simulator' });
    await connections.storeCredential(deviceId, 'ssh_password', 'admin', 'admin');
    await db.query(`UPDATE devices SET status = 'up' WHERE id = $1`, [deviceId]);
    await pending.drainForDevice(deviceId);

    const afterDrain = await pending.listForDevice(deviceId);
    expect(afterDrain[0].status).toBe('applied');
    expect(afterDrain[0].applied_audit_id).not.toBeNull();

    const auditRows = await audit.recentForDevice(deviceId);
    expect(auditRows.some((r: any) => r.actor_kind === 'agent' && r.command_text === 'shutdown')).toBe(true);
  });

  it('lands a change in conflict, not applied, when expected_prior_state no longer matches the device', async () => {
    const deviceId = await upsertDevice('jest-device-control-conflict', 'planned', 'unknown');

    // The cisco-ios stub starts every fresh session with adminUp: true (see
    // testing/scripts/cisco-ios.script.ts's initialVars) — queue this change
    // against a deliberately wrong prior state (adminUp: false) so the
    // pre-apply probe (which reads the real, still-true state) disagrees
    // with it.
    const pendingChangeId = await pending.queueChange({
      deviceId,
      action: { kind: 'port.setAdminStatus', interfaceName: 'GigabitEthernet0/1', adminStatus: 'down' },
      requestedBy: 'jest',
      expectedPriorState: { adminUp: false, operUp: false },
    });

    await connections.setConnectionTarget(deviceId, { transport: 'ssh', host: '127.0.0.1', port: SSH_PORT, kind: 'docker-simulator' });
    await connections.storeCredential(deviceId, 'ssh_password', 'admin', 'admin');
    await db.query(`UPDATE devices SET status = 'up' WHERE id = $1`, [deviceId]);
    await pending.drainForDevice(deviceId);

    const afterDrain = await pending.listForDevice(deviceId);
    const row = afterDrain.find((r: any) => r.id === pendingChangeId) as any;
    expect(row.status).toBe('conflict');
    expect(row.last_error).toMatch(/expected prior state/i);

    // The action itself must never have been sent — a conflict blocks the
    // apply, it doesn't just note a discrepancy after the fact.
    const auditRows = await audit.recentForDevice(deviceId);
    expect(auditRows.some((r: any) => r.command_text === 'shutdown')).toBe(false);
  });

  it('applies normally when expected_prior_state matches the device', async () => {
    const deviceId = await upsertDevice('jest-device-control-conflict-match', 'planned', 'unknown');

    const pendingChangeId = await pending.queueChange({
      deviceId,
      action: { kind: 'port.setAdminStatus', interfaceName: 'GigabitEthernet0/1', adminStatus: 'down' },
      requestedBy: 'jest',
      expectedPriorState: { adminUp: true, operUp: true },
    });

    await connections.setConnectionTarget(deviceId, { transport: 'ssh', host: '127.0.0.1', port: SSH_PORT, kind: 'docker-simulator' });
    await connections.storeCredential(deviceId, 'ssh_password', 'admin', 'admin');
    await db.query(`UPDATE devices SET status = 'up' WHERE id = $1`, [deviceId]);
    await pending.drainForDevice(deviceId);

    const afterDrain = await pending.listForDevice(deviceId);
    const row = afterDrain.find((r: any) => r.id === pendingChangeId) as any;
    expect(row.status).toBe('applied');

    const auditRows = await audit.recentForDevice(deviceId);
    expect(auditRows.some((r: any) => r.command_text === 'shutdown')).toBe(true);
  });
});

describe('device-control raw CLI passthrough', () => {
  it('sanitizer rejects shell metacharacters and flags destructive commands', () => {
    expect(sanitizeRawCliLine('show version').ok).toBe(true);
    expect(sanitizeRawCliLine('show version; rm -rf /').ok).toBe(false);
    expect(sanitizeRawCliLine('reload').isDestructive).toBe(true);
    expect(sanitizeRawCliLine('a'.repeat(600)).ok).toBe(false);
  });

  it('forwards a sanitized raw line to the real device over SSH and returns its output', async () => {
    const deviceId = await upsertDevice('jest-device-control-raw', 'docker-simulator', 'up');
    await connections.setConnectionTarget(deviceId, { transport: 'ssh', host: '127.0.0.1', port: SSH_PORT, kind: 'docker-simulator' });
    await connections.storeCredential(deviceId, 'ssh_password', 'admin', 'admin');

    const result = await workers.enqueueAndWait({ deviceId, rawLine: 'show vlan brief', actorKind: 'human-cli', actorId: 'jest' });
    expect(result.ok).toBe(true);
    expect(result.readback).toContain('VLAN');
  });
});
