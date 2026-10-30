CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "Message_body_idx"
ON "Message"
USING GIN ("body" gin_trgm_ops);
