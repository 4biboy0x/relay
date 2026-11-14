-- Add trigram indexes for the substring searches used by the people,
-- hashtag, and post search endpoints. pg_trgm is already part of the
-- datasource extensions and is installed by the earlier search migration.
CREATE INDEX IF NOT EXISTS "User_handle_trgm_idx"
  ON "User" USING GIN ("handle" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "User_displayName_trgm_idx"
  ON "User" USING GIN ("displayName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Post_body_trgm_idx"
  ON "Post" USING GIN ("body" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Hashtag_tag_trgm_idx"
  ON "Hashtag" USING GIN ("tag" gin_trgm_ops);
