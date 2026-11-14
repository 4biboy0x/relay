-- Support the periodic stale-presence cleanup query filtering online users by lastSeen.
CREATE INDEX IF NOT EXISTS "User_isOnline_lastSeen_idx"
  ON "User" ("isOnline", "lastSeen");
