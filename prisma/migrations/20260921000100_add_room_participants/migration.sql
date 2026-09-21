ALTER TABLE "rooms"
ADD COLUMN "admittedCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "room_participants" (
  "id" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "admittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "room_participants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "room_participants_roomId_fkey"
    FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "room_participants_roomId_userId_key"
ON "room_participants"("roomId", "userId");

CREATE INDEX "room_participants_userId_idx"
ON "room_participants"("userId");
