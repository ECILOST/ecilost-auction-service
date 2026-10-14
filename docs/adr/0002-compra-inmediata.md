# ADR-0002: Compra inmediata con ECICoin

## Estado

Accepted para HU-24. Cubre también los criterios de concurrencia de HU-25 (un único
adquirente, cierre notificado y reservas de los demás liberadas). Depende de ADR-0001.

## Contexto

HU-24 pide que un estudiante compre el objeto de la ronda activa por un precio fijo, que se
le debite y que la ronda termine en el acto. Hay tres restricciones:

- **Sin transacción distribuida.** Auction y Wallet tienen bases separadas y se hablan por
  RabbitMQ. Wallet no tiene un débito directo: solo cobra al liquidar una ronda
  (`auction.round.closed.v1`), y cobra la reserva `bid:{roundId}:{winnerId}`.
- **Varios actores sobre la misma ronda.** Pueden competir compradores, pujadores, el motor
  automático y el reloj del ciclo de vida, en cualquier número de réplicas.
- **Fuentes del precio.** El backlog atribuye el precio de compra a HU-15/F3.1, pero los
  criterios de HU-15 no lo mencionan. El diagrama de clases sí lo prevé
  (`Round.buyNowPrice`).

## Decisiones

1. **Precio por ronda, opcional, fijado al programar.** `rounds.buyNowPrice`
   (`DECIMAL(18,2)`, nullable) lo envía el funcionario en `POST /rooms`. Debe ser un entero
   mayor que `startingPrice`. `null` significa que la ronda no ofrece compra inmediata. Es la
   única fuente de verdad: el cliente no envía precio ni identidad.
2. **Disponible mientras `currentPrice < buyNowPrice`.** Si las pujas alcanzan el precio de
   compra, la opción desaparece. Siempre se cobra `buyNowPrice`, nunca el precio vigente.
3. **Sin estados nuevos (ADR-0001, decisión 2).** Una compra cierra la ronda igual que su
   vencimiento: `CLOSED`, `result = AWARDED`, `winnerId` = comprador. Lo que la distingue es
   `rounds.closeReason` (`EXPIRED` | `BUY_NOW`). No hay tabla `BuyNowPurchase` ni fila en
   `bids`: la relación 0..1 del diagrama queda en la propia ronda (`winnerId`,
   `currentPrice`, `closedAt`, `closeReason`).
4. **Un solo punto de cierre.** `closeRoundAndAdvance` (`src/rounds/round-lifecycle.ts`) es
   la única secuencia que cierra rondas: ronda `CLOSED`, sala `CLOSED` tras la última o
   siguiente ronda abierta en el mismo instante, y eventos al outbox. La usan tanto el
   vencimiento (`activateDueRooms`) como la compra.
5. **Reservar, cerrar, compensar.** Es el mismo patrón que la puja (`BuyNowService.buy`):
   1. Bajo el candado del estudiante en la ronda (ADR-0001, decisión 9), relee la ronda. Si
      ya la compró él, responde la misma compra (`replayed: true`) sin tocar Wallet.
   2. Rechaza **antes de reservar** si la ronda no está `ACTIVE`, no tiene precio o las
      pujas lo alcanzaron. Así una ronda cerrada nunca recibe una reserva que la
      liquidación ya no liberaría.
   3. Fija la reserva `bid:{roundId}:{buyerId}` en `buyNowPrice`. Si ya lideraba, Wallet
      solo reserva la diferencia.
   4. En una transacción: `SELECT … FOR UPDATE` con `status = ACTIVE`,
      `endsAt > clock_timestamp()`, `buyNowPrice IS NOT NULL` y
      `currentPrice < buyNowPrice`. Pone al comprador como líder a `buyNowPrice` y llama
      a `closeRoundAndAdvance(..., BUY_NOW)`.
   5. Si no hay fila (perdió la carrera), si la base falla o si Wallet no respondió,
      `restoreHold` deshace la reserva. Si seguía liderando, la reserva vuelve al monto con
      que lidera.
6. **Cobro por la liquidación existente.** El cierre publica `auction.round.closed.v1`
   (`winningAmount` = `buyNowPrice`, `closeReason: BUY_NOW`). Con eso:
   - Wallet debita la reserva del comprador y libera las demás (criterio 3 de HU-25).
   - Catalog marca el objeto vendido.
   - Engagement emite `round.closed`, `room.status` y `round.won` sin cambios.
7. **Endpoint.** `POST /rounds/:roundId/buy-now` vive junto a las pujas
   (`BidsController`, rol `STUDENT`, `roundId` UUID v4, sin cuerpo). El cliente envía el
   `roundId` que está viendo, no el de "la ronda activa", para no comprar otro objeto si
   la ronda cambió entre pintar y hacer clic.

## Garantías

| Riesgo | Mecanismo |
|---|---|
| Dos compradores a la vez | La fila de la ronda (`FOR UPDATE` + `status = ACTIVE`): solo el primero la encuentra activa. Vale entre réplicas. |
| Compra contra puja o contra el motor automático | La misma fila serializa. Una puja posterior encuentra la ronda cerrada; una puja que alcanza `buyNowPrice` deja la compra sin efecto. |
| Compra contra vencimiento | Las condiciones `endsAt > now` (compra) y `endsAt <= now` (cierre) se excluyen, y la fila serializa. La ronda se cierra una sola vez. |
| Doble clic, reintento o reconexión | Candado por estudiante. El segundo intento ve la compra hecha y la repite sin reservar. |
| Doble débito | Una reserva por `(ronda, estudiante)` con monto absoluto. Wallet registra un único `DEBIT` por `settle:{roundId}`. |
| Saldo negativo | Wallet decide con un `UPDATE` condicional (`available >= delta`) y `CHECK >= 0`. |
| Notificación falsa | El evento va al outbox en la misma transacción que el cierre: si no confirma, no se publica nada. |

## Consecuencias y límites

- **La reserva y el cierre no son atómicos entre servicios.** Si Wallet no responde en 5 s,
  la compra devuelve 503 y se compensa. Si la compensación tampoco llega, la reserva queda
  desajustada hasta la liquidación de la ronda (igual que en las pujas, ADR-0001).
- **Frontera del vencimiento.** Si el comprador lideraba y la ronda vence mientras su
  reserva está en `buyNowPrice`, puede llegar la liquidación antes que la compensación.
  Wallet hoy cobra `hold.amount`, así que cobraría de más. La corrección decidida
  (2026-10-14) es que Wallet cobre `winningAmount` y devuelva el excedente. Va en un
  cambio aparte de `ecilost-wallet-service`; hasta desplegarla, el riesgo sigue presente.
- **Reserva tardía.** Una reserva que llega a Wallet después de liquidar la ronda quedaría
  retenida. La compra la evita rechazando antes de reservar si la ronda no está activa; el
  riesgo residual es la ventana entre esa lectura y la respuesta de Wallet, acotada por la
  `expiration` de 5 s del mensaje.
- **Wallet no distingue errores.** Responde `{ accepted: false }` también si la billetera
  no existe; la compra lo informa como saldo insuficiente.
- **Outbox con varias réplicas.** Puede publicar un evento dos veces (no hay claim). Los
  consumidores deduplican por `eventId`.
- **Formulario del funcionario.** Todavía no envía `buyNowPrice` (decisión de alcance del
  2026-10-14): por ahora el precio solo se fija vía API.

## Migración y recuperación

- **`20261014000000_round_buy_now`.** Crea el tipo `RoundCloseReason`, agrega
  `buyNowPrice` y `closeReason` (ambos nullable) y marca `EXPIRED` las rondas ya cerradas.
  Es solo de expansión: la versión anterior del servicio ignora las columnas, así que se
  puede desplegar antes que el código.
- **Rollback de esquema** (manual; Prisma no genera migraciones `down`):
  1. Respaldar `pg_dump --table=auction.rounds`.
  2. Ejecutar `ALTER TABLE "rounds" DROP COLUMN "closeReason", DROP COLUMN "buyNowPrice";
     DROP TYPE "RoundCloseReason";`.
  3. Borrar la fila `20261014000000_round_buy_now` de `_prisma_migrations`.

  Pierde los precios configurados y la marca de qué rondas se cerraron por compra. Antes de
  revertir el esquema hay que revertir el código, o `POST /rooms` fallará al escribir
  `buyNowPrice`.
- **Revertir el esquema no revierte compras.** Una compra ya liquidada se corrige como
  operación de negocio, no de esquema:
  1. Devolver ECICoin con una recarga de staff (`POST /wallet/:userId/recharges`) con
     `reference` idempotente, por ejemplo `refund:buy-now:{roundId}`.
  2. Corregir manualmente el estado del objeto en Catalog.
  3. Dejar registro de quién y por qué.

  No se reabre la ronda: una ronda cerrada no vuelve a `ACTIVE`.

## Evidencia

- `src/bids/buy-now.service.ts` (`buy`, `closeByPurchase`) y `src/bids/bids.controller.ts`.
- `src/rounds/round-lifecycle.ts` (`closeRoundAndAdvance`, `enqueueRoundEvent`).
- `src/rooms/rooms.service.ts` (`schedule`, `activateDueRooms`).
- `prisma/migrations/20261014000000_round_buy_now/migration.sql`.
- Pruebas:
  - `src/bids/buy-now.service.spec.ts` (unitarias).
  - `test/buy-now.int-spec.ts`, contra PostgreSQL real: los tres escenarios de HU-24, cinco
    compradores simultáneos, doble envío del mismo estudiante, compra contra puja y contra
    vencimiento (repetidas con orden aleatorio), encadenado de rondas y rollback ante un
    fallo de la base.
