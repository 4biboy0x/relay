ALTER TABLE "Reel"
  ADD COLUMN "storageDeletedAt" timestamp(3);

CREATE INDEX "Reel_storageDeletedAt_deletedAt_idx"
  ON "Reel" ("storageDeletedAt", "deletedAt");
