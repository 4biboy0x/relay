-- Support inbox membership lookups and unread-count membership filtering.
CREATE INDEX IF NOT EXISTS "ConversationMember_inbox_lookup_idx"
  ON "ConversationMember" ("userId", "deletedAt", "conversationId");
