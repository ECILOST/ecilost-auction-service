import { randomUUID } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import amqp from 'amqplib';
import { AuctionConfig } from '../config/auction.config.js';

export type CatalogEntry = { kind: 'ITEM' | 'LOT'; catalogId: string; roundId: string };
@Injectable()
export class CatalogReservationClient {
  constructor(private readonly config: AuctionConfig) {}
  async reserve(entries: CatalogEntry[]): Promise<boolean> {
    const connection = await amqp.connect(this.config.rabbitmqUrl).catch(() => { throw new ServiceUnavailableException('Catalog no esta disponible para reservar la ronda.'); });
    try {
      const channel = await connection.createChannel(); const reply = await channel.assertQueue('', { exclusive: true }); const correlationId = randomUUID();
      await channel.assertExchange('ecilost.events', 'topic', { durable: true });
      const answer = new Promise<boolean>((resolve) => channel.consume(reply.queue, (message) => { if (message?.properties.correlationId === correlationId) resolve(JSON.parse(message.content.toString()).accepted === true); }, { noAck: true }));
      channel.publish('ecilost.events', 'catalog.round-reservation.requested.v1', Buffer.from(JSON.stringify({ entries })), { correlationId, replyTo: reply.queue, persistent: true });
      const timeout = new Promise<boolean>((_, reject) => setTimeout(() => reject(new ServiceUnavailableException('Catalog no respondio a la reserva.')), 5000));
      return await Promise.race([answer, timeout]);
    } finally { await connection.close(); }
  }

  /** Respaldo de la compensacion cuando el outbox no esta disponible. Sin respuesta: es una orden. */
  async cancel(payload: { eventId: string; eventType: string }): Promise<void> {
    const connection = await amqp.connect(this.config.rabbitmqUrl);
    try {
      const channel = await connection.createConfirmChannel();
      await channel.assertExchange('ecilost.events', 'topic', { durable: true });
      channel.publish('ecilost.events', payload.eventType, Buffer.from(JSON.stringify(payload)), { persistent: true, messageId: payload.eventId });
      await channel.waitForConfirms();
    } finally { await connection.close(); }
  }
}
