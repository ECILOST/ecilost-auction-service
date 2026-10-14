import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RoundStatus } from '../src/generated/prisma/client.js';
import { BidsService } from '../src/bids/bids.service.js';
import { BuyNowService } from '../src/bids/buy-now.service.js';
import { activeRound, createPrisma, FakeWallet, resetDatabase, seedRoom } from './helpers.js';

const BUY_NOW_PRICE = 5000;

/** Una billetera cuya liberacion inmediata no responde para ciertos estudiantes. */
class WalletWithLostReleases extends FakeWallet {
  constructor(balances: Record<string, number>, private readonly unreachable: Set<string>) {
    super(balances);
  }

  override async release(userId: string, reference: string, amount: number) {
    if (this.unreachable.has(userId)) throw new Error('La billetera no respondio.');
    return super.release(userId, reference, amount);
  }
}

/**
 * HU-25 contra PostgreSQL real: un unico adquirente y fondos de los demas liberados.
 *
 * La liquidacion se hace con el evento que auction dejo en el outbox, el mismo que consume
 * ecilost-wallet-service, para probar el contrato de punta a punta sin wallet desplegado.
 */
describe('Adquirente unico y liberacion de fondos (PostgreSQL)', () => {
  const prisma = createPrisma();

  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());
  beforeEach(() => resetDatabase(prisma));

  const services = (wallet: FakeWallet) => {
    const bids = new BidsService(prisma, wallet as never);
    return { bids, buyNow: new BuyNowService(prisma, bids, wallet as never) };
  };

  /** Liquida en la billetera simulada cada cierre de la ronda publicado en el outbox. */
  async function settleFromOutbox(wallet: FakeWallet, roundId: string) {
    const closed = await prisma.outboxEvent.findMany({ where: { eventType: 'auction.round.closed.v1', aggregateId: roundId } });
    for (const { payload } of closed) {
      const event = payload as { roundId: string; winnerId: string | null; winningAmount: string | null };
      wallet.settle(event);
      // Una reentrega del mismo evento no cobra dos veces.
      wallet.settle(event);
    }
    return closed.length;
  }

  it('criterio 1: dos estudiantes compran a la vez; uno obtiene el objeto y al otro no se le debita', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await resetDatabase(prisma);
      const wallet = new FakeWallet({ ana: 10_000, beto: 10_000 }, 20);
      const { roundIds: [roundId] } = await seedRoom(prisma, {
        participants: ['ana', 'beto'], rounds: [activeRound(60_000, { buyNowPrice: BUY_NOW_PRICE })],
      });
      const { buyNow } = services(wallet);

      const outcomes = await Promise.allSettled([buyNow.buy(roundId, 'ana'), buyNow.buy(roundId, 'beto')]);

      const winners = outcomes.flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value.buyerId] : []));
      expect(winners).toHaveLength(1);
      const [winner] = winners;
      const loser = winner === 'ana' ? 'beto' : 'ana';
      const rejection = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
      expect(String(rejection.reason)).toMatch(/ya no admite compra inmediata|no esta activa/);
      // Al rechazado se le devuelve la reserva en el acto, sin esperar la liquidacion.
      expect(wallet.heldBy(loser)).toBe(0);
      expect(wallet.available.get(loser)).toBe(10_000);

      expect(await prisma.round.findUniqueOrThrow({ where: { id: roundId } })).toMatchObject({
        status: RoundStatus.CLOSED, winnerId: winner, closeReason: 'BUY_NOW',
      });
      expect(await settleFromOutbox(wallet, roundId)).toBe(1);
      expect(wallet.debited.get(winner)).toBe(BUY_NOW_PRICE);
      expect(wallet.available.get(winner)).toBe(10_000 - BUY_NOW_PRICE);
      expect(wallet.debited.get(loser)).toBeUndefined();
      expect(wallet.available.get(loser)).toBe(10_000);
      expect(wallet.holds.size).toBe(0);
      expect(wallet.negativeSeen).toBe(false);
    }
  });

  it('criterio 3: la compra libera los ECICoin reservados de quienes pujaban, aunque su liberacion inmediata se haya perdido', async () => {
    // Alicia queda superada por Bruno, pero wallet no responde a su liberacion inmediata: su
    // reserva sigue retenida. Bruno lidera con su reserva. Carla compra de inmediato.
    const wallet = new WalletWithLostReleases({ alicia: 10_000, bruno: 10_000, carla: 10_000 }, new Set(['alicia']));
    const { roundIds: [roundId] } = await seedRoom(prisma, {
      participants: ['alicia', 'bruno', 'carla'], rounds: [activeRound(60_000, { buyNowPrice: BUY_NOW_PRICE })],
    });
    const { bids, buyNow } = services(wallet);
    await bids.place(roundId, 'alicia', 2000);
    await bids.place(roundId, 'bruno', 2100);
    expect(wallet.heldBy('alicia')).toBe(2000);
    expect(wallet.heldBy('bruno')).toBe(2100);

    await buyNow.buy(roundId, 'carla');

    // Antes de liquidar, auction no toca las reservas ajenas: las libera la liquidacion.
    expect(wallet.heldBy('alicia') + wallet.heldBy('bruno')).toBe(4100);
    expect(await settleFromOutbox(wallet, roundId)).toBe(1);

    expect(wallet.debited.get('carla')).toBe(BUY_NOW_PRICE);
    expect(wallet.available.get('carla')).toBe(10_000 - BUY_NOW_PRICE);
    for (const bidder of ['alicia', 'bruno']) {
      expect(wallet.heldBy(bidder)).toBe(0);
      expect(wallet.available.get(bidder)).toBe(10_000);
      expect(wallet.debited.get(bidder)).toBeUndefined();
    }
    expect(wallet.holds.size).toBe(0);
  });

  it('criterio 3: quien lideraba y compra solo paga el precio de compra, no su puja mas el precio', async () => {
    const wallet = new FakeWallet({ bruno: 10_000 });
    const { roundIds: [roundId] } = await seedRoom(prisma, {
      participants: ['bruno'], rounds: [activeRound(60_000, { buyNowPrice: BUY_NOW_PRICE })],
    });
    const { bids, buyNow } = services(wallet);
    await bids.place(roundId, 'bruno', 3000);

    await buyNow.buy(roundId, 'bruno');
    await settleFromOutbox(wallet, roundId);

    expect(wallet.debited.get('bruno')).toBe(BUY_NOW_PRICE);
    expect(wallet.available.get('bruno')).toBe(10_000 - BUY_NOW_PRICE);
    expect(wallet.holds.size).toBe(0);
  });
});
