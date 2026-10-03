-- Puja automatica con limite maximo (HU-22).
CREATE TYPE "AutoBidStopReason" AS ENUM ('LIMIT_REACHED', 'INSUFFICIENT_FUNDS');

ALTER TABLE "rounds" ADD COLUMN "nextAutoBidPriority" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "bids" ADD COLUMN "automatic" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "auto_bids" (
  "id" TEXT NOT NULL,
  "roundId" TEXT NOT NULL,
  "bidderId" TEXT NOT NULL,
  "maximumAmount" DECIMAL(18,2) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "priority" BIGINT NOT NULL,
  "stoppedReason" "AutoBidStopReason",
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "auto_bids_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "auto_bids_roundId_bidderId_key" ON "auto_bids"("roundId", "bidderId");
CREATE INDEX "auto_bids_roundId_enabled_idx" ON "auto_bids"("roundId", "enabled");
ALTER TABLE "auto_bids" ADD CONSTRAINT "auto_bids_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
