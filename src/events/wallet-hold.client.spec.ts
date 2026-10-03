import { EventEmitter } from 'node:events';
import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const connect = vi.hoisted(() => vi.fn());
vi.mock('amqplib', () => ({ connect }));

import { WalletHoldClient } from './wallet-hold.client.js';

type Publish = { routingKey: string; body: Record<string, unknown>; options: { correlationId: string; replyTo: string; expiration: string } };

/** Un RabbitMQ de mentira: guarda lo publicado y deja contestar por la cola de respuestas. */
function fakeBroker() {
  const published: Publish[] = [];
  let onReply: ((message: unknown) => void) | undefined;
  const connection = Object.assign(new EventEmitter(), {
    createChannel: vi.fn(async () => ({
      assertQueue: vi.fn(async () => ({ queue: 'amq.gen-replies' })),
      consume: vi.fn(async (_queue: string, handler: (message: unknown) => void) => { onReply = handler; }),
      publish: vi.fn((_exchange: string, routingKey: string, content: Buffer, options: Publish['options']) => {
        published.push({ routingKey, body: JSON.parse(content.toString()) as Record<string, unknown>, options });
        return true;
      }),
    })),
    close: vi.fn(async () => undefined),
  });
  const answer = (index: number, reply: Record<string, unknown>) =>
    onReply?.({ properties: { correlationId: published[index].options.correlationId }, content: Buffer.from(JSON.stringify(reply)) });
  return { connection, published, answer };
}

describe('WalletHoldClient', () => {
  beforeEach(() => connect.mockReset());
  afterEach(() => vi.useRealTimers());

  it('reutiliza una sola conexion para todas las solicitudes', async () => {
    const broker = fakeBroker();
    connect.mockResolvedValue(broker.connection);
    const client = new WalletHoldClient({ rabbitmqUrl: 'amqp://test' } as never);

    const hold = client.hold('bob', 'bid:round:bob', 1100);
    await vi.waitFor(() => expect(broker.published).toHaveLength(1));
    const release = client.release('alice', 'bid:round:alice', 1000);
    await vi.waitFor(() => expect(broker.published).toHaveLength(2));
    // Las respuestas llegan en otro orden: cada una va a quien la pidio por su correlationId.
    broker.answer(1, { accepted: true });
    broker.answer(0, { accepted: false });

    await expect(hold).resolves.toBe(false);
    await expect(release).resolves.toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(broker.published.map((p) => p.routingKey)).toEqual(['wallet.bid-hold.requested.v1', 'wallet.bid-release.requested.v1']);
  });

  it('la solicitud vence cuando se deja de esperar: wallet no procesa una reserva ya dada por fallida', async () => {
    vi.useFakeTimers();
    const broker = fakeBroker();
    connect.mockResolvedValue(broker.connection);
    const client = new WalletHoldClient({ rabbitmqUrl: 'amqp://test' } as never);

    const hold = client.hold('bob', 'bid:round:bob', 1100);
    const failure = expect(hold).rejects.toBeInstanceOf(ServiceUnavailableException);
    await vi.waitFor(() => expect(broker.published).toHaveLength(1));
    expect(broker.published[0].options.expiration).toBe('5000');

    await vi.advanceTimersByTimeAsync(5_000);
    await failure;
  });

  it('si la conexion se cae, falla lo pendiente y la siguiente solicitud abre otra', async () => {
    const first = fakeBroker();
    const second = fakeBroker();
    connect.mockResolvedValueOnce(first.connection).mockResolvedValueOnce(second.connection);
    const client = new WalletHoldClient({ rabbitmqUrl: 'amqp://test' } as never);

    const pending = client.hold('bob', 'bid:round:bob', 1100);
    await vi.waitFor(() => expect(first.published).toHaveLength(1));
    first.connection.emit('close');
    await expect(pending).rejects.toBeInstanceOf(ServiceUnavailableException);

    const next = client.release('bob', 'bid:round:bob', 1100);
    await vi.waitFor(() => expect(second.published).toHaveLength(1));
    second.answer(0, { accepted: true });
    await expect(next).resolves.toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
