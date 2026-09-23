import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RoomsService } from './rooms.service.js';

const ACTIVATION_INTERVAL_MS = 10_000;

@Injectable()
export class RoomActivationScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RoomActivationScheduler.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly rooms: RoomsService) {}

  onModuleInit() {
    this.runActivationCycle();
    this.timer = setInterval(() => this.runActivationCycle(), ACTIVATION_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private runActivationCycle() {
    void this.rooms.activateDueRooms().catch((error: unknown) => {
      this.logger.error('No fue posible activar las salas vencidas.', error instanceof Error ? error.stack : undefined);
    });
  }
}
