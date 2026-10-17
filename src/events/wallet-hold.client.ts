import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import * as amqp from 'amqplib';
import { AuctionConfig } from '../config/auction.config.js';

/** Cuanto se espera la respuesta de wallet. */
const REPLY_TIMEOUT_MS = 5_000;

/**
 * Motivos con que wallet rechaza una reserva sin que falten fondos: estaba ocupada (`RETRY`)
 * o fallo por otra causa (`ERROR`). `INSUFFICIENT_FUNDS` y `WALLET_NOT_FOUND` si significan
 * que no hay con que pujar.
 */
const UNAVAILABLE_REASONS = new Set(['RETRY', 'ERROR']);

type Reply = Record<string, unknown>;
type Pending = { resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type Link = { connection: amqp.ChannelModel; channel: amqp.Channel; replyQueue: string };

/**
 * Solicitudes a wallet por RabbitMQ con respuesta (`replyTo` + `correlationId`).
 *
 * - Una sola conexion y un solo canal para todo el proceso, con una cola de respuestas
 *   compartida. Antes cada llamada abria y cerraba su propia conexion: entre dos y cuatro
 *   por puja, que con varias pujas a la vez agotaban el limite de conexiones de CloudAMQP.
 *   Si la conexion se cae, la siguiente llamada abre otra.
 * - Cada solicitud vence (`expiration`) a la vez que deja de esperarse su respuesta. Asi
 *   wallet nunca procesa una reserva que auction ya dio por fallida: antes, una reserva
 *   atrasada podia llegar despues de liquidar la ronda y dejar ECICoin retenidos para siempre.
 */
@Injectable()
export class WalletHoldClient implements OnModuleDestroy {
  private readonly logger = new Logger(WalletHoldClient.name);
  private link?: Promise<Link>;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly config: AuctionConfig) {}

  /**
   * Reserva `amount`. `false` solo cuando no hay fondos (o billetera) para cubrirla.
   *
   * Si wallet rechaza por estar ocupada o por un fallo propio, se lanza 503 en vez de
   * devolver `false`: antes se mostraba como "saldo insuficiente" a quien tenia saldo de sobra,
   * y la puja automatica se detenia para siempre. Quien llama ya trata una excepcion como
   * "no se sabe si reservo": deshace por si acaso y propaga. Una respuesta sin `reason`
   * (wallet anterior) conserva el comportamiento de siempre.
   */
  async hold(userId: string, reference: string, amount: number): Promise<boolean> {
    const answer = await this.request('wallet.bid-hold.requested.v1', { userId, reference, amount });
    if (answer.accepted === true) return true;
    if (typeof answer.reason === 'string' && UNAVAILABLE_REASONS.has(answer.reason)) {
      this.logger.warn(`wallet no reservo ${reference} (${answer.reason}); se responde 503`);
      throw new ServiceUnavailableException('La billetera esta ocupada, intenta de nuevo.');
    }
    return false;
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

  async onModuleDestroy() {
    const link = await this.link?.catch(() => undefined);
    this.link = undefined;
    await link?.connection.close().catch(() => undefined);
  }

  private async request(routingKey: string, body: Reply): Promise<Reply> {
    let link: Link;
    try {
      link = await this.connect();
    } catch {
      throw new ServiceUnavailableException('La billetera no respondio.');
    }
    const correlationId = randomUUID();
    const reply = new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        reject(new ServiceUnavailableException('La billetera no respondio.'));
      }, REPLY_TIMEOUT_MS);
      this.pending.set(correlationId, { resolve, reject, timer });
    });
    link.channel.publish('ecilost.events', routingKey, Buffer.from(JSON.stringify(body)), {
      correlationId,
      replyTo: link.replyQueue,
      persistent: true,
      expiration: String(REPLY_TIMEOUT_MS),
    });
    return reply;
  }

  private connect(): Promise<Link> {
    this.link ??= this.open().catch((error: unknown) => {
      this.link = undefined;
      throw error;
    });
    return this.link;
  }

  private async open(): Promise<Link> {
    const connection = await amqp.connect(this.config.rabbitmqUrl);
    connection.on('error', (error: unknown) => this.logger.warn(`Error en la conexion con wallet: ${String(error)}`));
    connection.on('close', () => this.drop());
    try {
      const channel = await connection.createChannel();
      const { queue: replyQueue } = await channel.assertQueue('', { exclusive: true });
      await channel.consume(replyQueue, (message) => {
        const id = message?.properties.correlationId as string | undefined;
        const waiting = id ? this.pending.get(id) : undefined;
        if (!message || !id || !waiting) return;
        this.pending.delete(id);
        clearTimeout(waiting.timer);
        waiting.resolve(JSON.parse(message.content.toString()) as Reply);
      }, { noAck: true });
      return { connection, channel, replyQueue };
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw error;
    }
  }

  /** La conexion se cerro: lo que esperaba respuesta ya no la recibira por esta cola. */
  private drop() {
    this.link = undefined;
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new ServiceUnavailableException('La billetera no respondio.'));
      this.pending.delete(id);
    }
  }
}
