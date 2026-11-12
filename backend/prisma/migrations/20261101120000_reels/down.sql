DROP INDEX IF EXISTS "Notification_reelId_idx";
ALTER TABLE "Notification" DROP CONSTRAINT "Notification_reelId_fkey";
ALTER TABLE "Notification" DROP COLUMN "reelId";

DROP TABLE "ReelComment";
DROP TABLE "ReelReport";
DROP TABLE "ReelView";
DROP TABLE "ReelRepost";
DROP TABLE "ReelBookmark";
DROP TABLE "ReelLike";
DROP TABLE "ProcessingJob";
DROP TABLE "Reel";

ALTER TABLE "Notification" ALTER COLUMN "type" TYPE text USING "type"::text;
-- New enum values cannot be removed in place, so rollback drops notifications created for Reels.
DELETE FROM "Notification"
WHERE "type" IN ('REEL_LIKE', 'REEL_COMMENT', 'REEL_REPOST', 'REEL_READY', 'REEL_FAILED');
CREATE TYPE "NotificationType_previous" AS ENUM ('FOLLOW', 'LIKE', 'REPOST', 'REPLY', 'MENTION');
ALTER TABLE "Notification"
  ALTER COLUMN "type" TYPE "NotificationType_previous"
  USING "type"::"NotificationType_previous";
DROP TYPE "NotificationType";
ALTER TYPE "NotificationType_previous" RENAME TO "NotificationType";

DROP TYPE "ProcessingJobStatus";
DROP TYPE "ProcessingJobType";
DROP TYPE "ReelReportStatus";
DROP TYPE "ReelReportReason";
DROP TYPE "ReelStatus";
