BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '');
$$;

CREATE TYPE "InteractionType" AS ENUM ('LIKE', 'REPOST');
CREATE TYPE "NotificationType" AS ENUM ('FOLLOW', 'LIKE', 'REPOST', 'REPLY', 'MENTION', 'REEL_LIKE', 'REEL_COMMENT', 'REEL_REPOST', 'REEL_READY', 'REEL_FAILED');
CREATE TYPE "ReelStatus" AS ENUM ('UPLOADING', 'PROCESSING', 'READY', 'FAILED', 'REMOVED');
CREATE TYPE "ReelReportReason" AS ENUM ('SPAM', 'HARASSMENT', 'VIOLENCE', 'SEXUAL_CONTENT', 'MISINFORMATION', 'COPYRIGHT', 'OTHER');
CREATE TYPE "ReelReportStatus" AS ENUM ('PENDING', 'REVIEWED', 'DISMISSED', 'ACTIONED');
CREATE TYPE "ProcessingJobType" AS ENUM ('PROCESS_REEL');
CREATE TYPE "ProcessingJobStatus" AS ENUM ('PENDING', 'RUNNING', 'FAILED', 'COMPLETED');

CREATE TABLE "User" (
  "id" text PRIMARY KEY,
  "handle" varchar(30) NOT NULL UNIQUE,
  "email" varchar(254) NOT NULL UNIQUE,
  "passwordHash" text NOT NULL,
  "displayName" varchar(60) NOT NULL,
  "bio" varchar(280) NOT NULL DEFAULT '',
  "avatarUrl" text,
  "bannerUrl" text,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "Post" (
  "id" text PRIMARY KEY,
  "authorId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "body" varchar(280) NOT NULL,
  "mediaUrl" text,
  "location" varchar(80),
  "replyToId" text REFERENCES "Post"("id") ON DELETE CASCADE,
  "replyCount" integer NOT NULL DEFAULT 0 CHECK ("replyCount" >= 0),
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" timestamptz(3)
);

CREATE TABLE "Interaction" (
  "id" text PRIMARY KEY,
  "userId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "postId" text NOT NULL REFERENCES "Post"("id") ON DELETE CASCADE,
  "type" "InteractionType" NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("userId", "postId", "type")
);

CREATE TABLE "Follow" (
  "followerId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "followedId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("followerId", "followedId"),
  CHECK ("followerId" <> "followedId")
);

CREATE TABLE "Notification" (
  "id" text PRIMARY KEY,
  "recipientId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "actorId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "postId" text REFERENCES "Post"("id") ON DELETE CASCADE,
  "reelId" uuid,
  "type" "NotificationType" NOT NULL,
  "readAt" timestamptz(3),
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "RefreshToken" (
  "id" text PRIMARY KEY,
  "userId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "tokenHash" text NOT NULL UNIQUE,
  "expiresAt" timestamptz(3) NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "Hashtag" (
  "id" text PRIMARY KEY,
  "tag" varchar(100) NOT NULL UNIQUE,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "PostHashtag" (
  "postId" text NOT NULL REFERENCES "Post"("id") ON DELETE CASCADE,
  "hashtagId" text NOT NULL REFERENCES "Hashtag"("id") ON DELETE CASCADE,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("postId", "hashtagId")
);

CREATE TABLE "Conversation" (
  "id" text PRIMARY KEY,
  "directKey" text NOT NULL UNIQUE,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "ConversationMember" (
  "conversationId" text NOT NULL REFERENCES "Conversation"("id") ON DELETE CASCADE,
  "userId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "joinedAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastReadAt" timestamptz(3),
  PRIMARY KEY ("conversationId", "userId")
);

CREATE TABLE "Message" (
  "id" text PRIMARY KEY,
  "conversationId" text NOT NULL REFERENCES "Conversation"("id") ON DELETE CASCADE,
  "senderId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "body" varchar(2000) NOT NULL DEFAULT '',
  "mediaUrl" text,
  "audioUrl" text,
  "stickerId" varchar(64),
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "Reel" (
  "id" uuid PRIMARY KEY,
  "authorId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
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
  "likeCount" integer NOT NULL DEFAULT 0 CHECK ("likeCount" >= 0),
  "commentCount" integer NOT NULL DEFAULT 0 CHECK ("commentCount" >= 0),
  "repostCount" integer NOT NULL DEFAULT 0 CHECK ("repostCount" >= 0),
  "shareCount" integer NOT NULL DEFAULT 0 CHECK ("shareCount" >= 0),
  "viewCount" integer NOT NULL DEFAULT 0 CHECK ("viewCount" >= 0),
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" timestamptz(3),
  "deletedAt" timestamptz(3),
  "processingError" text,
  CHECK ("status" <> 'READY' OR ("durationMs" IS NOT NULL AND "durationMs" BETWEEN 1 AND 60000))
);

CREATE TABLE "ReelLike" (
  "userId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "reelId" uuid NOT NULL REFERENCES "Reel"("id") ON DELETE CASCADE,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("userId", "reelId")
);

CREATE TABLE "ReelBookmark" (
  "userId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "reelId" uuid NOT NULL REFERENCES "Reel"("id") ON DELETE CASCADE,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("userId", "reelId")
);

CREATE TABLE "ReelRepost" (
  "userId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "reelId" uuid NOT NULL REFERENCES "Reel"("id") ON DELETE CASCADE,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("userId", "reelId")
);

CREATE TABLE "ReelView" (
  "reelId" uuid NOT NULL REFERENCES "Reel"("id") ON DELETE CASCADE,
  "viewerKey" varchar(128) NOT NULL,
  "day" date NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("reelId", "viewerKey", "day")
);

CREATE TABLE "ReelComment" (
  "id" text PRIMARY KEY,
  "reelId" uuid NOT NULL REFERENCES "Reel"("id") ON DELETE CASCADE,
  "authorId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "replyToId" text REFERENCES "ReelComment"("id") ON DELETE CASCADE,
  "body" varchar(280) NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" timestamptz(3)
);

CREATE TABLE "ReelReport" (
  "id" text PRIMARY KEY,
  "reelId" uuid NOT NULL REFERENCES "Reel"("id") ON DELETE CASCADE,
  "reporterId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "reason" "ReelReportReason" NOT NULL,
  "details" varchar(1000),
  "status" "ReelReportStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("reelId", "reporterId")
);

CREATE TABLE "ProcessingJob" (
  "id" text PRIMARY KEY,
  "type" "ProcessingJobType" NOT NULL,
  "payload" jsonb NOT NULL,
  "status" "ProcessingJobStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" integer NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
  "runAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" timestamptz(3),
  "lastError" text,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_reelId_fkey"
  FOREIGN KEY ("reelId") REFERENCES "Reel"("id") ON DELETE CASCADE;

CREATE INDEX "User_createdAt_idx" ON "User" ("createdAt");
CREATE INDEX "Post_createdAt_id_idx" ON "Post" ("createdAt" DESC, "id" DESC);
CREATE INDEX "Post_authorId_createdAt_id_idx" ON "Post" ("authorId", "createdAt" DESC, "id" DESC);
CREATE INDEX "Post_replyToId_createdAt_idx" ON "Post" ("replyToId", "createdAt" DESC);
CREATE INDEX "Interaction_postId_type_createdAt_idx" ON "Interaction" ("postId", "type", "createdAt" DESC);
CREATE INDEX "Interaction_userId_type_createdAt_idx" ON "Interaction" ("userId", "type", "createdAt" DESC);
CREATE INDEX "Follow_followedId_createdAt_idx" ON "Follow" ("followedId", "createdAt" DESC);
CREATE INDEX "Notification_recipientId_createdAt_id_idx" ON "Notification" ("recipientId", "createdAt" DESC, "id" DESC);
CREATE INDEX "Notification_recipientId_readAt_idx" ON "Notification" ("recipientId", "readAt");
CREATE INDEX "RefreshToken_userId_expiresAt_idx" ON "RefreshToken" ("userId", "expiresAt");
CREATE INDEX "PostHashtag_hashtagId_createdAt_idx" ON "PostHashtag" ("hashtagId", "createdAt" DESC);
CREATE INDEX "Conversation_updatedAt_idx" ON "Conversation" ("updatedAt" DESC);
CREATE INDEX "ConversationMember_userId_lastReadAt_idx" ON "ConversationMember" ("userId", "lastReadAt");
CREATE INDEX "Message_conversationId_createdAt_id_idx" ON "Message" ("conversationId", "createdAt" DESC, "id" DESC);
CREATE INDEX "Message_senderId_createdAt_idx" ON "Message" ("senderId", "createdAt" DESC);
CREATE INDEX "Message_body_trgm_idx" ON "Message" USING gin ("body" gin_trgm_ops);
CREATE INDEX "Reel_status_publishedAt_id_idx" ON "Reel" ("status", "publishedAt" DESC, "id" DESC) WHERE "deletedAt" IS NULL;
CREATE INDEX "Reel_authorId_publishedAt_id_idx" ON "Reel" ("authorId", "publishedAt" DESC, "id" DESC) WHERE "deletedAt" IS NULL;
CREATE INDEX "ReelLike_userId_createdAt_idx" ON "ReelLike" ("userId", "createdAt" DESC);
CREATE INDEX "ReelBookmark_userId_createdAt_idx" ON "ReelBookmark" ("userId", "createdAt" DESC);
CREATE INDEX "ReelRepost_userId_createdAt_idx" ON "ReelRepost" ("userId", "createdAt" DESC);
CREATE INDEX "ReelView_reelId_createdAt_idx" ON "ReelView" ("reelId", "createdAt");
CREATE INDEX "ReelComment_reelId_createdAt_id_idx" ON "ReelComment" ("reelId", "createdAt" DESC, "id" DESC);
CREATE INDEX "ReelComment_replyToId_createdAt_idx" ON "ReelComment" ("replyToId", "createdAt" DESC);
CREATE INDEX "ReelReport_status_createdAt_idx" ON "ReelReport" ("status", "createdAt");
CREATE INDEX "ProcessingJob_status_runAt_idx" ON "ProcessingJob" ("status", "runAt");
CREATE INDEX "Notification_reelId_idx" ON "Notification" ("reelId");

REVOKE SELECT ON "User" FROM PUBLIC;
GRANT SELECT ("id", "handle", "displayName", "bio", "avatarUrl", "bannerUrl", "createdAt")
  ON "User" TO PUBLIC;

ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Post" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Interaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Follow" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RefreshToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Hashtag" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PostHashtag" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Conversation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConversationMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Reel" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReelLike" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReelBookmark" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReelRepost" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReelView" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReelComment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReelReport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProcessingJob" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "User" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Post" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Interaction" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Follow" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Notification" FORCE ROW LEVEL SECURITY;
ALTER TABLE "RefreshToken" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Hashtag" FORCE ROW LEVEL SECURITY;
ALTER TABLE "PostHashtag" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Conversation" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ConversationMember" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Message" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Reel" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ReelLike" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ReelBookmark" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ReelRepost" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ReelView" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ReelComment" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ReelReport" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ProcessingJob" FORCE ROW LEVEL SECURITY;

CREATE POLICY "users_public_select" ON "User" FOR SELECT USING (true);
CREATE POLICY "users_self_insert" ON "User" FOR INSERT WITH CHECK (auth.uid() = "id");
CREATE POLICY "users_self_update" ON "User" FOR UPDATE
  USING (auth.uid() = "id") WITH CHECK (auth.uid() = "id");
CREATE POLICY "users_self_delete" ON "User" FOR DELETE USING (auth.uid() = "id");

CREATE POLICY "posts_public_select" ON "Post" FOR SELECT
  USING ("deletedAt" IS NULL);
CREATE POLICY "posts_owner_insert" ON "Post" FOR INSERT
  WITH CHECK (auth.uid() = "authorId");
CREATE POLICY "posts_owner_update" ON "Post" FOR UPDATE
  USING (auth.uid() = "authorId") WITH CHECK (auth.uid() = "authorId");
CREATE POLICY "posts_owner_delete" ON "Post" FOR DELETE
  USING (auth.uid() = "authorId");

CREATE POLICY "interactions_public_select" ON "Interaction" FOR SELECT USING (true);
CREATE POLICY "interactions_owner_insert" ON "Interaction" FOR INSERT
  WITH CHECK (auth.uid() = "userId");
CREATE POLICY "interactions_owner_delete" ON "Interaction" FOR DELETE
  USING (auth.uid() = "userId");

CREATE POLICY "follows_public_select" ON "Follow" FOR SELECT USING (true);
CREATE POLICY "follows_owner_insert" ON "Follow" FOR INSERT
  WITH CHECK (auth.uid() = "followerId");
CREATE POLICY "follows_owner_delete" ON "Follow" FOR DELETE
  USING (auth.uid() = "followerId");

CREATE POLICY "notifications_recipient_select" ON "Notification" FOR SELECT
  USING (auth.uid() = "recipientId");
CREATE POLICY "notifications_recipient_update" ON "Notification" FOR UPDATE
  USING (auth.uid() = "recipientId")
  WITH CHECK (auth.uid() = "recipientId");
CREATE POLICY "notifications_actor_insert" ON "Notification" FOR INSERT
  WITH CHECK (auth.uid() = "actorId");
CREATE POLICY "notifications_recipient_delete" ON "Notification" FOR DELETE
  USING (auth.uid() = "recipientId");

CREATE POLICY "refresh_tokens_owner_select" ON "RefreshToken" FOR SELECT
  USING (auth.uid() = "userId");
CREATE POLICY "refresh_tokens_owner_insert" ON "RefreshToken" FOR INSERT
  WITH CHECK (auth.uid() = "userId");
CREATE POLICY "refresh_tokens_owner_update" ON "RefreshToken" FOR UPDATE
  USING (auth.uid() = "userId") WITH CHECK (auth.uid() = "userId");
CREATE POLICY "refresh_tokens_owner_delete" ON "RefreshToken" FOR DELETE
  USING (auth.uid() = "userId");

CREATE POLICY "hashtags_public_select" ON "Hashtag" FOR SELECT USING (true);
CREATE POLICY "hashtags_authenticated_insert" ON "Hashtag" FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "hashtags_no_update" ON "Hashtag" FOR UPDATE USING (false);
CREATE POLICY "hashtags_no_delete" ON "Hashtag" FOR DELETE USING (false);

CREATE POLICY "post_hashtags_public_select" ON "PostHashtag" FOR SELECT USING (true);
CREATE POLICY "post_hashtags_author_insert" ON "PostHashtag" FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM "Post" p
    WHERE p."id" = "postId" AND p."authorId" = auth.uid()
  ));
CREATE POLICY "post_hashtags_author_delete" ON "PostHashtag" FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM "Post" p
    WHERE p."id" = "postId" AND p."authorId" = auth.uid()
  ));

CREATE POLICY "conversations_member_select" ON "Conversation" FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM "ConversationMember" cm
    WHERE cm."conversationId" = "Conversation"."id" AND cm."userId" = auth.uid()
  ));
CREATE POLICY "conversations_member_insert" ON "Conversation" FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "conversations_member_update" ON "Conversation" FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM "ConversationMember" cm
    WHERE cm."conversationId" = "Conversation"."id" AND cm."userId" = auth.uid()
  ));
CREATE POLICY "conversations_member_delete" ON "Conversation" FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM "ConversationMember" cm
    WHERE cm."conversationId" = "Conversation"."id" AND cm."userId" = auth.uid()
  ));

CREATE POLICY "conversation_members_self_select" ON "ConversationMember" FOR SELECT
  USING (auth.uid() = "userId");
CREATE POLICY "conversation_members_member_insert" ON "ConversationMember" FOR INSERT
  WITH CHECK (auth.uid() = "userId");
CREATE POLICY "conversation_members_self_update" ON "ConversationMember" FOR UPDATE
  USING (auth.uid() = "userId") WITH CHECK (auth.uid() = "userId");
CREATE POLICY "conversation_members_self_delete" ON "ConversationMember" FOR DELETE
  USING (auth.uid() = "userId");

CREATE POLICY "messages_member_select" ON "Message" FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM "ConversationMember" cm
    WHERE cm."conversationId" = "Message"."conversationId" AND cm."userId" = auth.uid()
  ));
CREATE POLICY "messages_member_insert" ON "Message" FOR INSERT
  WITH CHECK (
    auth.uid() = "senderId"
    AND EXISTS (
      SELECT 1 FROM "ConversationMember" cm
      WHERE cm."conversationId" = "Message"."conversationId" AND cm."userId" = auth.uid()
    )
  );
CREATE POLICY "messages_sender_update" ON "Message" FOR UPDATE
  USING (auth.uid() = "senderId") WITH CHECK (auth.uid() = "senderId");
CREATE POLICY "messages_sender_delete" ON "Message" FOR DELETE
  USING (auth.uid() = "senderId");

CREATE POLICY "reels_public_or_owner_select" ON "Reel" FOR SELECT
  USING (("status" = 'READY' AND "deletedAt" IS NULL) OR auth.uid() = "authorId");
CREATE POLICY "reels_owner_insert" ON "Reel" FOR INSERT
  WITH CHECK (auth.uid() = "authorId");
CREATE POLICY "reels_owner_update" ON "Reel" FOR UPDATE
  USING (auth.uid() = "authorId") WITH CHECK (auth.uid() = "authorId");

CREATE POLICY "reel_likes_viewable_select" ON "ReelLike" FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM "Reel" r WHERE r."id" = "reelId"
      AND ((r."status" = 'READY' AND r."deletedAt" IS NULL) OR r."authorId" = auth.uid())
  ));
CREATE POLICY "reel_likes_owner_insert" ON "ReelLike" FOR INSERT
  WITH CHECK (auth.uid() = "userId");
CREATE POLICY "reel_likes_owner_delete" ON "ReelLike" FOR DELETE
  USING (auth.uid() = "userId");

CREATE POLICY "reel_bookmarks_owner_select" ON "ReelBookmark" FOR SELECT
  USING (auth.uid() = "userId");
CREATE POLICY "reel_bookmarks_owner_insert" ON "ReelBookmark" FOR INSERT
  WITH CHECK (auth.uid() = "userId");
CREATE POLICY "reel_bookmarks_owner_delete" ON "ReelBookmark" FOR DELETE
  USING (auth.uid() = "userId");

CREATE POLICY "reel_reposts_viewable_select" ON "ReelRepost" FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM "Reel" r WHERE r."id" = "reelId"
      AND ((r."status" = 'READY' AND r."deletedAt" IS NULL) OR r."authorId" = auth.uid())
  ));
CREATE POLICY "reel_reposts_owner_insert" ON "ReelRepost" FOR INSERT
  WITH CHECK (auth.uid() = "userId");
CREATE POLICY "reel_reposts_owner_delete" ON "ReelRepost" FOR DELETE
  USING (auth.uid() = "userId");

CREATE POLICY "reel_views_insert" ON "ReelView" FOR INSERT
  WITH CHECK (true);

CREATE POLICY "reel_comments_public_select" ON "ReelComment" FOR SELECT
  USING ("deletedAt" IS NULL AND EXISTS (
    SELECT 1 FROM "Reel" r WHERE r."id" = "reelId"
      AND ((r."status" = 'READY' AND r."deletedAt" IS NULL) OR r."authorId" = auth.uid())
  ));
CREATE POLICY "reel_comments_owner_insert" ON "ReelComment" FOR INSERT
  WITH CHECK (auth.uid() = "authorId");
CREATE POLICY "reel_comments_author_or_reel_owner_delete" ON "ReelComment" FOR DELETE
  USING (auth.uid() = "authorId" OR EXISTS (
    SELECT 1 FROM "Reel" r WHERE r."id" = "reelId" AND r."authorId" = auth.uid()
  ));
CREATE POLICY "reel_reports_owner_select" ON "ReelReport" FOR SELECT
  USING (auth.uid() = "reporterId");
CREATE POLICY "reel_reports_owner_insert" ON "ReelReport" FOR INSERT
  WITH CHECK (auth.uid() = "reporterId");

COMMIT;
