-- Hide a conversation only from the member who deleted it.
-- Preserve the conversation, messages, and all other participants.
ALTER TABLE "ConversationMember"
  ADD COLUMN IF NOT EXISTS "deletedAt" timestamptz(3);

CREATE INDEX IF NOT EXISTS "ConversationMember_userId_deletedAt_idx"
  ON "ConversationMember" ("userId", "deletedAt");
