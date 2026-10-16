-- Subastas dinamicas (ver docs/adr/0003-subastas-dinamicas.md). Solo agrega tipos, columnas y
-- una tabla: la version anterior del servicio las ignora y toda ronda existente sigue siendo
-- CLASSIC, que es la subasta ascendente de siempre.
CREATE TYPE "RoundMode" AS ENUM ('CLASSIC', 'DUTCH', 'SEALED', 'MYSTERY');

-- La ronda holandesa se cierra cuando alguien pulsa "Lo quiero" al precio vigente.
ALTER TYPE "RoundCloseReason" ADD VALUE 'DUTCH_CLAIM';

ALTER TABLE "rooms"
  ADD COLUMN "dynamicModesEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "rounds"
  ADD COLUMN "mode" "RoundMode" NOT NULL DEFAULT 'CLASSIC',
  ADD COLUMN "modeLockedAt" TIMESTAMP(3),
  ADD COLUMN "wildcardSpins" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "dutchStartPrice" DECIMAL(18,2),
  ADD COLUMN "dutchFloorPrice" DECIMAL(18,2),
  ADD COLUMN "dutchStep" DECIMAL(18,2),
  ADD COLUMN "dutchIntervalSeconds" INTEGER;

-- Sobre cerrado: una sola puja por estudiante y ronda. Vive aparte de "bids" porque una puja
-- sellada no mueve el precio ni el lider de la ronda hasta que esta cierra.
CREATE TABLE "sealed_bids" (
  "id" TEXT NOT NULL,
  "roundId" TEXT NOT NULL,
  "bidderId" TEXT NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sealed_bids_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sealed_bids_roundId_bidderId_key" ON "sealed_bids"("roundId", "bidderId");
CREATE INDEX "sealed_bids_roundId_amount_createdAt_idx" ON "sealed_bids"("roundId", "amount" DESC, "createdAt");

ALTER TABLE "sealed_bids"
  ADD CONSTRAINT "sealed_bids_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
