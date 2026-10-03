import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AutoBidsService } from '../bids/auto-bids.service.js';
import { RoomsService } from './rooms.service.js';

const ACTIVATION_INTERVAL_MS = 500;

@Injectable()
export class RoomActivationScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RoomActivationScheduler.name);
  private timer?: NodeJS.Timeout;
  private cycleRunning = false;

  constructor(private readonly rooms: RoomsService, private readonly autoBids: AutoBidsService) {}

  onModuleInit() {
    void this.runActivationCycle();
    this.timer = setInterval(() => void this.runActivationCycle(), ACTIVATION_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async runActivationCycle() {
    // El barrido de pujas automaticas habla con wallet y puede tardar: corre aparte, para
    // que una billetera lenta nunca retrase el cierre de una ronda.
    void this.autoBids.resolvePending().catch((error: unknown) => {
      this.logger.warn(`No fue posible barrer las pujas automaticas: ${String(error)}`);
    });
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
