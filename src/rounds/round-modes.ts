import { randomInt } from 'node:crypto';
import { Prisma, RoundMode } from '../generated/prisma/client.js';

/**
 * Reglas de las subastas dinamicas (ADR-0003). Todo lo que aqui se decide es puro: el servicio
 * lo aplica sobre la fila bloqueada de la ronda.
 */

/** Lo que puede salir en la ruleta. El comodin no es un modo: obliga a girar otra vez. */
export const SpinSegment = {
  DUTCH: 'DUTCH',
  SEALED: 'SEALED',
  MYSTERY: 'MYSTERY',
  WILDCARD: 'WILDCARD',
} as const;
export type SpinSegment = (typeof SpinSegment)[keyof typeof SpinSegment];

/**
 * Comodines seguidos que admite una ronda. Alcanzado el limite, la ruleta ya no ofrece
 * comodin: un funcionario no puede quedarse girando para siempre.
 */
export const MAX_WILDCARD_SPINS = 2;

/** Modos en los que se puja hacia arriba como siempre (puja manual, automatica y compra inmediata). */
export const ASCENDING_MODES: readonly RoundMode[] = [RoundMode.CLASSIC, RoundMode.MYSTERY];

export const acceptsAscendingBids = (mode: RoundMode) => ASCENDING_MODES.includes(mode);

/** Segmentos disponibles, todos con la misma probabilidad. */
export function availableSegments(wildcardSpins: number): SpinSegment[] {
  const modes: SpinSegment[] = [SpinSegment.DUTCH, SpinSegment.SEALED, SpinSegment.MYSTERY];
  return wildcardSpins < MAX_WILDCARD_SPINS ? [...modes, SpinSegment.WILDCARD] : modes;
}

/**
 * Gira la ruleta. El azar es del servidor (`crypto.randomInt`, no `Math.random`): el cliente
 * solo anima el resultado que recibe y no puede elegirlo.
 */
export function spinRoulette(wildcardSpins: number, pick: (max: number) => number = randomInt): SpinSegment {
  const segments = availableSegments(wildcardSpins);
  return segments[pick(segments.length)];
}

export const modeOfSegment = (segment: SpinSegment): RoundMode | null =>
  segment === SpinSegment.WILDCARD ? null : RoundMode[segment];

/** Cada cuanto baja el precio de una ronda holandesa. */
export const DUTCH_INTERVAL_SECONDS = 5;
/** En cuantos pasos va del precio inicial al minimo. 20 pasos de 5 s caben en una ronda de 3 min. */
export const DUTCH_STEPS = 20;
/** El escalon se redondea a este multiplo, como el incremento de las pujas. */
const DUTCH_STEP_UNIT = 100;

export type DutchSchedule = {
  startPrice: Prisma.Decimal;
  floorPrice: Prisma.Decimal;
  step: Prisma.Decimal;
  intervalSeconds: number;
};

/**
 * Precios de una ronda holandesa a partir de lo que el funcionario fijo al programarla:
 * arranca en la compra inmediata (o el doble del precio minimo si no la definio) y nunca baja
 * del precio minimo, que sigue siendo lo menos que el funcionario acepta por el objeto.
 */
export function dutchSchedule(round: { startingPrice: Prisma.Decimal; buyNowPrice: Prisma.Decimal | null }): DutchSchedule {
  const floorPrice = round.startingPrice;
  const startPrice = round.buyNowPrice && round.buyNowPrice.gt(floorPrice) ? round.buyNowPrice : floorPrice.times(2);
  const span = startPrice.minus(floorPrice);
  const rawStep = span.dividedBy(DUTCH_STEPS).dividedBy(DUTCH_STEP_UNIT).ceil().times(DUTCH_STEP_UNIT);
  const step = rawStep.lt(DUTCH_STEP_UNIT) ? new Prisma.Decimal(DUTCH_STEP_UNIT) : rawStep;
  return { startPrice, floorPrice, step, intervalSeconds: DUTCH_INTERVAL_SECONDS };
}

/** Precio holandes a los `elapsedMs` de abierta la ronda. Lo usa la vista; el cobro lo calcula SQL. */
export function dutchPriceAt(schedule: DutchSchedule, elapsedMs: number): Prisma.Decimal {
  const steps = Math.max(0, Math.floor(elapsedMs / 1000 / schedule.intervalSeconds));
  const price = schedule.startPrice.minus(schedule.step.times(steps));
  return price.lt(schedule.floorPrice) ? schedule.floorPrice : price;
}
