ALTER TABLE "Post" RENAME COLUMN "views" TO "view_count";

DROP TABLE "PostView";

CREATE TABLE post_views (
  post_id text NOT NULL REFERENCES "Post"("id") ON DELETE CASCADE,
  viewer_key text NOT NULL,
  user_id text REFERENCES "User"("id") ON DELETE CASCADE,
  first_viewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, viewer_key)
);

CREATE INDEX post_views_post_id_idx ON post_views (post_id);

DROP TABLE "ReelView";

CREATE TABLE reel_views (
  reel_id uuid NOT NULL REFERENCES "Reel"("id") ON DELETE CASCADE,
  viewer_key text NOT NULL,
  user_id text REFERENCES "User"("id") ON DELETE CASCADE,
  first_viewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reel_id, viewer_key)
);

CREATE INDEX reel_views_reel_id_first_viewed_at_idx
ON reel_views (reel_id, first_viewed_at);

ALTER TABLE post_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_views FORCE ROW LEVEL SECURITY;
CREATE POLICY "post_views_insert" ON post_views FOR INSERT
  WITH CHECK (true);

ALTER TABLE reel_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE reel_views FORCE ROW LEVEL SECURITY;
CREATE POLICY "reel_views_insert" ON reel_views FOR INSERT
  WITH CHECK (true);
