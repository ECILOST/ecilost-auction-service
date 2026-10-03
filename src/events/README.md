# Integration events

Eventos versionados en el exchange topic `ecilost.events`. Auction los escribe en `outbox_events` dentro de la misma transacción que el cambio y `OutboxPublisher` los publica cada 200 ms. Wallet y Catalog se integran por mensajes, sin transacción distribuida ni acceso a sus bases de datos. Las decisiones de tiempo y concurrencia están en `docs/adr/0001-reloj-del-servidor-y-serializacion-de-pujas.md`.

## Eventos publicados

| Evento | Cuándo | Consumidores | Payload (además de `eventId`, `eventType`, `occurredAt`, `roomId`, `roundId`, `position`) |
|---|---|---|---|
| `auction.round.activated.v1` | Se abre una ronda: la primera al iniciar la sala, o la siguiente al cerrar la anterior. | Engagement (socket `round.activated`) | `roomStatus` (`ACTIVE`), `currentPrice`, `currentBidderId`, `startedAt`, `endsAt`, `maximumEndsAt`, `entries` |
| `auction.round.closed.v1` | Vence una ronda. | Engagement (`round.closed`, `round.won`, bandeja), Wallet (liquidación), Catalog | `roomStatus` (`CLOSED` si era la última ronda; si no, `ACTIVE`), `currentPrice`, `currentBidderId`, `closedAt`, `result`, `winnerId`, `winningAmount` |
| `auction.bid.accepted.v1` | Se acepta una puja manual o automática. | Engagement (`round.price`, `bid.outbid`) | `bidId`, `bidderId`, `amount`, `previousBidderId`, `previousPrice`, `currentBidderId`, `currentPrice`, `endsAt`, `previousEndsAt`, `extended` (anti-sniping), `automatic`, `sequence` |
| `catalog.round-reservation.cancelled.v1` | Una sala no llegó a guardarse tras reservar en Catalog. | Catalog | `rounds[{ roundId, entries }]` |

`roomStatus`, `previousEndsAt`, `extended` y `automatic` son campos agregados: los consumidores anteriores los ignoran.

## Solicitudes RPC (`replyTo` + `correlationId`, timeout 5 s)

| Routing key | Respuesta | Uso |
|---|---|---|
| `wallet.bid-hold.requested.v1` | `{ accepted }` | Fija el monto reservado de `bid:{roundId}:{userId}`. |
| `wallet.bid-release.requested.v1` | `{ accepted }` | Libera la reserva si su monto coincide (versionada). |
| `wallet.balance.requested.v1` | `{ accepted, availableBalance }` | Chequeo orientativo del límite de una puja automática (HU-22). |
| `catalog.round-reservation.requested.v1` | `{ accepted }` | Reserva los objetos y lotes de una sala al programarla. |
