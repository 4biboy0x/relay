-- Restore any missing direct-conversation memberships once during deployment.
-- directKey is created from the two participant IDs, sorted and joined by ":".
-- Keep only well-formed keys and existing users; preserve existing membership rows.
INSERT INTO "ConversationMember" ("conversationId", "userId")
SELECT conversation."id", participant."userId"
FROM "Conversation" AS conversation
CROSS JOIN LATERAL (
  SELECT split_part(conversation."directKey", ':', 1) AS "userId"
  UNION
  SELECT split_part(conversation."directKey", ':', 2) AS "userId"
) AS participant
JOIN "User" AS existing_user
  ON existing_user."id" = participant."userId"
WHERE cardinality(string_to_array(conversation."directKey", ':')) = 2
ON CONFLICT ("conversationId", "userId") DO NOTHING;
