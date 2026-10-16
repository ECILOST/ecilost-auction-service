import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma, RoomStatus, RoundMode, RoundStatus } from '../src/generated/prisma/client.js';
import { BidsService } from '../src/bids/bids.service.js';
import { DutchService } from '../src/bids/dutch.service.js';
import { SealedBidsService } from '../src/bids/sealed-bids.service.js';
import { DynamicModesService } from '../src/rooms/dynamic-modes.service.js';
import { RoomsService } from '../src/rooms/rooms.service.js';
import { activeRound, createPrisma, FakeWallet, resetDatabase, seedRoom } from './helpers.js';

const decimal = (value: number) => new Prisma.Decimal(value);

/**
 * Subastas dinamicas (ADR-0003) contra PostgreSQL real: el precio holandes lo pone el reloj de
 * la base, la fila de la ronda arbitra quien se lo lleva, y los sobres entran antes del cierre o
 * no entran.
 */
describe('Subastas dinamicas (PostgreSQL)', () => {
  const prisma = createPrisma();
  const rooms = new RoomsService(prisma, { reserve: async () => true } as never);
  const services = (wallet: FakeWallet) => {
    const bids = new BidsService(prisma, wallet as never);
    return { bids, dutch: new DutchService(prisma, bids, wallet as never), sealed: new SealedBidsService(prisma, bids, wallet as never) };
  };

  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());
  beforeEach(() => resetDatabase(prisma));

  const events = async (type: string) =>
    (await prisma.outboxEvent.findMany({ where: { eventType: type }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] }))
      .map((event) => event.payload as Record<string, unknown>);

  /** Una ronda holandesa abierta hace `elapsedMs`: 8.000 → 2.000 en escalones de 300 cada 5 s. */
  async function dutchRound(participants: string[], elapsedMs: number) {
    const seeded = await seedRoom(prisma, {
      participants,
      rounds: [activeRound(60_000, { startingPrice: 2000, currentPrice: 8000, startedAt: new Date(Date.now() - elapsedMs) })],
    });
    await prisma.round.update({
      where: { id: seeded.roundIds[0] },
      data: { mode: RoundMode.DUTCH, modeLockedAt: new Date(), dutchStartPrice: decimal(8000), dutchFloorPrice: decimal(2000), dutchStep: decimal(300), dutchIntervalSeconds: 5 },
    });
    return seeded;
  }

  it('holandesa: el precio lo calcula la base y solo uno se lo lleva entre pedidos simultaneos', async () => {
    const wallet = new FakeWallet({ ana: 10_000, bob: 10_000, carl: 10_000 });
    const { roundIds: [roundId] } = await dutchRound(['ana', 'bob', 'carl'], 12_000);
    const { dutch } = services(wallet);

    const outcomes = await Promise.allSettled(['ana', 'bob', 'carl'].map((buyer) => dutch.claim(roundId, buyer)));
    const won = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    expect(won).toHaveLength(1);
    const winner = (won[0] as PromiseFulfilledResult<{ buyerId: string; price: Prisma.Decimal }>).value;

    const closed = await prisma.round.findUniqueOrThrow({ where: { id: roundId } });
    expect(closed).toMatchObject({ status: RoundStatus.CLOSED, result: 'AWARDED', winnerId: winner.buyerId, closeReason: 'DUTCH_CLAIM' });
    // El precio es el del instante del cierre segun el reloj de la base: 8.000 menos un escalon
    // de 300 por cada 5 s transcurridos. Se abrio hace 12 s, asi que van al menos dos.
    const steps = Math.floor((closed.closedAt!.getTime() - closed.startedAt!.getTime()) / 5_000);
    expect(steps).toBeGreaterThanOrEqual(2);
    expect(winner.price.toString()).toBe(String(8000 - 300 * steps));
    const price = Number(winner.price);
    // Los que perdieron la carrera no quedan con ECICoin retenidos.
    for (const buyer of ['ana', 'bob', 'carl'].filter((id) => id !== winner.buyerId)) expect(wallet.heldBy(buyer)).toBe(0);
    const [event] = await events('auction.round.closed.v1');
    expect(event).toMatchObject({ winnerId: winner.buyerId, winningAmount: String(price), closeReason: 'DUTCH_CLAIM', mode: 'DUTCH' });
    wallet.settle(event as never);
    // Se reservo el precio cotizado y se cobra el del cierre, que nunca es mayor: el resto vuelve.
    expect(wallet.debited.get(winner.buyerId)).toBe(price);
    expect(wallet.available.get(winner.buyerId)).toBe(10_000 - price);
    expect(wallet.negativeSeen).toBe(false);
  });

  it('holandesa: no admite pujas ascendentes y nunca baja del minimo', async () => {
    const wallet = new FakeWallet({ ana: 10_000 });
    const { roundIds: [roundId] } = await dutchRound(['ana'], 10 * 60_000);
    const { bids, dutch } = services(wallet);
    await expect(bids.place(roundId, 'ana', 9000)).rejects.toThrow('pujas ascendentes');
    const claimed = await dutch.claim(roundId, 'ana');
    expect(claimed.price.toString()).toBe('2000');
  });

  it('sobre cerrado: un sobre por estudiante, gana el mas alto y en empate el primero', async () => {
    const wallet = new FakeWallet({ ana: 10_000, bob: 10_000, carl: 10_000 });
    const { roomId, roundIds: [roundId] } = await seedRoom(prisma, {
      participants: ['ana', 'bob', 'carl'], rounds: [activeRound(60_000, { startingPrice: 3000 })],
    });
    await prisma.round.update({ where: { id: roundId }, data: { mode: RoundMode.SEALED, modeLockedAt: new Date() } });
    const { sealed, bids } = services(wallet);

    await sealed.seal(roundId, 'bob', 5200);
    await Promise.all([sealed.seal(roundId, 'ana', 4750), sealed.seal(roundId, 'carl', 5200)]);
    await expect(sealed.seal(roundId, 'ana', 9000)).rejects.toThrow('Ya sellaste');
    await expect(bids.place(roundId, 'ana', 9000)).rejects.toThrow('pujas ascendentes');

    // Mientras esta abierta: el precio y el lider no se mueven, y cada uno solo ve su sobre.
    const open = await rooms.getRoom(roomId, 'ana');
    expect(open.rounds[0]).toMatchObject({ hasBids: false, isLeading: false, sealed: { count: 3 } });
    expect(open.rounds[0].sealed?.mine?.amount.toString()).toBe('4750');
    expect(open.rounds[0].currentPrice.toString()).toBe('3000');
    expect((await events('auction.round.sealed-bid.placed.v1')).map((event) => event.sealedCount)).toEqual([1, 2, 3]);

    await prisma.round.update({ where: { id: roundId }, data: { endsAt: new Date(Date.now() - 1_000) } });
    await rooms.activateDueRooms();
    await expect(sealed.seal(roundId, 'ana', 9000)).rejects.toThrow();

    const closed = await prisma.round.findUniqueOrThrow({ where: { id: roundId } });
    // bob y carl empatan en 5.200: gana bob, que sello primero.
    expect(closed).toMatchObject({ status: RoundStatus.CLOSED, result: 'AWARDED', winnerId: 'bob', currentBidderId: 'bob' });
    expect(closed.currentPrice.toString()).toBe('5200');

    const [event] = await events('auction.round.closed.v1');
    expect(event).toMatchObject({ winnerId: 'bob', winningAmount: '5200', mode: 'SEALED' });
    wallet.settle(event as never);
    expect(wallet.debited.get('bob')).toBe(5200);
    expect(wallet.available.get('ana')).toBe(10_000);
    expect(wallet.available.get('carl')).toBe(10_000);

    const results = await sealed.results(roundId, 'carl');
    expect(results.ranking.map((row) => [row.rank, row.amount.toString(), row.winner, row.mine])).toEqual([
      [1, '5200', true, false], [2, '5200', false, true], [3, '4750', false, false],
    ]);
  });

  it('ruleta: solo el dueño gira, sobre una ronda pendiente, y la modalidad queda fija', async () => {
    const { roomId, roundIds: [first, second] } = await seedRoom(prisma, {
      status: RoomStatus.SCHEDULED, startsAt: new Date(Date.now() + 60 * 60_000), rounds: [{ startingPrice: 2000, buyNowPrice: 8000 }, { startingPrice: 1000 }],
    });
    const modes = new DynamicModesService(prisma);
    await expect(modes.spin(roomId, first, 'staff')).rejects.toThrow('Activa las subastas dinamicas');
    await expect(modes.setEnabled(roomId, 'intruso', true)).rejects.toThrow('Solo quien programo');
    await modes.setEnabled(roomId, 'staff', true);

    let result = await modes.spin(roomId, first, 'staff');
    while (result.canSpinAgain) result = await modes.spin(roomId, first, 'staff');
    expect(result.mode).not.toBeNull();
    await expect(modes.spin(roomId, first, 'staff')).rejects.toThrow('ya decidio');
    const decided = await prisma.round.findUniqueOrThrow({ where: { id: first } });
    expect(decided.mode).toBe(result.mode);
    if (decided.mode === RoundMode.DUTCH) expect(decided.currentPrice.toString()).toBe('8000');

    // Desactivarla deshace lo decidido de las rondas que no empezaron.
    await modes.spin(roomId, second, 'staff');
    await modes.setEnabled(roomId, 'staff', false);
    const reverted = await prisma.round.findMany({ where: { roomId }, orderBy: { position: 'asc' } });
    expect(reverted.map((round) => [round.mode, round.modeLockedAt, round.currentPrice.toString()])).toEqual([
      [RoundMode.CLASSIC, null, '2000'], [RoundMode.CLASSIC, null, '1000'],
    ]);

    const room = await rooms.getRoom(roomId, 'staff');
    expect(room).toMatchObject({ isOwner: true, dynamicModesEnabled: false });
    expect(room).not.toHaveProperty('scheduledBy');
  });
});
