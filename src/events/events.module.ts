import { Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import amqp from 'amqplib';
import type { ConfirmChannel, Message } from 'amqplib';
import { AuctionConfig } from '../config/auction.config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CatalogReservationClient } from './catalog-reservation.client.js';
import { WalletHoldClient } from './wallet-hold.client.js';

const OUTBOX_POLL_INTERVAL_MS = 1_000;
const OUTBOX_BATCH_SIZE = 50;

@Injectable()
class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name);
  private timer?: NodeJS.Timeout;
  private publishing = false;

  constructor(private readonly prisma: PrismaService, private readonly config: AuctionConfig) {}

  onModuleInit() {
    void this.publishPendingEvents();
    this.timer = setInterval(() => void this.publishPendingEvents(), OUTBOX_POLL_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async publishPendingEvents() {
    if (this.publishing) return;
    this.publishing = true;

    let connection: Awaited<ReturnType<typeof amqp.connect>> | undefined;
    let channel: ConfirmChannel | undefined;
    try {
      const events = await this.prisma.outboxEvent.findMany({
        where: { publishedAt: null },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        take: OUTBOX_BATCH_SIZE,
      });
      if (events.length === 0) return;

      connection = await amqp.connect(this.config.rabbitmqUrl);
      channel = await connection.createConfirmChannel();
      await channel.assertExchange('ecilost.events', 'topic', { durable: true });

      const unroutedEventIds = new Set<string>();
      channel.on('return', (message: Message) => {
        const messageId = message.properties.messageId;
        if (typeof messageId === 'string') unroutedEventIds.add(messageId);
      });

      for (const event of events) {
        try {
          channel.publish(
            'ecilost.events',
            event.routingKey,
            Buffer.from(JSON.stringify(event.payload) ?? 'null'),
            {
              persistent: true,
              mandatory: true,
              messageId: event.id,
              type: event.eventType,
              timestamp: event.occurredAt.getTime(),
            },
          );
          await channel.waitForConfirms();
          if (unroutedEventIds.delete(event.id)) {
            throw new Error('RabbitMQ no tiene una cola enlazada para esta clave de enrutamiento.');
          }

          await this.prisma.outboxEvent.update({
            where: { id: event.id },
            data: { publishedAt: new Date(), attempts: { increment: 1 }, lastError: null },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.prisma.outboxEvent.update({
            where: { id: event.id },
            data: { attempts: { increment: 1 }, lastError: message.slice(0, 4_000) },
          }).catch(() => undefined);
          this.logger.warn('No se pudo publicar el evento ' + event.id + '; se reintentará.');
          break;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('No fue posible procesar el outbox: ' + message);
    } finally {
      if (channel) await channel.close().catch(() => undefined);
      if (connection) await connection.close().catch(() => undefined);
      this.publishing = false;
    }
  }
}

@Module({
  providers: [CatalogReservationClient, WalletHoldClient, OutboxPublisher],
  exports: [CatalogReservationClient, WalletHoldClient],
})
export class EventsModule {}
