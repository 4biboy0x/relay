-- Conversation preferences are accessed through the authenticated Relay API.
-- Do not use Supabase-specific auth.uid(): this project authenticates requests in
-- the backend and runs on Neon PostgreSQL without an "auth" schema.
--
-- IF NOT EXISTS makes this migration recoverable after a previous partial run.
CREATE TABLE IF NOT EXISTS "ConversationPreference" (
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

CREATE INDEX IF NOT EXISTS "ConversationPreference_userId_pinned_pinnedAt_idx"
  ON "ConversationPreference" ("userId", "pinned", "pinnedAt");
CREATE INDEX IF NOT EXISTS "ConversationPreference_userId_muted_mutedUntil_idx"
  ON "ConversationPreference" ("userId", "muted", "mutedUntil");

-- Clear any partial RLS setup from the failed Supabase-specific migration.
ALTER TABLE "ConversationPreference" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ConversationPreference" DISABLE ROW LEVEL SECURITY;
