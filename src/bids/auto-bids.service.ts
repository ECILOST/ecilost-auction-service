import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AutoBidStopReason, BidStatus, Prisma, RoundStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WalletHoldClient } from '../events/wallet-hold.client.js';
import { BidsService, holdReference, minimumBid } from './bids.service.js';
import { minimumToLead, nextAutomaticBid } from './auto-bid.engine.js';

/** Tope de pujas por resolucion: el motor converge en una o dos; esto evita un bucle por un bug. */
const MAX_ENGINE_STEPS = 10;

export type AutoBidView = {
  roundId: string;
  enabled: boolean;
  maximumAmount: Prisma.Decimal | null;
  stopped: boolean;
  stoppedReason: AutoBidStopReason | null;
};

/**
 * Puja automatica con limite maximo (HU-22).
 *
 * Declarar un limite no compromete fondos: wallet solo reserva, en cada disparo, el monto de
 * la puja que el motor llega a hacer, igual que con una puja manual. Asi el ganador paga el
 * precio de cierre y no su limite. Al declarar se comprueba que el limite no pase del saldo
 * disponible, pero esa comprobacion solo orienta; la que manda es la reserva de cada disparo:
 * si no alcanza, esa puja automatica se detiene y no se compromete nada.
 *
 * Serializacion: el orden de llegada lo asigna PostgreSQL bajo el bloqueo de la fila de la
 * ronda (`nextAutoBidPriority`), y cada puja del motor entra con una comparacion contra el
 * precio y el lider que uso para calcularla. Varias instancias pueden resolver la misma ronda
 * a la vez: solo una escritura gana y las demas recalculan sobre el estado nuevo.
 */
@Injectable()
export class AutoBidsService {
  private readonly logger = new Logger(AutoBidsService.name);
  /** Una resolucion por ronda a la vez en este proceso; lo pedido mientras tanto se funde en una mas. */
  private readonly resolving = new Map<string, { again: boolean; done: Promise<void> }>();
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletHoldClient,
    private readonly bids: BidsService,
  ) {}

  async configure(roundId: string, bidderId: string, input: { enabled: boolean; maximumAmount?: number }): Promise<AutoBidView> {
    const round = await this.prisma.round.findUnique({
      where: { id: roundId },
      select: {
        status: true, startingPrice: true, currentPrice: true, currentBidderId: true,
        room: { select: { participants: { where: { userId: bidderId }, select: { id: true }, take: 1 } } },
      },
    });
    if (!round) throw new NotFoundException('La ronda no existe.');
    if (round.room.participants.length === 0) throw new ForbiddenException('Debes estar admitido en la sala para pujar.');
    if (round.status !== RoundStatus.ACTIVE) throw new ConflictException('La ronda no esta activa.');

    if (!input.enabled) {
      await this.prisma.autoBid.updateMany({ where: { roundId, bidderId }, data: { enabled: false } });
      this.logger.log(`round=${roundId} bidder=${bidderId} auto-bid disabled`);
      return this.view(roundId, bidderId);
    }

    const maximum = input.maximumAmount;
    if (maximum === undefined || !Number.isInteger(maximum) || maximum <= 0) {
      throw new BadRequestException('El limite maximo debe ser un numero entero positivo.');
    }
    const leading = round.currentBidderId === bidderId;
    // Quien lidera puede fijar su limite desde el precio vigente; los demas, desde la puja minima.
    const floor = leading ? round.currentPrice : minimumBid(round);
    if (floor.gt(maximum)) throw new ConflictException(`El limite debe ser de al menos ${floor.toString()} ECICoin.`);

    // Lo que ya tiene reservado en esta ronda (si lidera) cuenta: el motor lo reemplazaria.
    const available = await this.wallet.availableBalance(bidderId);
    const committedHere = leading ? Number(round.currentPrice) : 0;
    if (maximum > available + committedHere) {
      throw new ConflictException('No tienes ECICoin disponibles suficientes para ese limite.');
    }

    await this.prisma.$transaction(async (tx) => {
      // Bloquea la ronda y toma el siguiente turno: es la "prioridad de llegada" del desempate.
      const [turn] = await tx.$queryRaw<Array<{ priority: bigint }>>`
        UPDATE "rounds" SET "nextAutoBidPriority" = "nextAutoBidPriority" + 1
        WHERE id = ${roundId} AND status = CAST(${RoundStatus.ACTIVE} AS "RoundStatus")
        RETURNING "nextAutoBidPriority" AS priority
      `;
      if (!turn) throw new ConflictException('La ronda no esta activa.');
      const existing = await tx.autoBid.findUnique({ where: { roundId_bidderId: { roundId, bidderId } } });
      // Repetir la misma declaracion no hace perder el turno; cambiar el limite si.
      const unchanged = existing?.enabled && existing.stoppedReason === null && existing.maximumAmount.eq(maximum);
      if (unchanged) return;
      const data = { maximumAmount: new Prisma.Decimal(maximum), enabled: true, stoppedReason: null, priority: turn.priority };
      await tx.autoBid.upsert({
        where: { roundId_bidderId: { roundId, bidderId } },
        create: { id: randomUUID(), roundId, bidderId, ...data },
        update: data,
      });
    });
    this.logger.log(`round=${roundId} bidder=${bidderId} auto-bid declared maximum=${maximum}`);

    await this.resolve(roundId);
    return this.view(roundId, bidderId);
  }

  async view(roundId: string, bidderId: string): Promise<AutoBidView> {
    const autoBid = await this.prisma.autoBid.findUnique({
      where: { roundId_bidderId: { roundId, bidderId } },
      select: { enabled: true, maximumAmount: true, stoppedReason: true },
    });
    return {
      roundId,
      enabled: autoBid?.enabled ?? false,
      maximumAmount: autoBid?.maximumAmount ?? null,
      stopped: (autoBid?.stoppedReason ?? null) !== null,
      stoppedReason: autoBid?.stoppedReason ?? null,
    };
  }

  /**
   * Hace que el motor responda en la ronda hasta que nadie mas pueda o necesite pujar. Las
   * llamadas simultaneas sobre la misma ronda en este proceso se funden en una.
   */
  resolve(roundId: string): Promise<void> {
    const current = this.resolving.get(roundId);
    if (current) {
      current.again = true;
      return current.done;
    }
    const state = { again: false, done: Promise.resolve() };
    state.done = (async () => {
      try {
        do {
          state.again = false;
          await this.resolveOnce(roundId);
        } while (state.again);
      } catch (error) {
        this.logger.error(`round=${roundId} el motor de puja automatica fallo; el barrido lo reintentara: ${String(error)}`);
      } finally {
        this.resolving.delete(roundId);
      }
    })();
    this.resolving.set(roundId, state);
    return state.done;
  }

  /**
   * Barrido de respaldo que corre con el reloj del ciclo de vida: rondas activas con alguna
   * puja automatica que todavia podria responder. Cubre una resolucion que se corto (un
   * reinicio, wallet sin responder) y las pujas que llegaron por otra instancia.
   */
  async resolvePending() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const rounds = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT DISTINCT round.id FROM "rounds" AS round
        JOIN "auto_bids" AS auto ON auto."roundId" = round.id
        WHERE round.status = CAST(${RoundStatus.ACTIVE} AS "RoundStatus")
          AND round."endsAt" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
          AND auto.enabled AND auto."stoppedReason" IS NULL
          AND auto."bidderId" IS DISTINCT FROM round."currentBidderId"
      `;
      await Promise.all(rounds.map((round) => this.resolve(round.id)));
    } finally {
      this.sweeping = false;
    }
  }

  private async resolveOnce(roundId: string) {
    for (let step = 0; step < MAX_ENGINE_STEPS; step += 1) {
      const round = await this.prisma.round.findUnique({
        where: { id: roundId },
        select: {
          status: true, startingPrice: true, currentPrice: true, currentBidderId: true,
          autoBids: { where: { enabled: true, stoppedReason: null }, select: { id: true, bidderId: true, maximumAmount: true, priority: true } },
        },
      });
      if (!round || round.status !== RoundStatus.ACTIVE) return;
      const snapshot = {
        startingPrice: Number(round.startingPrice), currentPrice: Number(round.currentPrice), currentBidderId: round.currentBidderId,
      };
      await this.stopOutOfReach(roundId, snapshot);

      const autoBids = round.autoBids.map((auto) => ({ ...auto, maximumAmount: Number(auto.maximumAmount) }));
      const next = nextAutomaticBid(snapshot, autoBids);
      if (!next) return;
      const auto = autoBids.find((candidate) => candidate.bidderId === next.bidderId);
      if (!auto) return;

      // Reservar, pujar y deshacer van bajo el candado del estudiante por quien puja el motor.
      const outcome = await this.bids.withBidderLock(roundId, next.bidderId, async () => {
        let held: boolean;
        try {
          held = await this.wallet.hold(next.bidderId, holdReference(roundId, next.bidderId), next.amount);
        } catch (error) {
          // Sin respuesta no se sabe si reservo: se deshace por si acaso y se reintenta en el barrido.
          await this.bids.restoreHold(roundId, next.bidderId, next.amount).catch(() => undefined);
          throw error;
        }
        if (!held) return { kind: 'insufficient' as const };
        const result = await this.bids.placeAutomatic(roundId, next.bidderId, new Prisma.Decimal(next.amount), {
          price: round.currentPrice, leaderId: round.currentBidderId,
        });
        if (!result || result.status !== BidStatus.ACCEPTED) {
          // Otra puja se adelanto (o la ronda cerro): se deshace la reserva y se recalcula.
          await this.bids.restoreHold(roundId, next.bidderId, next.amount);
          return { kind: 'lost' as const };
        }
        return { kind: 'placed' as const, placed: result };
      });

      if (outcome.kind === 'insufficient') {
        // HU-22: un disparo sin saldo se rechaza, no compromete fondos y la puja automatica se detiene.
        await this.prisma.autoBid.updateMany({
          where: { id: auto.id, priority: auto.priority, stoppedReason: null },
          data: { stoppedReason: AutoBidStopReason.INSUFFICIENT_FUNDS },
        });
        this.logger.warn(`round=${roundId} bidder=${next.bidderId} auto-bid stopped: INSUFFICIENT_FUNDS amount=${next.amount}`);
        continue;
      }
      if (outcome.kind === 'lost') {
        this.logger.debug(`round=${roundId} bidder=${next.bidderId} auto-bid lost the race; recalculating`);
        continue;
      }
      const { placed } = outcome;
      this.bids.logAccepted(placed, true);
      await this.bids.releaseOutbid(placed);
    }
    this.logger.warn(`round=${roundId} el motor de puja automatica no convergio en ${MAX_ENGINE_STEPS} pasos`);
  }

  /** Los precios solo suben: un limite que ya no alcanza para entrar no volvera a alcanzar. */
  private async stopOutOfReach(roundId: string, round: { startingPrice: number; currentPrice: number; currentBidderId: string | null }) {
    const stopped = await this.prisma.autoBid.updateMany({
      where: {
        roundId, enabled: true, stoppedReason: null,
        maximumAmount: { lt: minimumToLead(round) },
        ...(round.currentBidderId ? { NOT: { bidderId: round.currentBidderId } } : {}),
      },
      data: { stoppedReason: AutoBidStopReason.LIMIT_REACHED },
    });
    if (stopped.count) this.logger.log(`round=${roundId} ${stopped.count} auto-bid(s) stopped: LIMIT_REACHED`);
  }
}
