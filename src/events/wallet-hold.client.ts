import { randomUUID } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import * as amqp from 'amqplib';
import { AuctionConfig } from '../config/auction.config.js';
@Injectable()
export class WalletHoldClient {
  constructor(private readonly config: AuctionConfig) {}
  async hold(userId: string, reference: string, amount: number): Promise<boolean> {
    const connection = await amqp.connect(this.config.rabbitmqUrl); try { const ch = await connection.createChannel(); const reply = await ch.assertQueue('', { exclusive: true }); const id = randomUUID();
      const response = new Promise<boolean>((resolve) => ch.consume(reply.queue, (m) => { if (m?.properties.correlationId === id) resolve(JSON.parse(m.content.toString()).accepted === true); }, { noAck: true }));
      ch.publish('ecilost.events', 'wallet.bid-hold.requested.v1', Buffer.from(JSON.stringify({ userId, reference, amount })), { correlationId: id, replyTo: reply.queue, persistent: true });
      return await Promise.race([response, new Promise<boolean>((_, reject) => setTimeout(() => reject(new ServiceUnavailableException('Wallet did not respond')), 5000))]);
    } finally { await connection.close(); }
  }
}
