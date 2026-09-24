ALTER TABLE "rounds"
  ADD COLUMN "startedAt" TIMESTAMP(3),
  ADD COLUMN "endsAt" TIMESTAMP(3),
  ADD COLUMN "maximumEndsAt" TIMESTAMP(3);

CREATE INDEX "rounds_status_endsAt_idx" ON "rounds"("status", "endsAt");
