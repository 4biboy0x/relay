ALTER TABLE "Post"
ADD COLUMN "media_urls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "Post"
SET "media_urls" = ARRAY["mediaUrl"]
WHERE "mediaUrl" IS NOT NULL;
