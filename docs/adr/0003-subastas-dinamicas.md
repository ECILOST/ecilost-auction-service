# ADR-0003: Subastas dinámicas (ruleta de modalidades)

## Estado

Accepted. Depende de ADR-0001 (reloj del servidor y serialización) y ADR-0002 (compra inmediata).

## Contexto

Se quiere que, antes de cada ronda, una ruleta decida cómo se juega: **holandesa** (el precio
baja y el primero que lo pide se lo lleva), **sobre cerrado** (una puja a ciegas por persona),
**lote misterioso** (solo se ven pistas y el objeto se revela al ganador) o **comodín** (se gira
otra vez). Solo el dueño de la sala puede activarlo.

Restricciones heredadas: no hay transacción distribuida con wallet (solo cobra al liquidar
`auction.round.closed.v1` la reserva `bid:{roundId}:{winnerId}`), varias réplicas compiten por
la misma ronda, y la siguiente ronda se abre en el mismo instante en que cierra la anterior.

## Decisiones

1. **Dueño = `rooms.scheduledBy`.** Solo quien programó la sala activa las subastas dinámicas
   (`PATCH /rooms/:id/dynamic-modes`, o `dynamicModes: true` al programar) y gira la ruleta
   (`POST /rooms/:id/rounds/:roundId/spin`). Las consultas publican `isOwner`, nunca el id.
2. **La ruleta se gira antes de que la ronda empiece**, sobre su fila bloqueada (`FOR UPDATE`).
   El ciclo de vida abre la ronda con la misma fila, así que la abre ya con su modo. Una ronda
   que nadie giró es `CLASSIC`, la subasta de siempre: nada cambia para salas sin ruleta.
3. **El azar es del servidor** (`crypto.randomInt`), con las cuatro opciones equiprobables. El
   comodín no fija modo e incrementa `wildcardSpins`; tras `MAX_WILDCARD_SPINS` (2) la ruleta
   deja de ofrecerlo. El modo, una vez fijado (`modeLockedAt`), no se vuelve a girar.
   Desactivar la ruleta devuelve a `CLASSIC` las rondas que aún no empezaron.
4. **Sin estados nuevos de ronda** (ADR-0001). `rounds.mode` dice cómo se juega y
   `RoundCloseReason.DUTCH_CLAIM` qué cerró una holandesa. Todas cierran por
   `closeRoundAndAdvance`, con los mismos eventos y la misma liquidación.
5. **Holandesa = compra inmediata con precio que baja.** Arranca en `buyNowPrice` (o el doble
   del precio mínimo) y baja hasta el precio mínimo en 20 escalones cada 5 s. El precio lo
   calcula PostgreSQL con su reloj sobre la fila bloqueada. Se reserva el precio cotizado y
   se cierra con el del instante del cierre, que nunca es mayor: wallet cobra `winningAmount`
   y devuelve el excedente. Sin pedido antes del vencimiento, la ronda queda desierta.
6. **Sobre cerrado en tabla aparte (`sealed_bids`)**, única por `(roundId, bidderId)`. Sellar
   reserva el monto con la referencia de siempre y no mueve precio ni líder. Al vencer, bajo el
   bloqueo del cierre, la puja más alta (en empate, la primera) pasa a ser precio y líder, y el
   cierre común adjudica: wallet cobra al ganador y libera a los demás sin saber nada nuevo.
   Mientras está abierta solo se publica el conteo (`auction.round.sealed-bid.placed.v1`); la
   apertura (`GET /rounds/:id/sealed-results`) muestra montos y puestos sin nombres ajenos.
7. **Lote misterioso = subasta ascendente normal** con el objeto oculto. Auction solo publica
   `mode`; catalog oculta el objeto al recibir `auction.round.mode-selected.v1` y lo revela al
   ganador al liquidar (ver ADR-0002 de catalog).
8. **Puja manual, puja automática y compra inmediata solo en `CLASSIC` y `MYSTERY`**, validado
   en el servicio (mensaje claro) y en el SQL que bloquea la fila (también para el motor
   automático). El anti-sniping solo existe donde hay pujas ascendentes.

## Consecuencias

- Migración aditiva `20261016000000_dynamic_auctions`: un tipo, columnas con valor por defecto
  y una tabla. Una versión anterior del servicio sigue funcionando sobre la base migrada.
- Eventos nuevos o con campos nuevos: `auction.round.mode-selected.v1`,
  `auction.round.sealed-bid.placed.v1`, y `mode`/`dutch` en activación y cierre. Los
  consumidores anteriores los ignoran.
- Wallet no cambia.
- Limitación conocida: los objetos de una sala se ven en el catálogo desde que se programa, así
  que un lote misterioso solo es secreto desde que la ruleta lo elige.
