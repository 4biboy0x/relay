CREATE TYPE "ReelStatus" AS ENUM ('UPLOADING', 'PROCESSING', 'READY', 'FAILED', 'REMOVED');
CREATE TYPE "ReelReportReason" AS ENUM ('SPAM', 'HARASSMENT', 'VIOLENCE', 'SEXUAL_CONTENT', 'MISINFORMATION', 'COPYRIGHT', 'OTHER');
CREATE TYPE "ReelReportStatus" AS ENUM ('PENDING', 'REVIEWED', 'DISMISSED', 'ACTIONED');
CREATE TYPE "ProcessingJobType" AS ENUM ('PROCESS_REEL');
CREATE TYPE "ProcessingJobStatus" AS ENUM ('PENDING', 'RUNNING', 'FAILED', 'COMPLETED');

ALTER TYPE "NotificationType" ADD VALUE 'REEL_LIKE';
ALTER TYPE "NotificationType" ADD VALUE 'REEL_COMMENT';
ALTER TYPE "NotificationType" ADD VALUE 'REEL_REPOST';
ALTER TYPE "NotificationType" ADD VALUE 'REEL_READY';
ALTER TYPE "NotificationType" ADD VALUE 'REEL_FAILED';

CREATE TABLE "Reel" (
  "id" uuid NOT NULL,
  "authorId" text NOT NULL,
  "caption" varchar(280),
  "status" "ReelStatus" NOT NULL DEFAULT 'UPLOADING',
  "originalKey" text NOT NULL,
  "videoKey" text,
  "posterKey" text,
  "durationMs" integer,
  "width" integer,
  "height" integer,
  "sizeBytes" bigint NOT NULL,
  "mime" varchar(100) NOT NULL,
  "likeCount" integer NOT NULL DEFAULT 0,
  "commentCount" integer NOT NULL DEFAULT 0,
  "repostCount" integer NOT NULL DEFAULT 0,
  "shareCount" integer NOT NULL DEFAULT 0,
  "viewCount" integer NOT NULL DEFAULT 0,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" timestamp(3),
  "deletedAt" timestamp(3),
  "processingError" text,
  CONSTRAINT "Reel_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Reel_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Reel_caption_length_check" CHECK ("caption" IS NULL OR char_length("caption") <= 280),
  CONSTRAINT "Reel_ready_duration_check" CHECK ("status" <> 'READY' OR ("durationMs" IS NOT NULL AND "durationMs" BETWEEN 1 AND 60000)),
  CONSTRAINT "Reel_counters_nonnegative_check" CHECK (
    "likeCount" >= 0 AND "commentCount" >= 0 AND "repostCount" >= 0
    AND "shareCount" >= 0 AND "viewCount" >= 0
  )
);

CREATE TABLE "ReelLike" (
  "userId" text NOT NULL,
  "reelId" uuid NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReelLike_pkey" PRIMARY KEY ("userId", "reelId"),
  CONSTRAINT "ReelLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ReelLike_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "Reel"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ReelBookmark" (
  "userId" text NOT NULL,
  "reelId" uuid NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReelBookmark_pkey" PRIMARY KEY ("userId", "reelId"),
  CONSTRAINT "ReelBookmark_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ReelBookmark_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "Reel"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ReelRepost" (
  "userId" text NOT NULL,
  "reelId" uuid NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReelRepost_pkey" PRIMARY KEY ("userId", "reelId"),
  CONSTRAINT "ReelRepost_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ReelRepost_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "Reel"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ReelView" (
  "reelId" uuid NOT NULL,
  "viewerKey" varchar(128) NOT NULL,
  "day" date NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReelView_pkey" PRIMARY KEY ("reelId", "viewerKey", "day"),
  CONSTRAINT "ReelView_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "Reel"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ReelComment" (
  "id" text NOT NULL,
  "reelId" uuid NOT NULL,
  "authorId" text NOT NULL,
  "replyToId" text,
  "body" varchar(280) NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" timestamp(3),
  CONSTRAINT "ReelComment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReelComment_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "Reel"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ReelComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ReelComment_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "ReelComment"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ReelReport" (
  "id" text NOT NULL,
  "reelId" uuid NOT NULL,
  "reporterId" text NOT NULL,
  "reason" "ReelReportReason" NOT NULL,
  "details" varchar(1000),
  "status" "ReelReportStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReelReport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReelReport_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "Reel"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ReelReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ReelReport_reelId_reporterId_key" UNIQUE ("reelId", "reporterId")
);

CREATE TABLE "ProcessingJob" (
  "id" text NOT NULL,
  "type" "ProcessingJobType" NOT NULL,
  "payload" jsonb NOT NULL,
  "status" "ProcessingJobStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" integer NOT NULL DEFAULT 0,
  "runAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" timestamp(3),
  "lastError" text,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProcessingJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProcessingJob_attempts_nonnegative_check" CHECK ("attempts" >= 0)
);

ALTER TABLE "Notification" ADD COLUMN "reelId" uuid;
ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_reelId_fkey"
  FOREIGN KEY ("reelId") REFERENCES "Reel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Reel_status_publishedAt_id_idx" ON "Reel" ("status", "publishedAt" DESC, "id" DESC);
CREATE INDEX "Reel_authorId_publishedAt_id_idx" ON "Reel" ("authorId", "publishedAt" DESC, "id" DESC);
CREATE INDEX "ReelLike_userId_createdAt_idx" ON "ReelLike" ("userId", "createdAt" DESC);
CREATE INDEX "ReelBookmark_userId_createdAt_idx" ON "ReelBookmark" ("userId", "createdAt" DESC);
CREATE INDEX "ReelRepost_userId_createdAt_idx" ON "ReelRepost" ("userId", "createdAt" DESC);
CREATE INDEX "ReelView_reelId_createdAt_idx" ON "ReelView" ("reelId", "createdAt");
CREATE INDEX "ReelComment_reelId_createdAt_id_idx" ON "ReelComment" ("reelId", "createdAt" DESC, "id" DESC);
CREATE INDEX "ReelComment_replyToId_createdAt_idx" ON "ReelComment" ("replyToId", "createdAt" DESC);
CREATE INDEX "ReelReport_status_createdAt_idx" ON "ReelReport" ("status", "createdAt");
CREATE INDEX "ProcessingJob_status_runAt_idx" ON "ProcessingJob" ("status", "runAt");
CREATE INDEX "Notification_reelId_idx" ON "Notification" ("reelId");
