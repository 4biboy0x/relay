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
  'REEL_REPOST',
  'REEL_READY',
  'REEL_FAILED'
);

ALTER TABLE "Notification"
  ALTER COLUMN "type" TYPE "NotificationType_new"
  USING ("type"::"NotificationType_new");

DROP TYPE "NotificationType";
ALTER TYPE "NotificationType_new" RENAME TO "NotificationType";
