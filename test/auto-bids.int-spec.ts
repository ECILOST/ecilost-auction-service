import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BidStatus } from '../src/generated/prisma/client.js';
import { AutoBidsService } from '../src/bids/auto-bids.service.js';
import { BidsService } from '../src/bids/bids.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { activeRound, createPrisma, FakeWallet, resetDatabase, seedRoom } from './helpers.js';

/**
 * HU-22 contra PostgreSQL real. Cada "instancia" es un AutoBidsService distinto: no comparten
 * la fusion en memoria, igual que dos replicas del servicio, y solo la base las coordina.
 */
describe('Puja automatica (PostgreSQL)', () => {
  const prisma = createPrisma();

  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());
  beforeEach(() => resetDatabase(prisma));

  function instances(wallet: FakeWallet, count = 3) {
    return Array.from({ length: count }, () => {
      const bids = new BidsService(prisma as PrismaService, wallet as never);
      return { bids, autoBids: new AutoBidsService(prisma as PrismaService, wallet as never, bids) };
    });
  }

  /** Lo que haria el barrido de respaldo: resolver hasta que nadie pueda responder. */
  async function settle(engine: AutoBidsService, roundId: string) {
    for (let pass = 0; pass < 5; pass += 1) await engine.resolve(roundId);
  }

  async function assertInvariants(roundId: string, wallet: FakeWallet, limits: Record<string, number>) {
    const round = await prisma.round.findUniqueOrThrow({ where: { id: roundId } });
    const accepted = await prisma.bid.findMany({ where: { roundId, status: BidStatus.ACCEPTED }, orderBy: { sequence: 'asc' } });
    for (let index = 1; index < accepted.length; index += 1) expect(accepted[index].amount.gt(accepted[index - 1].amount)).toBe(true);
    for (const bid of accepted.filter((candidate) => candidate.automatic)) {
      // Una puja automatica nunca pasa del limite declarado.
      expect(Number(bid.amount)).toBeLessThanOrEqual(limits[bid.bidderId]);
    }
    expect(wallet.negativeSeen).toBe(false);
    for (const bidder of Object.keys(limits)) {
      expect(wallet.heldBy(bidder)).toBe(bidder === round.currentBidderId ? Number(round.currentPrice) : 0);
    }
    return round;
  }

  it('compite por el estudiante cuando otro supera el precio y se detiene en su limite', async () => {
    const wallet = new FakeWallet({ alice: 100_000, bob: 100_000 });
    const [{ bids, autoBids }] = instances(wallet, 1);
    const { roundIds: [roundId] } = await seedRoom(prisma, { participants: ['alice', 'bob'], rounds: [activeRound(5 * 60_000)] });

    await autoBids.configure(roundId, 'alice', { enabled: true, maximumAmount: 5000 });
    let round = await prisma.round.findUniqueOrThrow({ where: { id: roundId } });
    expect(round).toMatchObject({ currentBidderId: 'alice' });
    expect(Number(round.currentPrice)).toBe(1000);

    await bids.place(roundId, 'bob', 2000);
    await settle(autoBids, roundId);
    round = await prisma.round.findUniqueOrThrow({ where: { id: roundId } });
    expect(round.currentBidderId).toBe('alice');
    expect(Number(round.currentPrice)).toBe(2100);

    await bids.place(roundId, 'bob', 5000);
    await settle(autoBids, roundId);
    round = await assertInvariants(roundId, wallet, { alice: 5000, bob: 100_000 });
    expect(round.currentBidderId).toBe('bob');
    expect((await autoBids.view(roundId, 'alice')).stoppedReason).toBe('LIMIT_REACHED');

    const automatic = await prisma.outboxEvent.findMany({ where: { eventType: 'auction.bid.accepted.v1' } });
    expect(automatic.filter((event) => (event.payload as { automatic: boolean }).automatic)).toHaveLength(2);
  });

  it('declaraciones y pujas simultaneas desde varias instancias terminan siempre igual', async () => {
    const limits = { alice: 7000, bob: 9000, carol: 9000, dan: 4000 };
    const outcomes: Array<{ leader: string | null; price: number }> = [];

    for (let run = 0; run < 4; run += 1) {
      await resetDatabase(prisma);
      const wallet = new FakeWallet({ alice: 50_000, bob: 50_000, carol: 50_000, dan: 50_000, eve: 50_000 }, 15);
      const engines = instances(wallet);
      const { roundIds: [roundId] } = await seedRoom(prisma, { participants: [...Object.keys(limits), 'eve'], rounds: [activeRound(5 * 60_000)] });

      // bob declara antes que carol (mismo limite): por prioridad de llegada, bob debe ganar.
      await engines[0].autoBids.configure(roundId, 'bob', { enabled: true, maximumAmount: limits.bob });
      const shuffled = (['alice', 'carol', 'dan'] as const).map((bidder, index) => ({ bidder, key: Math.random() + index * 0 }))
        .sort((a, b) => a.key - b.key);
      await Promise.allSettled([
        ...shuffled.map(({ bidder }, index) =>
          engines[index % engines.length].autoBids.configure(roundId, bidder, { enabled: true, maximumAmount: limits[bidder] })),
        engines[1].bids.place(roundId, 'eve', 3000),
        engines[2].bids.place(roundId, 'eve', 4500),
      ]);
      for (const engine of engines) await settle(engine.autoBids, roundId);

      const round = await assertInvariants(roundId, wallet, { ...limits, eve: 50_000 });
      outcomes.push({ leader: round.currentBidderId, price: Number(round.currentPrice) });
    }

    // Mismo estado inicial + mismos limites + misma regla de prioridad = mismo resultado.
    for (const outcome of outcomes) expect(outcome).toEqual({ leader: 'bob', price: 9000 });
  });

  it('un disparo que supera el saldo disponible se rechaza y no compromete fondos', async () => {
    const wallet = new FakeWallet({ alice: 5000, bob: 100_000 });
    const [{ bids, autoBids }] = instances(wallet, 1);
    const { roundIds: [roundId] } = await seedRoom(prisma, { participants: ['alice', 'bob'], rounds: [activeRound(5 * 60_000)] });
    await autoBids.configure(roundId, 'alice', { enabled: true, maximumAmount: 5000 });

    // alice gasta su saldo en otra parte: al dispararse, su puja automatica ya no alcanza.
    wallet.available.set('alice', 0);
    await bids.place(roundId, 'bob', 2000);
    await settle(autoBids, roundId);

    const round = await prisma.round.findUniqueOrThrow({ where: { id: roundId } });
    expect(round.currentBidderId).toBe('bob');
    expect(Number(round.currentPrice)).toBe(2000);
    expect((await autoBids.view(roundId, 'alice')).stoppedReason).toBe('INSUFFICIENT_FUNDS');
    expect(wallet.heldBy('alice')).toBe(0);
    expect(wallet.available.get('alice')).toBe(1000);
  });

  it('rechaza declarar un limite mayor que el saldo disponible', async () => {
    const wallet = new FakeWallet({ alice: 3000 });
    const [{ autoBids }] = instances(wallet, 1);
    const { roundIds: [roundId] } = await seedRoom(prisma, { participants: ['alice'], rounds: [activeRound(5 * 60_000)] });
    await expect(autoBids.configure(roundId, 'alice', { enabled: true, maximumAmount: 3001 })).rejects.toThrow('disponibles suficientes para ese limite');
    expect(await prisma.autoBid.count()).toBe(0);
    expect(await prisma.bid.count()).toBe(0);
  });
});
