DELETE FROM "Notification"
WHERE "type" IN ('LOOP_REQUEST', 'LOOP_UPDATE');

DROP TABLE "LoopRequest";
DROP TABLE "PostLoop";

ALTER TYPE "NotificationType" RENAME TO "NotificationType_old";
CREATE TYPE "NotificationType" AS ENUM ('FOLLOW', 'LIKE', 'REPOST', 'REPLY', 'MENTION');

ALTER TABLE "Notification"
ALTER COLUMN "type" TYPE "NotificationType"
USING ("type"::text::"NotificationType");

DROP TYPE "NotificationType_old";
DROP TYPE "LoopPrompt";
