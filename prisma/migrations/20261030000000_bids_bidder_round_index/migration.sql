-- "Mi mejor puja" por ronda en el detalle de la sala (GET /rooms/:id) filtra por pujador y por
-- las rondas de la sala. Sin indice por pujador, Postgres leia todas las pujas de esas rondas y
-- descartaba las ajenas (pruebas de carga, ecilost-load-tests/docs/RESULTADOS-2026-10-30.md, C4).
CREATE INDEX IF NOT EXISTS "bids_bidderId_roundId_idx" ON "bids"("bidderId", "roundId");
