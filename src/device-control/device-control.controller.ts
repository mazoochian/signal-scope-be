import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { Permission } from '../auth/guards/permission.decorator';
import { AdapterRegistryService } from './adapters/adapter-registry.service';
import { DeviceActionDto, toDeviceAction } from './dto/device-action.dto';
import { RawCommandDto } from './dto/raw-command.dto';
import { SetConnectionTargetDto, SetCredentialDto, SetVendorProfileDto } from './dto/connection-target.dto';
import { DeviceConnectionService } from './connection/device-connection.service';
import { DeviceControlOrchestratorService } from './device-control-orchestrator.service';
import { PendingChangesService } from './sync/pending-changes.service';
import { CommandAuditService } from './audit/command-audit.service';
import { CapabilityRegistryService } from './capabilities/capability-registry.service';
import { sanitizeRawCliLine } from './sanitization/cli-command-sanitizer';
import { DeviceWorkerRegistryService } from './queue/device-worker-registry.service';

interface AuthedRequest {
  user?: { sub: string; role: string };
}

@Controller('device-control')
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
export class DeviceControlController {
  constructor(
    private readonly adapters: AdapterRegistryService,
    private readonly connections: DeviceConnectionService,
    private readonly orchestrator: DeviceControlOrchestratorService,
    private readonly pending: PendingChangesService,
    private readonly audit: CommandAuditService,
    private readonly capabilities: CapabilityRegistryService,
    private readonly workers: DeviceWorkerRegistryService,
  ) {}

  @Post(':deviceId/vendor-profile')
  @Permission('device-control', 'manage')
  async setVendorProfile(@Param('deviceId') deviceId: string, @Body() dto: SetVendorProfileDto) {
    const id = Number(deviceId);
    await this.connections.getDevice(id); // 404s if missing
    if (!this.adapters.list().includes(dto.vendorProfileId) && dto.vendorProfileId !== 'generic-snmp') {
      throw new BadRequestException(`Unknown vendor profile ${dto.vendorProfileId}. Known: ${this.adapters.list().join(', ')}`);
    }
    await this.connections.setVendorProfile(id, dto.vendorProfileId, dto.deviceClass);
    await this.capabilities.seedFromVendorDefaults(id, dto.vendorProfileId);
    return { ok: true };
  }

  @Post(':deviceId/connection-target')
  @Permission('device-control', 'manage')
  async setConnectionTarget(@Param('deviceId') deviceId: string, @Body() dto: SetConnectionTargetDto) {
    const id = Number(deviceId);
    await this.connections.getDevice(id);
    await this.connections.setConnectionTarget(id, dto);
    return { ok: true };
  }

  @Post(':deviceId/credentials')
  @Permission('device-control', 'manage')
  async setCredential(@Param('deviceId') deviceId: string, @Body() dto: SetCredentialDto) {
    const id = Number(deviceId);
    await this.connections.getDevice(id);
    await this.connections.storeCredential(id, dto.kind, dto.username ?? null, dto.secret);
    return { ok: true }; // never echoes the secret back
  }

  @Post(':deviceId/actions')
  @Permission('device-control', 'execute')
  async submitAction(@Param('deviceId') deviceId: string, @Body() dto: DeviceActionDto, @Req() req: AuthedRequest) {
    const id = Number(deviceId);
    const device = await this.connections.getDevice(id);
    const adapter = this.adapters.resolve(device.vendorProfileId);
    const action = toDeviceAction(dto, adapter);
    const requestedBy = req.user?.sub ?? 'unknown';
    return this.orchestrator.submit(id, action, requestedBy);
  }

  @Post(':deviceId/raw-command')
  @Permission('device-control-raw', 'execute')
  async submitRawCommand(@Param('deviceId') deviceId: string, @Body() dto: RawCommandDto, @Req() req: AuthedRequest) {
    const id = Number(deviceId);
    const sanitized = sanitizeRawCliLine(dto.line);
    if (!sanitized.ok) throw new BadRequestException(sanitized.reason);
    if (sanitized.isDestructive && req.user?.role !== 'admin' && req.user?.role !== 'superadmin') {
      throw new ForbiddenException('This command is on the destructive-command denylist and requires device-control-raw:manage (admin/superadmin)');
    }
    // Runs through the same per-device queue as structured actions (not a
    // separate ad-hoc dial) so a raw command and a GUI action against the
    // same device never race against each other's CLI session. Unlike
    // structured actions, this never falls back to pending_changes when
    // unreachable — see executeRawLine's doc comment for why.
    return this.workers.enqueueAndWait({
      deviceId: id,
      rawLine: sanitized.line,
      actorKind: 'human-cli',
      actorId: req.user?.sub ?? 'unknown',
    });
  }

  @Get(':deviceId/pending-changes')
  @Permission('device-control', 'read')
  async listPendingChanges(@Param('deviceId') deviceId: string) {
    return this.pending.listForDevice(Number(deviceId));
  }

  @Get(':deviceId/audit')
  @Permission('device-control', 'read')
  async getAudit(@Param('deviceId') deviceId: string) {
    return this.audit.recentForDevice(Number(deviceId));
  }
}
