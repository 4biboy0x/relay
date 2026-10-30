CREATE TABLE "RealtimeDemo" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "value" VARCHAR(240) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RealtimeDemo_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RealtimeDemo_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "RealtimeDemo_ownerId_createdAt_idx"
  ON "RealtimeDemo"("ownerId", "createdAt" DESC);
