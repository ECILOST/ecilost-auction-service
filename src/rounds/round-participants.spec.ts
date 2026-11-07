import { describe, expect, it, vi } from 'vitest';
import { Prisma, RoundMode } from '../generated/prisma/client.js';
import { roundParticipants } from './round-lifecycle.js';

const decimal = (value: number) => new Prisma.Decimal(value);
const row = (bidderId: string, bids: number, best: number | null) => ({
  bidderId,
  _count: { _all: bids },
  _max: { amount: best === null ? null : decimal(best) },
});

/**
 * Lo que el cierre de ronda le cuenta a engagement para el perfil y el top semanal:
 * quien participo, cuantas veces y con que oferta maxima, y en sobre cerrado la segunda.
 */
describe('roundParticipants (gamificacion)', () => {
  it('en sobre cerrado lee los sobres y calcula la oferta del segundo', async () => {
    const tx = {
      sealedBid: { groupBy: vi.fn().mockResolvedValue([row('b', 1, 4200), row('a', 1, 4750), row('c', 1, 1000)]) },
      bid: { groupBy: vi.fn() },
    };

    const result = await roundParticipants(tx as never, { id: 'round-1', mode: RoundMode.SEALED });

    expect(tx.bid.groupBy).not.toHaveBeenCalled();
    expect(result.participants.map((p) => [p.bidderId, p.bestAmount])).toEqual([
      ['a', '4750'],
      ['b', '4200'],
      ['c', '1000'],
    ]);
    expect(result.runnerUpAmount).toBe('4200');
  });

  it('en las demas modalidades cuenta solo pujas aceptadas y no publica segunda oferta', async () => {
    const tx = {
      bid: { groupBy: vi.fn().mockResolvedValue([row('a', 3, 900), row('b', 5, 1200)]) },
      sealedBid: { groupBy: vi.fn() },
    };

    const result = await roundParticipants(tx as never, { id: 'round-1', mode: RoundMode.CLASSIC });

    expect(tx.bid.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { roundId: 'round-1', status: 'ACCEPTED' } }));
    expect(result.participants).toEqual([
      { bidderId: 'b', bids: 5, bestAmount: '1200' },
      { bidderId: 'a', bids: 3, bestAmount: '900' },
    ]);
    expect(result.runnerUpAmount).toBeNull();
  });

  it('una ronda sin pujas cierra sin participantes', async () => {
    const tx = { bid: { groupBy: vi.fn().mockResolvedValue([]) }, sealedBid: { groupBy: vi.fn() } };
    expect(await roundParticipants(tx as never, { id: 'r', mode: RoundMode.DUTCH })).toEqual({ participants: [], runnerUpAmount: null });
  });
});
