DELETE FROM "Notification"
WHERE "type"::text IN ('REEL_READY', 'REEL_FAILED')
   OR "recipientId" = "actorId";

ALTER TABLE "Notification"
  ALTER COLUMN "type" TYPE text USING "type"::text;

CREATE TYPE "NotificationType_new" AS ENUM (
  'FOLLOW',
  'LIKE',
  'REPOST',
  'REPLY',
  'MENTION',
  'REEL_LIKE',
  'REEL_COMMENT',
  'REEL_REPOST'
);

ALTER TABLE "Notification"
  ALTER COLUMN "type" TYPE "NotificationType_new"
  USING ("type"::"NotificationType_new");

DROP TYPE "NotificationType";
ALTER TYPE "NotificationType_new" RENAME TO "NotificationType";
