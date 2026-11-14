CREATE INDEX IF NOT EXISTS "Message_mediaUrl_idx"
  ON "Message" ("mediaUrl");

CREATE INDEX IF NOT EXISTS "Message_audioUrl_idx"
  ON "Message" ("audioUrl");

CREATE INDEX IF NOT EXISTS "Message_attachments_gin_idx"
  ON "Message" USING GIN ("attachments" jsonb_path_ops);
