import { randomUUID } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import * as amqp from 'amqplib';
import { AuctionConfig } from '../config/auction.config.js';
@Injectable()
export class WalletHoldClient {
  constructor(private readonly config: AuctionConfig) {}
  async hold(userId: string, reference: string, amount: number): Promise<boolean> {
    return (await this.request('wallet.bid-hold.requested.v1', { userId, reference, amount })).accepted === true;
  }
  async release(userId: string, reference: string, amount: number): Promise<boolean> {
    return (await this.request('wallet.bid-release.requested.v1', { userId, reference, amount })).accepted === true;
  }
  /**
   * Saldo disponible en este momento. Solo orienta (HU-22: el limite de una puja automatica
   * no debe pasar del saldo); no reserva nada, asi que puede cambiar justo despues. La
   * garantia real es la reserva que se pide en cada puja.
   */
  async availableBalance(userId: string): Promise<number> {
    const answer = await this.request('wallet.balance.requested.v1', { userId });
    if (answer.accepted !== true || typeof answer.availableBalance !== 'string') {
      throw new ServiceUnavailableException('La billetera no informo el saldo disponible.');
    }
    return Number(answer.availableBalance);
  }
  private async request(routingKey: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const connection = await amqp.connect(this.config.rabbitmqUrl); try { const ch = await connection.createChannel(); const reply = await ch.assertQueue('', { exclusive: true }); const id = randomUUID();
      const response = new Promise<Record<string, unknown>>((resolve) => ch.consume(reply.queue, (m) => { if (m?.properties.correlationId === id) resolve(JSON.parse(m.content.toString()) as Record<string, unknown>); }, { noAck: true }));
      ch.publish('ecilost.events', routingKey, Buffer.from(JSON.stringify(body)), { correlationId: id, replyTo: reply.queue, persistent: true });
      return await Promise.race([response, new Promise<Record<string, unknown>>((_, reject) => setTimeout(() => reject(new ServiceUnavailableException('La billetera no respondio.')), 5000))]);
    } finally { await connection.close(); }
  }
}
