# Integration events

Eventos versionados en el exchange topic `ecilost.events`. Auction los escribe en `outbox_events` dentro de la misma transacción que el cambio y `OutboxPublisher` los publica cada 200 ms. Wallet y Catalog se integran por mensajes, sin transacción distribuida ni acceso a sus bases de datos. Las decisiones de tiempo y concurrencia están en `docs/adr/0001-reloj-del-servidor-y-serializacion-de-pujas.md`.

## Eventos publicados

| Evento | Cuándo | Consumidores | Payload (además de `eventId`, `eventType`, `occurredAt`, `roomId`, `roundId`, `position`) |
|---|---|---|---|
| `auction.round.activated.v1` | Se abre una ronda: la primera al iniciar la sala, o la siguiente al cerrar la anterior. | Engagement (socket `round.activated`) | `roomStatus` (`ACTIVE`), `currentPrice`, `currentBidderId`, `startedAt`, `endsAt`, `maximumEndsAt`, `entries` |
| `auction.round.closed.v1` | Vence una ronda o una compra inmediata la cierra (HU-24). | Engagement (`round.closed`, `round.won`, bandeja), Wallet (liquidación), Catalog | `roomStatus` (`CLOSED` si era la última ronda; si no, `ACTIVE`), `currentPrice`, `currentBidderId`, `closedAt`, `result`, `winnerId`, `winningAmount`, `closeReason` (`EXPIRED` o `BUY_NOW`) |
| `auction.bid.accepted.v1` | Se acepta una puja manual o automática. | Engagement (`round.price`, `bid.outbid`) | `bidId`, `bidderId`, `amount`, `previousBidderId`, `previousPrice`, `currentBidderId`, `currentPrice`, `endsAt`, `previousEndsAt`, `extended` (anti-sniping), `automatic`, `sequence` |
| `catalog.round-reservation.cancelled.v1` | Una sala no llegó a guardarse tras reservar en Catalog. | Catalog | `rounds[{ roundId, entries }]` |

`roomStatus`, `previousEndsAt`, `extended`, `automatic` y `closeReason` son campos agregados: los consumidores anteriores los ignoran.

Una compra inmediata no tiene evento propio: es un `auction.round.closed.v1` con `result: AWARDED`, `winnerId` = comprador, `currentPrice` = `winningAmount` = precio de compra y `closeReason: BUY_NOW`, seguido del `auction.round.activated.v1` de la siguiente ronda si la hay. Así Wallet cobra y libera, Catalog vende y Engagement avisa sin cambios. El outbox se escribe en la misma transacción que el cierre: no se publica nada de una compra que no quedó guardada.

## Solicitudes RPC (`replyTo` + `correlationId`, timeout 5 s)

| Routing key | Respuesta | Uso |
|---|---|---|
| `wallet.bid-hold.requested.v1` | `{ accepted }` | Fija el monto reservado de `bid:{roundId}:{userId}`. La compra inmediata la fija en el precio de compra antes de cerrar la ronda. |
| `wallet.bid-release.requested.v1` | `{ accepted }` | Libera la reserva si su monto coincide (versionada). |
| `wallet.balance.requested.v1` | `{ accepted, availableBalance }` | Chequeo orientativo del límite de una puja automática (HU-22). |
| `catalog.round-reservation.requested.v1` | `{ accepted }` | Reserva los objetos y lotes de una sala al programarla. |
