import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RoomsService } from './rooms.service.js';

const ACTIVATION_INTERVAL_MS = 500;

@Injectable()
export class RoomActivationScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RoomActivationScheduler.name);
  private timer?: NodeJS.Timeout;
  private cycleRunning = false;

  constructor(private readonly rooms: RoomsService) {}

  onModuleInit() {
    void this.runActivationCycle();
    this.timer = setInterval(() => void this.runActivationCycle(), ACTIVATION_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async runActivationCycle() {
    if (this.cycleRunning) return;
    this.cycleRunning = true;
    try {
      await this.rooms.activateDueRooms();
    } catch (error: unknown) {
      this.logger.error('No fue posible actualizar el ciclo de las salas.', error instanceof Error ? error.stack : undefined);
    } finally {
      this.cycleRunning = false;
    }
  }
}
