ALTER TABLE "Conversation"
ADD COLUMN "lastMessage" JSONB;

ALTER TABLE "ConversationMember"
ADD COLUMN "unreadReactionCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "ConversationReactionActivity" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "emoji" VARCHAR(16) NOT NULL,
  "targetType" VARCHAR(16) NOT NULL,
  "targetText" VARCHAR(2000),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "ConversationReactionActivity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConversationReactionActivity_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ConversationReactionActivity_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "Message"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ConversationReactionActivity_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ConversationReactionActivity_conversationId_isActive_createdAt_idx"
ON "ConversationReactionActivity"("conversationId", "isActive", "createdAt" DESC);

CREATE INDEX "ConversationReactionActivity_messageId_actorId_isActive_idx"
ON "ConversationReactionActivity"("messageId", "actorId", "isActive");
