import { describe, expect, it } from 'vitest';
import { nextAutomaticBid, type DeclaredAutoBid, type RoundSnapshot } from './auto-bid.engine.js';

const round = (currentPrice: number, currentBidderId: string | null, startingPrice = 1000): RoundSnapshot => ({
  startingPrice, currentPrice, currentBidderId,
});
const auto = (bidderId: string, maximumAmount: number, priority: number): DeclaredAutoBid => ({
  bidderId, maximumAmount, priority: BigInt(priority),
});

/** Aplica el motor hasta que no tenga nada que hacer, como lo hace AutoBidsService. */
function settle(start: RoundSnapshot, autoBids: DeclaredAutoBid[]) {
  let state = start;
  for (let step = 0; step < 10; step += 1) {
    const next = nextAutomaticBid(state, autoBids);
    if (!next) return state;
    expect(next.amount).toBeGreaterThan(state.currentBidderId ? state.currentPrice : state.startingPrice - 1);
    state = { ...state, currentPrice: next.amount, currentBidderId: next.bidderId };
  }
  throw new Error('El motor no convergio');
}

describe('nextAutomaticBid (HU-22)', () => {
  it('responde por el estudiante cuando otro supera el precio, por lo minimo', () => {
    expect(nextAutomaticBid(round(20000, 'bob'), [auto('alice', 50000, 1)])).toEqual({ bidderId: 'alice', amount: 20100 });
  });

  it('no puja por encima del limite declarado', () => {
    expect(nextAutomaticBid(round(50000, 'bob'), [auto('alice', 50000, 1)])).toBeNull();
    expect(nextAutomaticBid(round(49950, 'bob'), [auto('alice', 50000, 1)])).toBeNull();
  });

  it('no hace nada mientras el estudiante ya lidera y nadie puede superarlo', () => {
    expect(nextAutomaticBid(round(20000, 'alice'), [auto('alice', 50000, 1)])).toBeNull();
  });

  it('la primera puja automatica de la ronda entra por el precio minimo', () => {
    expect(nextAutomaticBid(round(1000, null), [auto('alice', 5000, 1)])).toEqual({ bidderId: 'alice', amount: 1000 });
  });

  it('entre dos automaticas gana el limite mayor pagando el segundo mas el incremento', () => {
    const final = settle(round(1000, null), [auto('alice', 3000, 1), auto('bob', 8000, 2)]);
    expect(final).toMatchObject({ currentBidderId: 'bob', currentPrice: 3100 });
  });

  it('con limites iguales gana quien lo declaro primero, al precio del limite', () => {
    const final = settle(round(1000, 'carol'), [auto('alice', 100000, 2), auto('bob', 100000, 1)]);
    expect(final).toMatchObject({ currentBidderId: 'bob', currentPrice: 100000 });
  });

  it('el lider con limite conserva la ronda ante un empate si declaro primero', () => {
    const final = settle(round(1600, 'alice'), [auto('alice', 3000, 1), auto('bob', 3000, 2)]);
    expect(final).toMatchObject({ currentBidderId: 'alice', currentPrice: 3000 });
  });

  it('el resultado no depende del orden en que llegan las declaraciones', () => {
    const autoBids = [auto('alice', 7000, 3), auto('bob', 9000, 1), auto('carol', 9000, 2), auto('dan', 4000, 4)];
    const results = [autoBids, [...autoBids].reverse(), [autoBids[2], autoBids[0], autoBids[3], autoBids[1]]].map((order) =>
      settle(round(1000, null), order),
    );
    for (const result of results) expect(result).toEqual(results[0]);
    expect(results[0]).toMatchObject({ currentBidderId: 'bob', currentPrice: 9000 });
  });

  it('nunca deja el precio por encima del limite de quien queda liderando', () => {
    for (let low = 1000; low <= 6000; low += 700) {
      for (let high = low; high <= 9000; high += 900) {
        const final = settle(round(1000, null), [auto('a', low, 1), auto('b', high, 2)]);
        const leaderLimit = final.currentBidderId === 'a' ? low : high;
        expect(final.currentPrice).toBeLessThanOrEqual(leaderLimit);
      }
    }
  });
});
