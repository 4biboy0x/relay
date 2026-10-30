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
CREATE TYPE "NotificationType" AS ENUM ('FOLLOW', 'LIKE', 'REPOST', 'REPLY', 'MENTION');

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

COMMIT;
