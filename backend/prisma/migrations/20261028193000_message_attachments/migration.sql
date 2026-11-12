ALTER TABLE "Message"
  ADD COLUMN "mediaUrl" TEXT,
  ADD COLUMN "audioUrl" TEXT,
  ADD COLUMN "stickerId" VARCHAR(64);

ALTER TABLE "Message"
  ALTER COLUMN "body" SET DEFAULT '';
