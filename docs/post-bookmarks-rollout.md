# Post bookmarks migration and production rollout

## Migration inventory at the PR base

The repository contains the following Prisma migrations:

- `20261028143000_init` — production status: **unknown; requires a query against the production database**
- `20261028154500_search_uploads_messages` — production status: **unknown; requires a query against the production database**
- `20261028174000_mentions_notifications` — production status: **unknown; requires a query against the production database**
- `20261028180000_post_location` — production status: **unknown; requires a query against the production database**
- `20261028190000_remove_relay_loop` — production status: **unknown; requires a query against the production database**
- `20261028193000_message_attachments` — production status: **unknown; requires a query against the production database**
- `20261030232000_cascade_post_replies` — production status: **unknown; requires a query against the production database**
- `20261030235000_conversation_message_trigram_search` — production status: **unknown; requires a query against the production database**
- `20261031100000_realtime_demo` — production status: **unknown; requires a query against the production database**
- `20261031170000_post_views` — production status: **unknown; requires a query against the production database**
- `20261101100000_global_user_presence` — production status: **unknown; requires a query against the production database**
- `20261101120000_reels` — production status: **unknown; requires a query against the production database**
- `20261101130000_reel_storage_cleanup` — production status: **unknown; requires a query against the production database**
- `20261101140000_remove_reel_lifecycle_notifications` — production status: **unknown; requires a query against the production database**
- `20261101150000_server_post_views` — production status: **unknown; requires a query against the production database**
- `20261101160000_message_voice_waveform` — production status: **unknown; requires a query against the production database**
- `20261101230000_unique_reel_shares` — production status: **unknown; requires a query against the production database**
- `20261102001000_message_replies_reactions` — production status: **unknown; requires a query against the production database**
- `20261102014000_realtime_reaction_activity` — production status: **unknown; requires a query against the production database**
- `20261102173000_reel_live_interactions` — production status: **unknown; requires a query against the production database**
- `20261102184500_reel_comment_likes` — production status: **unknown; requires a query against the production database**
- `20261102214300_post_media_crop_alt` — production status: **unknown; requires a query against the production database**
- `20261103193000_auth_otp` — production status: **unknown; requires a query against the production database**
- `20261104120000_message_attachments_array` — production status: **unknown; requires a query against the production database**
- `20261112140000_conversation_preferences` — production status: **unknown; requires a query against the production database**
- `20261112160000_delete_conversations_per_user` — production status: **unknown; requires a query against the production database**
- `20261113140000_topics_foundation` — production status: **unknown; requires a query against the production database**
- `20261114000000_per_user_dm_history_cutoff` — production status: **unknown; requires a query against the production database**
- `20261114120000_search_trigram_indexes` — production status: **unknown; requires a query against the production database**
- `20261114130000_repair_missing_dm_memberships` — production status: **unknown; requires a query against the production database**
- `20261114140000_user_presence_cleanup_index` — production status: **unknown; requires a query against the production database**
- `20261114150000_conversation_member_inbox_index` — production status: **unknown; requires a query against the production database**
- `20261114160000_private_media_lookup_indexes` — production status: **unknown; requires a query against the production database**
- `20261117230000_add_post_media_urls` — production status: **unknown; requires a query against the production database**

The backend startup chain is `prestart = npm run db:recover && npm run db:deploy` in `backend/package.json`; Render's npm start lifecycle runs that prestart hook before `node dist/index.js`. `db:deploy` is `prisma migrate deploy`, which applies **every** migration present in the repository that is not already marked finished in the target database's `_prisma_migrations` table.

This environment can inspect the repository but has no connection to the production Neon database. Therefore it is not possible to truthfully classify any existing migration as already applied or pending in production. Do not assume the latest repo migration is applied. Before production rollout, run this read-only query against the exact production database:

```sql
SELECT
  migration_name,
  started_at,
  finished_at,
  rolled_back_at,
  CASE
    WHEN rolled_back_at IS NOT NULL THEN 'rolled back'
    WHEN finished_at IS NOT NULL THEN 'applied'
    ELSE 'pending or failed'
  END AS status
FROM public."_prisma_migrations"
ORDER BY started_at, migration_name;
```

Compare the result with the repository inventory above. Any repo migration absent from the table is pending. Any row with `finished_at IS NULL` and `rolled_back_at IS NULL` needs investigation before deploy. The startup recovery script only handles the named conversation-preferences migration; it does not automatically resolve other failed migrations.

## Additive migration SQL

File: `backend/prisma/migrations/20261120110000_post_bookmarks/migration.sql`

```sql
CREATE TABLE "PostBookmark" (
  "userId" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PostBookmark_userId_postId_key" UNIQUE ("userId", "postId"),
  CONSTRAINT "PostBookmark_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PostBookmark_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "PostBookmark_userId_createdAt_postId_idx"
  ON "PostBookmark" ("userId", "createdAt" DESC, "postId" DESC);
```

The migration creates only the new `PostBookmark` table and its listing index. The composite unique constraint creates its backing unique index. It does not ALTER or DROP existing tables, columns, constraints, or indexes. Both foreign keys cascade when the referenced user or post is physically deleted.

## Production application procedure

1. Freeze unrelated deploys and take a fresh Neon restore point/branch. Also create a logical backup from the production direct connection:
   ```bash
   pg_dump "$DIRECT_URL" --format=custom --no-owner --no-privileges --file="relay-before-post-bookmarks.dump"
   pg_restore --list "relay-before-post-bookmarks.dump" > /dev/null
   ```
2. Query `_prisma_migrations` using the read-only SQL above. Reconcile every repository migration first. Do not run deploy if an unexpected migration is pending or failed.
3. Deploy the reviewed PR after merge. From `backend/`, run:
   ```bash
   npm run db:deploy
   ```
   This is the same Prisma deploy command used by the current Render `prestart` hook and applies every pending migration, not only this one. Review the pending list before running it. The next normal Render start also invokes `db:recover` then `db:deploy`.
4. Verify the new table, constraints, index, and migration row:
   ```sql
   SELECT to_regclass('public."PostBookmark"') AS post_bookmark_table,
          to_regclass('public."PostBookmark_userId_createdAt_postId_idx"') AS listing_index;
   SELECT migration_name, finished_at
   FROM public."_prisma_migrations"
   WHERE migration_name = '20261120110000_post_bookmarks';
   ```

## Rollback SQL

Only run after stopping bookmark writes and deciding to discard all saved-post data:

```sql
DROP INDEX IF EXISTS "PostBookmark_userId_createdAt_postId_idx";
DROP TABLE IF EXISTS "PostBookmark";
```

Dropping the table also removes its unique constraint and its constraint-backed unique index, plus both foreign keys. **This rollback permanently deletes every saved bookmark.** It does not delete posts or users. If rolling back the application, mark the migration rolled back with Prisma's migration resolution workflow only after the SQL rollback has completed; do not edit `_prisma_migrations` manually.
