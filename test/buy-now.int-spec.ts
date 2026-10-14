import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RoomStatus, RoundStatus } from '../src/generated/prisma/client.js';
import { BidsService } from '../src/bids/bids.service.js';
import { BuyNowService } from '../src/bids/buy-now.service.js';
import { RoomsService } from '../src/rooms/rooms.service.js';
import { activeRound, createPrisma, FakeWallet, resetDatabase, seedRoom } from './helpers.js';

const BUY_NOW_PRICE = 5000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * HU-24 (y los criterios de concurrencia de HU-25) contra PostgreSQL real. La fila de la ronda
 * es el arbitro: solo un estudiante se lleva el objeto, nadie queda con fondos reservados por
 * una compra que no entro y el cierre se publica una sola vez.
 */
describe('Compra inmediata (PostgreSQL)', () => {
  const prisma = createPrisma();
  const rooms = new RoomsService(prisma, { reserve: async () => true } as never);
  const services = (wallet: FakeWallet) => {
    const bids = new BidsService(prisma, wallet as never);
    return { bids, buyNow: new BuyNowService(prisma, bids, wallet as never) };
  };

  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());
  beforeEach(() => resetDatabase(prisma));

  const events = async () =>
    (await prisma.outboxEvent.findMany({ orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] })).map((event) => event.payload as Record<string, unknown>);
  const closedEvents = async () => (await events()).filter((event) => event.eventType === 'auction.round.closed.v1');
  const round = (id: string) => prisma.round.findUniqueOrThrow({ where: { id } });

  it('escenario 1: compra con saldo suficiente, cierra la ronda y la sala y publica el cierre', async () => {
    const wallet = new FakeWallet({ alice: 10_000 });
    const { roomId, roundIds: [roundId] } = await seedRoom(prisma, {
      participants: ['alice'], rounds: [activeRound(60_000, { buyNowPrice: BUY_NOW_PRICE })],
    });

    const result = await services(wallet).buyNow.buy(roundId, 'alice');

    expect(result).toMatchObject({ roundId, roomId, buyerId: 'alice', replayed: false });
    expect(result.price.toString()).toBe(String(BUY_NOW_PRICE));
    const closed = await round(roundId);
    expect(closed).toMatchObject({ status: RoundStatus.CLOSED, result: 'AWARDED', winnerId: 'alice', currentBidderId: 'alice', closeReason: 'BUY_NOW' });
    expect(closed.currentPrice.toString()).toBe(String(BUY_NOW_PRICE));
    expect(closed.closedAt?.getTime()).toBe(result.closedAt.getTime());
    expect((await prisma.room.findUniqueOrThrow({ where: { id: roomId } })).status).toBe(RoomStatus.CLOSED);
    // Wallet cobrara esta reserva al liquidar: es exactamente el precio de compra.
    expect(wallet.holds.get(`bid:${roundId}:alice`)).toBe(BUY_NOW_PRICE);
    expect(wallet.available.get('alice')).toBe(10_000 - BUY_NOW_PRICE);
    expect(await events()).toEqual([expect.objectContaining({
      eventType: 'auction.round.closed.v1', roundId, roomStatus: 'CLOSED', result: 'AWARDED', winnerId: 'alice',
      winningAmount: String(BUY_NOW_PRICE), closeReason: 'BUY_NOW',
    })]);
  });

  it('escenario 2: sin saldo suficiente se rechaza, no reserva y la ronda sigue activa', async () => {
    const wallet = new FakeWallet({ bob: BUY_NOW_PRICE - 1 });
    const { roundIds: [roundId] } = await seedRoom(prisma, {
      participants: ['bob'], rounds: [activeRound(60_000, { buyNowPrice: BUY_NOW_PRICE })],
    });

    await expect(services(wallet).buyNow.buy(roundId, 'bob')).rejects.toThrow('No tienes ECICoin disponibles suficientes');

    expect(await round(roundId)).toMatchObject({ status: RoundStatus.ACTIVE, winnerId: null, currentBidderId: null, closeReason: null });
    expect(wallet.heldBy('bob')).toBe(0);
    expect(wallet.available.get('bob')).toBe(BUY_NOW_PRICE - 1);
    expect(await events()).toEqual([]);
  });

  it('escenario 3: una ronda finalizada rechaza la compra sin reservar, sin reabrirla ni cambiar el ganador', async () => {
    const wallet = new FakeWallet({ alice: 10_000 });
    const { roundIds: [roundId] } = await seedRoom(prisma, {
      participants: ['alice', 'bob'],
      rounds: [{ ...activeRound(-60_000, { buyNowPrice: BUY_NOW_PRICE, currentPrice: 2000, currentBidderId: 'bob' }), status: RoundStatus.CLOSED }],
    });
    await prisma.round.update({ where: { id: roundId }, data: { result: 'AWARDED', winnerId: 'bob', closedAt: new Date(), closeReason: 'EXPIRED' } });

    await expect(services(wallet).buyNow.buy(roundId, 'alice')).rejects.toThrow('La ronda no esta activa.');

    expect(await round(roundId)).toMatchObject({ status: RoundStatus.CLOSED, winnerId: 'bob', closeReason: 'EXPIRED' });
    expect(wallet.heldBy('alice')).toBe(0);
    expect(await events()).toEqual([]);
  });

  it('cinco estudiantes compran a la vez: exactamente uno se lleva el objeto y nadie queda con fondos retenidos', async () => {
    const buyers = ['ana', 'beto', 'carla', 'dani', 'eva'];
    const wallet = new FakeWallet(Object.fromEntries(buyers.map((buyer) => [buyer, 10_000])), 20);
    const { roundIds: [roundId] } = await seedRoom(prisma, {
      participants: buyers, rounds: [activeRound(60_000, { buyNowPrice: BUY_NOW_PRICE })],
    });
    const { buyNow } = services(wallet);

    const outcomes = await Promise.allSettled(buyers.map((buyer) => buyNow.buy(roundId, buyer)));

    const winners = outcomes.flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value.buyerId] : []));
    expect(winners).toHaveLength(1);
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(rejected).toHaveLength(4);
    for (const outcome of rejected) expect(String((outcome as PromiseRejectedResult).reason)).toMatch(/ya no admite compra inmediata|no esta activa/);

    expect(await round(roundId)).toMatchObject({ status: RoundStatus.CLOSED, winnerId: winners[0], closeReason: 'BUY_NOW' });
    expect(await closedEvents()).toHaveLength(1);
    for (const buyer of buyers) {
      expect(wallet.heldBy(buyer)).toBe(buyer === winners[0] ? BUY_NOW_PRICE : 0);
      expect(wallet.available.get(buyer)).toBe(buyer === winners[0] ? 10_000 - BUY_NOW_PRICE : 10_000);
    }
    expect(wallet.negativeSeen).toBe(false);
  });

  it('el mismo estudiante envia dos compras a la vez: una compra, la otra la repite sin volver a reservar', async () => {
    const wallet = new FakeWallet({ alice: 10_000 }, 20);
    const { roundIds: [roundId] } = await seedRoom(prisma, {
      participants: ['alice'], rounds: [activeRound(60_000, { buyNowPrice: BUY_NOW_PRICE })],
    });
    const { buyNow } = services(wallet);

    const results = await Promise.all([buyNow.buy(roundId, 'alice'), buyNow.buy(roundId, 'alice')]);

    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(new Set(results.map((result) => result.closedAt.getTime())).size).toBe(1);
    expect(await closedEvents()).toHaveLength(1);
    expect(wallet.heldBy('alice')).toBe(BUY_NOW_PRICE);
    expect(wallet.available.get('alice')).toBe(10_000 - BUY_NOW_PRICE);
  });

  it('quien ya lidera solo reserva la diferencia hasta el precio de compra', async () => {
    const wallet = new FakeWallet({ alice: 10_000 });
    const { roundIds: [roundId] } = await seedRoom(prisma, {
      participants: ['alice'], rounds: [activeRound(60_000, { buyNowPrice: BUY_NOW_PRICE })],
    });
    const { bids, buyNow } = services(wallet);
    await bids.place(roundId, 'alice', 2000);
    expect(wallet.available.get('alice')).toBe(8000);

    await buyNow.buy(roundId, 'alice');

    expect(wallet.holds.get(`bid:${roundId}:alice`)).toBe(BUY_NOW_PRICE);
    expect(wallet.available.get('alice')).toBe(10_000 - BUY_NOW_PRICE);
  });

  it('una puja que alcanza el precio de compra y una compra simultaneas dejan un unico resultado', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await resetDatabase(prisma);
      const wallet = new FakeWallet({ alice: 10_000, bob: 10_000 }, 20);
      const { roundIds: [roundId] } = await seedRoom(prisma, {
        participants: ['alice', 'bob'], rounds: [activeRound(60_000, { buyNowPrice: BUY_NOW_PRICE })],
      });
      const { bids, buyNow } = services(wallet);

      const [purchase, bid] = await Promise.allSettled([buyNow.buy(roundId, 'alice'), bids.place(roundId, 'bob', BUY_NOW_PRICE)]);

      // La puja de bob iguala el precio de compra: si entra primero, la compra ya no aplica;
      // si la compra entra primero, la ronda esta cerrada para la puja. Nunca ambas.
      expect([purchase.status, bid.status].sort()).toEqual(['fulfilled', 'rejected']);
      const final = await round(roundId);
      if (purchase.status === 'fulfilled') {
        expect(final).toMatchObject({ status: RoundStatus.CLOSED, winnerId: 'alice', closeReason: 'BUY_NOW' });
        expect(wallet.heldBy('bob')).toBe(0);
        expect(await closedEvents()).toHaveLength(1);
      } else {
        expect(final).toMatchObject({ status: RoundStatus.ACTIVE, currentBidderId: 'bob', closeReason: null });
        expect(wallet.heldBy('alice')).toBe(0);
        expect(await closedEvents()).toHaveLength(0);
      }
      expect(wallet.negativeSeen).toBe(false);
    }
  });

  it('una compra que compite con el cierre por vencimiento: la ronda se cierra una sola vez', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await resetDatabase(prisma);
      const wallet = new FakeWallet({ alice: 10_000, bob: 10_000 }, 20);
      const endsAt = new Date(Date.now() + 2000);
      const { roundIds: [roundId] } = await seedRoom(prisma, {
        participants: ['alice', 'bob'], rounds: [activeRound(2000, { endsAt, maximumEndsAt: endsAt, buyNowPrice: BUY_NOW_PRICE })],
      });
      const { bids, buyNow } = services(wallet);
      await bids.place(roundId, 'bob', 1000);

      // El ciclo corre con una hora ya vencida y compite por la fila con la compra. Arranca con
      // un retraso al azar: sin el, siempre ganaba antes de que la compra terminara de reservar.
      const closing = sleep(Math.random() * 40).then(() => rooms.activateDueRooms(new Date(endsAt.getTime() + 1)));
      const [purchase] = await Promise.allSettled([buyNow.buy(roundId, 'alice'), closing]);

      const final = await round(roundId);
      expect(final.status).toBe(RoundStatus.CLOSED);
      expect(await closedEvents()).toHaveLength(1);
      if (purchase.status === 'fulfilled') {
        expect(final).toMatchObject({ winnerId: 'alice', closeReason: 'BUY_NOW' });
        expect(wallet.heldBy('alice')).toBe(BUY_NOW_PRICE);
      } else {
        expect(final).toMatchObject({ winnerId: 'bob', closeReason: 'EXPIRED' });
        expect(final.currentPrice.toString()).toBe('1000');
        expect(wallet.heldBy('alice')).toBe(0);
      }
    }
  });

  it('si no es la ultima ronda, la siguiente se abre en el mismo instante y la sala sigue activa', async () => {
    const wallet = new FakeWallet({ alice: 10_000 });
    const { roomId, roundIds } = await seedRoom(prisma, {
      participants: ['alice'], rounds: [activeRound(60_000, { buyNowPrice: BUY_NOW_PRICE }), {}],
    });

    const result = await services(wallet).buyNow.buy(roundIds[0], 'alice');

    const next = await round(roundIds[1]);
    expect(next.status).toBe(RoundStatus.ACTIVE);
    expect(next.startedAt?.getTime()).toBe(result.closedAt.getTime());
    expect((await prisma.room.findUniqueOrThrow({ where: { id: roomId } })).status).toBe(RoomStatus.ACTIVE);
    expect((await events()).map((event) => [event.eventType, event.position, event.roomStatus])).toEqual([
      ['auction.round.closed.v1', 1, 'ACTIVE'],
      ['auction.round.activated.v1', 2, 'ACTIVE'],
    ]);
    expect((await rooms.getCurrentState(roomId, 'alice')).currentRound?.id).toBe(roundIds[1]);
  });

  it('si la base falla a mitad del cierre no queda nada a medias y se libera la reserva', async () => {
    const wallet = new FakeWallet({ alice: 10_000 });
    const { roomId, roundIds: [roundId] } = await seedRoom(prisma, {
      participants: ['alice'], rounds: [activeRound(60_000, { buyNowPrice: BUY_NOW_PRICE })],
    });
    // Un fallo real dentro de la transaccion: el outbox rechaza la insercion despues de que la
    // ronda ya se actualizo y se cerro en esa misma transaccion.
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION buy_now_it_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'fallo simulado del outbox'; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER buy_now_it_fail BEFORE INSERT ON "outbox_events" FOR EACH ROW EXECUTE FUNCTION buy_now_it_fail()`);
    try {
      await expect(services(wallet).buyNow.buy(roundId, 'alice')).rejects.toThrow('fallo simulado del outbox');
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS buy_now_it_fail ON "outbox_events"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS buy_now_it_fail()`);
    }

    expect(await round(roundId)).toMatchObject({ status: RoundStatus.ACTIVE, currentBidderId: null, winnerId: null, closeReason: null });
    expect((await round(roundId)).currentPrice.toString()).toBe('1000');
    expect((await prisma.room.findUniqueOrThrow({ where: { id: roomId } })).status).toBe(RoomStatus.ACTIVE);
    expect(await events()).toEqual([]);
    expect(wallet.heldBy('alice')).toBe(0);
    expect(wallet.available.get('alice')).toBe(10_000);
  });
});
