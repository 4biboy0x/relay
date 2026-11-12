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

ALTER TABLE "ConversationPreference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConversationPreference" FORCE ROW LEVEL SECURITY;

CREATE POLICY "conversation_preferences_self_select" ON "ConversationPreference" FOR SELECT
  USING (auth.uid() = "userId");
CREATE POLICY "conversation_preferences_self_insert" ON "ConversationPreference" FOR INSERT
  WITH CHECK (auth.uid() = "userId");
CREATE POLICY "conversation_preferences_self_update" ON "ConversationPreference" FOR UPDATE
  USING (auth.uid() = "userId") WITH CHECK (auth.uid() = "userId");
CREATE POLICY "conversation_preferences_self_delete" ON "ConversationPreference" FOR DELETE
  USING (auth.uid() = "userId");
