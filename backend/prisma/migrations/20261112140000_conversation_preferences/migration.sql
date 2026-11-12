CREATE TABLE "ConversationPreference" (
  "conversationId" text NOT NULL REFERENCES "Conversation"("id") ON DELETE CASCADE,
  "userId" text NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "pinned" boolean NOT NULL DEFAULT false,
  "pinnedAt" timestamptz(3),
  "muted" boolean NOT NULL DEFAULT false,
  "mutedUntil" timestamptz(3),
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("conversationId", "userId")
);

CREATE INDEX "ConversationPreference_userId_pinned_pinnedAt_idx"
  ON "ConversationPreference" ("userId", "pinned", "pinnedAt");
CREATE INDEX "ConversationPreference_userId_muted_mutedUntil_idx"
  ON "ConversationPreference" ("userId", "muted", "mutedUntil");
