import { BID_INCREMENT } from './bids.service.js';

/**
 * Regla pura del motor de puja automatica (HU-22), sin E/S para poder probarla sola.
 *
 * Es una subasta "proxy": cada estudiante declara su limite y el motor puja por el lo
 * minimo necesario. En vez de simular el ida y vuelta de dos pujas automaticas de 100 en
 * 100, se salta directo al resultado que ese ida y vuelta produciria:
 *
 * - gana el limite mas alto; con limites iguales, el que se declaro primero (`priority`,
 *   asignada por el servidor bajo el bloqueo de la ronda: prioridad de llegada);
 * - paga lo justo para superar al segundo: `min(limiteGanador, limiteSegundo + incremento)`,
 *   o su limite exacto si empatan.
 *
 * El resultado depende solo del estado de la ronda y del conjunto de limites, no del orden
 * en que llegaron los mensajes: mismas entradas, mismo resultado.
 */

export type RoundSnapshot = { startingPrice: number; currentPrice: number; currentBidderId: string | null };
export type DeclaredAutoBid = { bidderId: string; maximumAmount: number; priority: bigint };
export type AutomaticBid = { bidderId: string; amount: number };

type Contender = { bidderId: string; cap: number; priority: bigint; standing: boolean };

/** Lo minimo que alguien que no lidera debe ofrecer para entrar. */
export function minimumToLead(round: RoundSnapshot): number {
  return round.currentBidderId ? round.currentPrice + BID_INCREMENT : round.startingPrice;
}

/** Orden total: limite descendente; con empate gana quien llego antes. */
function ranks(a: Contender, b: Contender): number {
  if (a.cap !== b.cap) return b.cap - a.cap;
  // La puja que ya sostiene el precio llego antes que cualquier limite que solo la iguala.
  if (a.standing !== b.standing) return a.standing ? -1 : 1;
  return a.priority < b.priority ? -1 : a.priority > b.priority ? 1 : 0;
}

/** La siguiente puja que el motor debe hacer, o `null` si nadie puede o necesita pujar. */
export function nextAutomaticBid(round: RoundSnapshot, autoBids: DeclaredAutoBid[]): AutomaticBid | null {
  const leader = round.currentBidderId;
  const entry = minimumToLead(round);

  const challengers: Contender[] = autoBids
    .filter((auto) => auto.bidderId !== leader && auto.maximumAmount >= entry)
    .map((auto) => ({ bidderId: auto.bidderId, cap: auto.maximumAmount, priority: auto.priority, standing: false }));
  if (challengers.length === 0) return null;

  const contenders = [...challengers];
  if (leader) {
    const leaderAuto = autoBids.find((auto) => auto.bidderId === leader);
    const cap = Math.max(round.currentPrice, leaderAuto?.maximumAmount ?? 0);
    // Si su limite no pasa del precio, compite solo con la puja que ya hizo.
    const standing = cap === round.currentPrice;
    contenders.push({ bidderId: leader, cap, priority: leaderAuto?.priority ?? -1n, standing });
  }
  contenders.sort(ranks);

  const [winner, runnerUp] = contenders;
  const amount = !runnerUp
    ? entry
    : winner.cap === runnerUp.cap
      ? winner.cap
      : Math.min(winner.cap, runnerUp.cap + BID_INCREMENT);

  if (winner.bidderId === leader) {
    // El lider sube su propia puja solo si alguien podia superarlo.
    return amount > round.currentPrice ? { bidderId: leader, amount } : null;
  }
  return { bidderId: winner.bidderId, amount: Math.max(amount, entry) };
}
