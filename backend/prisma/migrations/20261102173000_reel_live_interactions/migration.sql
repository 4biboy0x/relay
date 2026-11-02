ALTER TABLE "Notification" ADD COLUMN "reelCommentId" TEXT;

ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_reelCommentId_fkey"
  FOREIGN KEY ("reelCommentId") REFERENCES "ReelComment"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Notification_reelCommentId_idx" ON "Notification" ("reelCommentId");
