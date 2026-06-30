import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { SimulationService } from './simulation/simulation.service';
import { EmailNotificationsService } from './integrations/email-notifications.service';

@Injectable()
export class AppService implements OnApplicationBootstrap {
  constructor(
    private readonly simulation: SimulationService,
    private readonly emailNotifications: EmailNotificationsService,
  ) {}

  onApplicationBootstrap() {
    this.simulation.setAlertNotifier((alert) => {
      this.emailNotifications.notifyAlert(alert).catch(() => {});
    });
  }

  getHello(): string {
    return 'Hello World!';
  }
}
