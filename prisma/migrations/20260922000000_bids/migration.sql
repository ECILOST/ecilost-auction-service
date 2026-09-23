CREATE TYPE "RoundStatus" AS ENUM ('SCHEDULED', 'ACTIVE', 'CLOSED');
ALTER TABLE "rounds" ADD COLUMN "status" "RoundStatus" NOT NULL DEFAULT 'SCHEDULED';
CREATE TABLE "bids" (
  "id" TEXT NOT NULL, "roundId" TEXT NOT NULL, "bidderId" TEXT NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "bids_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bids_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "bids_roundId_bidderId_key" ON "bids"("roundId", "bidderId");
CREATE INDEX "bids_roundId_amount_idx" ON "bids"("roundId", "amount");
