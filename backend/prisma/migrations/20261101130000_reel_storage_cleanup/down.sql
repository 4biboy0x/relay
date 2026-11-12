DROP INDEX "Reel_storageDeletedAt_deletedAt_idx";

ALTER TABLE "Reel"
  DROP COLUMN "storageDeletedAt";
