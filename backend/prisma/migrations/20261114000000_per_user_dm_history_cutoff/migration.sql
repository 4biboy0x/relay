ALTER TABLE "ConversationMember"
ADD COLUMN "historyCutoffAt" TIMESTAMP(3);

-- Preserve the existing per-user deletion boundary for conversations hidden before this migration.
UPDATE "ConversationMember"
SET "historyCutoffAt" = "deletedAt"
WHERE "deletedAt" IS NOT NULL;
