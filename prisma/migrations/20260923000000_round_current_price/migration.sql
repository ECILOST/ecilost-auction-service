ALTER TABLE "rounds"
  ADD COLUMN "currentPrice" DECIMAL(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN "currentBidderId" TEXT;
