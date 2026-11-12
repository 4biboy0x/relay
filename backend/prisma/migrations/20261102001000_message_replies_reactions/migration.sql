ALTER TABLE "Message"
ADD COLUMN "replyToId" text;

ALTER TABLE "Message"
ADD CONSTRAINT "Message_replyToId_fkey"
FOREIGN KEY ("replyToId") REFERENCES "Message"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Message_replyToId_idx" ON "Message"("replyToId");

CREATE TABLE "MessageReaction" (
  "messageId" text NOT NULL,
  "userId" text NOT NULL,
  "emoji" varchar(16) NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageReaction_pkey" PRIMARY KEY ("messageId", "userId", "emoji"),
  CONSTRAINT "MessageReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MessageReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "MessageReaction_messageId_emoji_idx" ON "MessageReaction"("messageId", "emoji");
