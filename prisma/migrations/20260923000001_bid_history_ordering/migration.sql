DO $$ BEGIN
  CREATE TYPE "BidStatus" AS ENUM ('ACCEPTED', 'REJECTED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "rounds"
  ADD COLUMN IF NOT EXISTS "nextBidSequence" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "bids"
  ADD COLUMN IF NOT EXISTS "sequence" BIGINT,
  ADD COLUMN IF NOT EXISTS "status" "BidStatus" NOT NULL DEFAULT 'ACCEPTED';

WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "roundId" ORDER BY amount, "createdAt", id) AS sequence
  FROM "bids"
)
UPDATE "bids" AS bid
SET "sequence" = ordered.sequence
FROM ordered
WHERE bid.id = ordered.id;

ALTER TABLE "bids" ALTER COLUMN "sequence" SET NOT NULL;
DROP INDEX IF EXISTS "bids_roundId_bidderId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "bids_roundId_sequence_key" ON "bids"("roundId", "sequence");
CREATE INDEX IF NOT EXISTS "bids_roundId_status_sequence_idx" ON "bids"("roundId", "status", "sequence");

UPDATE "rounds" AS round
SET "nextBidSequence" = COALESCE((
  SELECT MAX(bid."sequence") FROM "bids" AS bid WHERE bid."roundId" = round.id
), 0);
