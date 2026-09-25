import { randomUUID } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import * as amqp from 'amqplib';
import { AuctionConfig } from '../config/auction.config.js';
@Injectable()
export class WalletHoldClient {
  constructor(private readonly config: AuctionConfig) {}
  async hold(userId: string, reference: string, amount: number): Promise<boolean> {
    return this.request('wallet.bid-hold.requested.v1', { userId, reference, amount });
  }
  async release(userId: string, reference: string, amount: number): Promise<boolean> {
    return this.request('wallet.bid-release.requested.v1', { userId, reference, amount });
  }
  private async request(routingKey: string, body: { userId: string; reference: string; amount: number }): Promise<boolean> {
    const connection = await amqp.connect(this.config.rabbitmqUrl); try { const ch = await connection.createChannel(); const reply = await ch.assertQueue('', { exclusive: true }); const id = randomUUID();
      const response = new Promise<boolean>((resolve) => ch.consume(reply.queue, (m) => { if (m?.properties.correlationId === id) resolve(JSON.parse(m.content.toString()).accepted === true); }, { noAck: true }));
      ch.publish('ecilost.events', routingKey, Buffer.from(JSON.stringify(body)), { correlationId: id, replyTo: reply.queue, persistent: true });
      return await Promise.race([response, new Promise<boolean>((_, reject) => setTimeout(() => reject(new ServiceUnavailableException('La billetera no respondio.')), 5000))]);
    } finally { await connection.close(); }
  }
}
