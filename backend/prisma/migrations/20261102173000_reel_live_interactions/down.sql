DROP INDEX IF EXISTS "Notification_reelCommentId_idx";
ALTER TABLE "Notification" DROP CONSTRAINT IF EXISTS "Notification_reelCommentId_fkey";
ALTER TABLE "Notification" DROP COLUMN IF EXISTS "reelCommentId";
