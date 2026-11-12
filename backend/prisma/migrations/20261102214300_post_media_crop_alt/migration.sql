-- Add post media crop metadata and accessible image description.
ALTER TABLE "Post"
ADD COLUMN "media_crop" JSONB,
ADD COLUMN "media_alt" VARCHAR(1000);
