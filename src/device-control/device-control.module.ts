import { Module } from '@nestjs/common';
import { DeviceControlController } from './device-control.controller';
import { AdapterRegistryService } from './adapters/adapter-registry.service';
import { CapabilityRegistryService } from './capabilities/capability-registry.service';
import { CommandAuditService } from './audit/command-audit.service';
import { CredentialEncryptionService } from './crypto/credential-encryption.service';
import { DeviceConnectionService } from './connection/device-connection.service';
import { DeviceActionRunnerService } from './queue/device-action-runner.service';
import { DeviceWorkerRegistryService } from './queue/device-worker-registry.service';
import { ReachabilityWorkerService } from './queue/reachability-worker.service';
import { PendingChangesService } from './sync/pending-changes.service';
import { DeviceControlOrchestratorService } from './device-control-orchestrator.service';

// DbModule is @Global() (see db/db.module.ts) so DbService doesn't need to
// be imported here explicitly.
@Module({
  controllers: [DeviceControlController],
  providers: [
    AdapterRegistryService,
    CapabilityRegistryService,
    CommandAuditService,
    CredentialEncryptionService,
    DeviceConnectionService,
    DeviceActionRunnerService,
    DeviceWorkerRegistryService,
    ReachabilityWorkerService,
    PendingChangesService,
    DeviceControlOrchestratorService,
  ],
  exports: [AdapterRegistryService, DeviceConnectionService],
})
export class DeviceControlModule {}
