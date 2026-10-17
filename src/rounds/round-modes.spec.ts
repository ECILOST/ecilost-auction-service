import { describe, expect, it } from 'vitest';
import { Prisma, RoundMode } from '../generated/prisma/client.js';
import {
  acceptsAscendingBids, availableSegments, DUTCH_INTERVAL_SECONDS, dutchPriceAt, dutchSchedule, MAX_WILDCARD_SPINS,
  modeOfSegment, SpinSegment, spinRoulette,
} from './round-modes.js';

const decimal = (value: number) => new Prisma.Decimal(value);

describe('ruleta de modalidades (ADR-0003)', () => {
  it('ofrece las tres modalidades y el comodin, todas con la misma probabilidad', () => {
    expect(availableSegments(0)).toEqual([SpinSegment.DUTCH, SpinSegment.SEALED, SpinSegment.MYSTERY, SpinSegment.WILDCARD]);
    // El indice lo elige el azar del servidor; cada segmento ocupa una sola posicion.
    expect([0, 1, 2, 3].map((index) => spinRoulette(0, () => index))).toEqual(availableSegments(0));
  });

  it('tras el limite de comodines seguidos la ruleta ya no ofrece comodin', () => {
    expect(availableSegments(MAX_WILDCARD_SPINS)).not.toContain(SpinSegment.WILDCARD);
    expect(availableSegments(MAX_WILDCARD_SPINS - 1)).toContain(SpinSegment.WILDCARD);
    // Aunque el azar apunte a la ultima posicion, cae en una modalidad.
    expect(spinRoulette(MAX_WILDCARD_SPINS, (max) => max - 1)).toBe(SpinSegment.MYSTERY);
  });

  it('el comodin no es un modo: obliga a girar otra vez', () => {
    expect(modeOfSegment(SpinSegment.WILDCARD)).toBeNull();
    expect(modeOfSegment(SpinSegment.DUTCH)).toBe(RoundMode.DUTCH);
    expect(modeOfSegment(SpinSegment.SEALED)).toBe(RoundMode.SEALED);
    expect(modeOfSegment(SpinSegment.MYSTERY)).toBe(RoundMode.MYSTERY);
  });

  it('solo la clasica y el lote misterioso reciben pujas ascendentes', () => {
    expect(acceptsAscendingBids(RoundMode.CLASSIC)).toBe(true);
    expect(acceptsAscendingBids(RoundMode.MYSTERY)).toBe(true);
    expect(acceptsAscendingBids(RoundMode.DUTCH)).toBe(false);
    expect(acceptsAscendingBids(RoundMode.SEALED)).toBe(false);
  });
});

describe('precio holandes (ADR-0003)', () => {
  it('arranca en la compra inmediata y baja hasta el precio minimo en escalones de 100', () => {
    const schedule = dutchSchedule({ startingPrice: decimal(2000), buyNowPrice: decimal(8000) });
    expect(schedule.startPrice.toString()).toBe('8000');
    expect(schedule.floorPrice.toString()).toBe('2000');
    expect(schedule.step.toString()).toBe('300');
    expect(schedule.intervalSeconds).toBe(DUTCH_INTERVAL_SECONDS);
  });

  it('sin compra inmediata arranca en el doble del precio minimo', () => {
    const schedule = dutchSchedule({ startingPrice: decimal(3000), buyNowPrice: null });
    expect(schedule.startPrice.toString()).toBe('6000');
    expect(schedule.step.toString()).toBe('200');
  });

  it('el escalon nunca es menor que 100, aunque el rango sea corto', () => {
    expect(dutchSchedule({ startingPrice: decimal(10), buyNowPrice: null }).step.toString()).toBe('100');
  });

  it('baja un escalon por intervalo y nunca pasa del minimo', () => {
    const schedule = dutchSchedule({ startingPrice: decimal(2000), buyNowPrice: decimal(8000) });
    expect(dutchPriceAt(schedule, 0).toString()).toBe('8000');
    expect(dutchPriceAt(schedule, 4_999).toString()).toBe('8000');
    expect(dutchPriceAt(schedule, 5_000).toString()).toBe('7700');
    expect(dutchPriceAt(schedule, 60_000).toString()).toBe('4400');
    expect(dutchPriceAt(schedule, 10 * 60_000).toString()).toBe('2000');
  });
});
