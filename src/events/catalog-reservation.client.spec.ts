import { ServiceUnavailableException } from '@nestjs/common';
import type { ConsumeMessage } from 'amqplib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuctionConfig } from '../config/auction.config.js';
import { CatalogReservationClient } from './catalog-reservation.client.js';

const connect = vi.hoisted(() => vi.fn());
vi.mock('amqplib', () => ({ default: { connect } }));

function setup() {
  const channel = {
    assertQueue: vi.fn().mockResolvedValue({ queue: 'responses' }),
    assertExchange: vi.fn(),
    consume: vi.fn(),
    publish: vi.fn(),
    waitForConfirms: vi.fn(),
  };
  const connection = {
    createChannel: vi.fn().mockResolvedValue(channel),
    createConfirmChannel: vi.fn().mockResolvedValue(channel),
    close: vi.fn(),
  };
  connect.mockResolvedValue(connection);
  const client = new CatalogReservationClient({ rabbitmqUrl: 'amqp://test' } as AuctionConfig);
  return { client, connection, channel };
}

const entries = [{ kind: 'ITEM', catalogId: 'i1', roundId: 'r1' }] as const;

describe('CatalogReservationClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    connect.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('accepts only the response correlated to its reservation request', async () => {
    const { client, connection, channel } = setup();
    const result = client.reserve([...entries]);
    await vi.advanceTimersByTimeAsync(0);
    const [exchange, routingKey, body, options] = channel.publish.mock.calls[0];
    expect([exchange, routingKey]).toEqual(['ecilost.events', 'catalog.round-reservation.requested.v1']);
    expect(JSON.parse(body.toString())).toEqual({ entries });
    expect(options).toMatchObject({ replyTo: 'responses', persistent: true });
    const reply: (message: Partial<ConsumeMessage>) => void = channel.consume.mock.calls[0][1];
    reply({ properties: { correlationId: 'unrelated' } as ConsumeMessage['properties'], content: Buffer.from('{"accepted":false}') });
    reply({ properties: options, content: Buffer.from('{"accepted":true}') });
    await expect(result).resolves.toBe(true);
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it('closes the connection when a reservation times out', async () => {
    const { client, connection } = setup();
    const failure = expect(client.reserve([...entries])).rejects.toBeInstanceOf(ServiceUnavailableException);
    await vi.advanceTimersByTimeAsync(5_000);
    await failure;
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it('reports broker connection failures as service unavailable', async () => {
    const { client } = setup();
    connect.mockRejectedValueOnce(new Error('offline'));
    await expect(client.reserve([...entries])).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('sends cancellation with the event id and waits for a broker confirmation', async () => {
    const { client, connection, channel } = setup();
    const event = { eventId: 'order-1', eventType: 'catalog.round-reservation.cancelled.v1' };
    await client.cancel(event);
    expect(channel.publish).toHaveBeenCalledWith(
      'ecilost.events', event.eventType, Buffer.from(JSON.stringify(event)),
      { persistent: true, messageId: event.eventId },
    );
    expect(channel.waitForConfirms).toHaveBeenCalledBefore(connection.close);
  });
});
