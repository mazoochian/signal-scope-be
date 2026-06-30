import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { PermissionsGuard } from './auth/guards/permissions.guard';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DbModule } from './db/db.module';
import { SimulationModule } from './simulation/simulation.module';
import { HostMetricsModule } from './host-metrics/host-metrics.module';
import { OverviewModule } from './overview/overview.module';
import { AlertsModule } from './alerts/alerts.module';
import { DevicesModule } from './devices/devices.module';
import { InterfacesModule } from './interfaces/interfaces.module';
import { TopologyModule } from './topology/topology.module';
import { WirelessModule } from './wireless/wireless.module';
import { TelemetryModule } from './telemetry/telemetry.module';
import { InventoryModule } from './inventory/inventory.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { ServicesModule } from './services/services.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ConfigurationModule } from './configuration/configuration.module';
import { ReportsModule } from './reports/reports.module';
import { SlaModule } from './sla/sla.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { GroupsModule } from './groups/groups.module';
import { PermissionsModule } from './permissions/permissions.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DbModule,
    SimulationModule,
    HostMetricsModule,
    OverviewModule,
    AlertsModule,
    DevicesModule,
    InterfacesModule,
    TopologyModule,
    WirelessModule,
    TelemetryModule,
    InventoryModule,
    DiscoveryModule,
    ServicesModule,
    NotificationsModule,
    AuthModule,
    UsersModule,
    ConfigurationModule,
    ReportsModule,
    SlaModule,
    IntegrationsModule,
    GroupsModule,
    PermissionsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
