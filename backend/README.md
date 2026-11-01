# Relay backend

Relay is a Node.js 20+ / TypeScript API using Express, PostgreSQL, Prisma, Zod, bcrypt, Multer, and Socket.IO. REST handlers are in `src/app.ts`; authenticated real-time handlers are in `src/realtime.ts`; image validation and local storage are in `src/uploads.ts`.

## Start locally

1. Copy `.env.example` to `.env` and set `DATABASE_URL`, `DIRECT_URL`, a random `JWT_ACCESS_SECRET`, and a separate random `POST_VIEW_HMAC_SECRET` (each at least 32 characters). Locally, both database URLs can use the same direct connection. Set `CLIENT_ORIGIN=http://localhost:5173` to match the local frontend origin. Keep `.env` out of source control.
2. From this directory run `npm install`, `npm run db:generate`, and `npm run db:migrate` to apply the database migrations.
3. Run `npm run dev`. The API and Socket.IO server listen on `PORT` (default `3000`); REST endpoints are under `/api`.
4. From a second terminal at the workspace root, run `py -m http.server 5173`, then open `http://localhost:5173/Relay%20%E2%80%94%20Social%20interface.html`. Use the same `localhost` hostname on both frontend and API; do not switch one side to `127.0.0.1`, which changes cookie behavior.
5. Register two test accounts in separate browser sessions to verify follows, private messages, typing state, and unread badges.
6. Publish a post from one session while the other is on Home. Confirm the new post arrives at the top with a brief fade-and-slide entrance. Register another account while signed in to confirm the Who to follow list updates live.
7. Open a post's reply count, reply to it, then open a reply's count. Confirm the thread shows its parent chain and nested discussion, and the reply count updates once in both sessions.
8. Delete a test post and confirm the confirmation dialog stays compact and fits its text.
9. In the sidebar, use **Trending → Show more** to open Explore with active topics highlighted. Use **Who to follow → Show more** to open People; type any part of a name or username to see matching profiles.
10. Open another account's profile from a post or People. Confirm the page shows only public profile fields and public posts, offers follow/unfollow, and does not expose profile editing or the Likes tab. Try a made-up or malformed profile ID and confirm it returns an error rather than another account's data.
11. Use **New message** in Messages to open the anchored recipient menu, filter people, and start a conversation. Hash routes such as `#/explore`, `#/directory`, `#/users/<user-id>`, and `#/posts/<post-id>` should survive refresh and browser back/forward.
12. Publish or reply with `@<other-account-handle>` and confirm the mentioned account gets a persistent notification and the mention opens that user's profile. In two sessions, delete a post/reply, unlike, and undo a repost; verify post/reply DOM and interaction counts update without refreshing.
13. In the Home composer, choose **Add location**, enter a place name, and confirm the location chip can be removed before publishing. Publish with and without a location; verify the place label persists in the feed and on profile/thread views after a reload. The feature stores only the label entered by the user and never requests device geolocation.

For production, build the TypeScript app with `npm run build` and generate the Prisma client during the build. Set `DATABASE_URL` to the Neon pooled URL for application traffic and `DIRECT_URL` to the matching unpooled URL (the hostname must not contain `-pooler`) for Prisma migrations. `npm start` runs `prisma migrate deploy` before starting the API, so the deployment environment must provide both URLs and the Prisma CLI. A production deployment also needs TLS, a managed PostgreSQL instance, backups, monitoring, and shared Socket.IO pub/sub when running multiple API instances.

## Reels media setup and operations

The Reels API requires the `20261101120000_reels` and `20261101130000_reel_storage_cleanup` migrations. Apply them with `npm run db:migrate` locally or `npm run db:deploy` in production; the migrations are additive and have matching `down.sql` rollback scripts. The checked-in migration has not been applied automatically.

The API starts the Reel processing worker loop in the same process, in development and production. `npm run reel-worker` remains available for deployments that intentionally run a dedicated worker instead; do not run both worker modes unless needed, as they will compete for the same queue. The worker requires `ffmpeg` and `ffprobe` on `PATH` (or `FFMPEG_PATH` / `FFPROBE_PATH`); it claims queued jobs from PostgreSQL, retries failures up to three times, publishes processed videos, and cleans up expired uploads and deleted media.

Reels accept MP4, MOV, or WebM uploads up to 100 MB, 60 seconds, and 4096 pixels per dimension. The worker validates the container and metadata, rejects location metadata, transcodes video to H.264/AAC MP4, creates a JPEG preview, and strips embedded metadata. This is format validation and transcoding, not malware scanning.

`REEL_STORAGE_DRIVER=local` stores source videos and processed media in `REEL_STORAGE_DIR`, which must be outside the public `/uploads/` directory. Local storage is appropriate for development or a single server with a durable disk. For multiple API/worker instances, configure `REEL_STORAGE_DRIVER=s3`, `REEL_S3_BUCKET`, `REEL_S3_REGION`, and (if needed) `REEL_S3_ENDPOINT`; give both API and worker private access to the same bucket. Configure bucket CORS for the exact `CLIENT_ORIGIN`, `PUT`, and the `Content-Type` request header so browser uploads can use signed URLs. Signed upload URLs expire after 10 minutes; media read URLs expire after one hour. Never make the bucket public.

Ensure the reverse proxy permits request bodies up to at least 100 MB and sufficient upload/processing timeouts. Deleted Reel media is retained for seven days, then removed by the worker; `storageDeletedAt` records successful cleanup so object deletion is not retried indefinitely. Uploads left incomplete for one hour are expired by the worker.

Moderation is intentionally limited: users can report a Reel, and it is hidden when the configured pending-report threshold is reached (`REEL_REPORT_AUTO_HIDE_COUNT`, default 5). A Reel owner can inspect reports on their own content and update their statuses. This implementation does not include a central admin moderation role or block/mute-based feed exclusion.

## Neon Realtime demo

The authenticated `GET /api/realtime-demo/live` endpoint seals a query scoped to the current user. `POST /api/realtime-demo` inserts a row and returns its transaction ID. The standalone client is available at `/realtime-demo.html`; sign in with a Relay account and add a row to see it arrive through the live subscription.

Set `NEON_REALTIME_URL` and `NEON_REALTIME_SECRET` on the API. The frontend build needs `VITE_NEON_REALTIME_URL` and `VITE_API_URL`. Keep the Realtime secret server-side. The migration `20261031100000_realtime_demo` creates the demo table and should be applied with `npm run db:deploy`.

To run the end-to-end subscriber smoke test, start the API on port `3100` (`PORT=3100 npm run start`), then run `npm run test:realtime`. It creates a temporary account, waits for a live subscription, inserts a row, confirms the transaction through Realtime, and deletes the account.

## Local UI smoke test

1. On Home, open the emoji picker and composer options. Each card should align directly below its trigger without changing the composer or feed position.
2. Open Profile and use the camera buttons on the avatar and banner. Confirm that each image previews immediately and remains after reloading the page.
3. Open Settings and confirm the appearance selector uses anchored menu styling and keyboard dismissal. Check that unread badges overlap the Messages and Notifications icon corners.
4. At desktop width, open Messages and confirm the split pane fills the available main area. Use **New message**, search by part of a name or username, and select a result. Send a message; confirm it appears in the thread and the second session receives it live.
5. Type in the conversation from either session and confirm the other session displays only the sender's display name in the typing indicator. Each active typist is shown on a separate line in the reserved status area.
6. In Explore, search for a handle and a hashtag from a recent post. Resize to 375px and verify that Messages switches between the inbox list and active conversation without horizontal overflow.
7. Confirm accounts without an uploaded image use Relay's branded relay-mark avatar. On your own post, open **Post options**, edit the text, image, and location using the same full composer used for a new post, then verify the saved content and location ordering. Delete a post and confirm it fades and collapses both locally and in a second session.
8. Run `npm run test:reels`; with the API, worker, PostgreSQL, and configured private media storage running, upload an MP4/MOV/WebM, verify processing and playback, test comments and interactions, then delete a Reel and verify media cleanup after seven days.

## API

All endpoints except registration and login require `Authorization: Bearer <accessToken>`. Access tokens last 15 minutes. Refresh tokens are opaque, rotate on refresh, expire after 30 days, and only their SHA-256 hashes are persisted. Register and login set the refresh token in an HttpOnly, SameSite=Strict cookie; refresh rotates that cookie and returns a fresh access token. Send requests with credentials enabled. The frontend keeps only the short-lived access token in session storage.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/register` | Create an account |
| POST | `/api/auth/login` | Authenticate |
| POST | `/api/auth/refresh` | Rotate the HttpOnly refresh cookie and issue an access token |
| POST | `/api/auth/logout` | Revoke and clear the refresh cookie |
| GET, PATCH | `/api/users/me` | Read or edit your profile |
| GET | `/api/users/:handle` | Read a profile and follow state |
| GET | `/api/users/directory?q=<partial-name-or-handle>` | Authenticated partial search; returns up to 10 safe public profiles and viewer follow state |
| GET | `/api/users/:id/profile?tab=Posts\|Replies\|Media&limit=20&cursor=...` | Authenticated public profile and cursor-paginated public posts |
| GET | `/api/users/suggestions?limit=6&cursor=...` | Suggest users other than the viewer and already-followed accounts |
| PUT, DELETE | `/api/users/:userId/follow` | Follow or unfollow (safe to retry) |
| GET | `/api/feed?feed=for-you\|following&limit=20&cursor=...` | Cursor-paginated global or following feed |
| GET | `/api/trending` | Top hashtag topics from the past 24 hours |
| GET | `/api/search?q=...&limit=10&cursor=...` | Search post text, handles, display names, and hashtags |
| POST | `/api/posts` | Create a post or reply (`location` is an optional user-entered label, up to 80 characters) |
| GET, PATCH, DELETE | `/api/posts/:postId` | Read, edit, or soft-delete a post; PATCH can update or clear `location` |
| POST | `/api/posts/:postId/view` | Record one idempotent post view |
| POST | `/api/posts/views` | Record up to 20 idempotent post views |
| POST | `/api/posts/:postId/view` | Record one authenticated view per user, post, and browser session; requires `{ "sessionId": "<UUID>" }` |
| GET | `/api/posts/:postId/replies?limit=20&cursor=...` | Cursor-paginated replies for a thread |
| GET | `/api/posts/:postId/thread?limit=20&cursor=...` | Bounded parent chain, selected post, and cursor-paginated direct replies |
| PUT, DELETE | `/api/posts/:postId/like` | Like or unlike |
| PUT, DELETE | `/api/posts/:postId/repost` | Repost or undo repost |
| GET | `/api/users/:handle/posts` | Cursor-paginated profile posts |
| GET | `/api/explore?q=...&limit=20&cursor=...` | Search and discover people |
| GET | `/api/notifications` | Paginated notifications and unread count |
| GET | `/api/notifications/stream` | Server-Sent Events stream; reconnects with `Last-Event-ID` |
| PATCH | `/api/notifications/read` | Mark selected or all notifications as read |
| POST | `/api/uploads/:kind` | Upload one JPEG, PNG, WebP, or GIF (`kind`: `post`, `avatar`, `banner`; multipart field: `file`) |
| GET | `/api/conversations` | List direct conversations and unread counts |
| POST | `/api/conversations` | Find or create a private conversation (`{ "userId": "..." }`) |
| GET | `/api/conversations/:conversationId/messages` | Read a cursor-paginated conversation and mark it read |
| POST | `/api/conversations/:conversationId/messages` | Send a message (`{ "body": "..." }`, max 2,000 characters) |
| GET | `/api/reels/feed?limit=10&cursor=...` | Follow-prioritized, engagement-ranked Reel feed |
| GET | `/api/reels/bookmarks` | List the signed-in user's bookmarked Reels |
| POST | `/api/reels/uploads` | Create an upload and return a private-storage upload URL |
| POST | `/api/reels/local-upload` | Upload a video through the API when local storage is configured |
| POST | `/api/reels/:id/complete` | Validate a finished upload and enqueue processing |
| GET | `/api/reels/:id/status` | Read upload and processing status |
| GET | `/api/reels/:id/media/:kind` | Read a signed local-storage video or poster (`kind`: `video`, `poster`) |
| GET | `/api/reels/:id` | Read a public, ready Reel |
| POST, DELETE | `/api/reels/:id/like` | Like or unlike a Reel |
| POST, DELETE | `/api/reels/:id/bookmark` | Bookmark or remove a Reel bookmark |
| POST, DELETE | `/api/reels/:id/repost` | Repost or undo a Reel repost |
| POST | `/api/reels/:id/share` | Record a share |
| POST | `/api/reels/:id/view` | Record a view after the client observes at least three seconds of playback; deduplicated per viewer per UTC day |
| GET, POST | `/api/reels/:id/comments` | Read or add comments and one-level replies |
| DELETE | `/api/reels/:id/comments/:commentId` | Delete your own comment or a comment on your Reel |
| POST | `/api/reels/:id/report` | Submit a report against a ready Reel |
| GET | `/api/reels/:id/reports` | View report details for your own Reel |
| PATCH | `/api/reels/:id/reports/:reportId` | Update a report status for your own Reel |
| PATCH, DELETE | `/api/reels/:id` | Edit or remove your own Reel |
| GET | `/api/users/:handle/reels` | List a profile's published Reels |

Post creation accepts `{ "body": "...", "mediaUrl": "/uploads/<filename>", "location": "Brooklyn, NY", "replyToId": "..." }`; optional fields may be omitted. Replies are stored by `replyToId`, counted atomically on their parent, and appear in profile Replies—not as standalone feed, Explore, search, or profile Posts entries. Reply cards include a safe parent preview and use a distinct presentation. Hashtags in the post body are normalized and linked transactionally. Valid `@handles` in posts and replies create persistent mention notifications for matching users, and mention handles link to their public profile. Thread reply counters increment with the reply write and decrement when an authored reply is soft-deleted. The feed uses an explainable newest-first order; the `following` tab limits candidates to followed accounts plus the viewer. Pagination uses descending `(createdAt, id)` keysets, not offsets. Feed pages return `items` and `nextCursor`; pass the cursor unchanged to fetch the next page.

Post and reply cards record a view after at least 50% visibility for 1.5 seconds. The client reuses a session UUID and deduplicates recorded post IDs in `sessionStorage`; the API's unique `(userId, postId, sessionId)` constraint makes retries idempotent. Apply the `20261031170000_post_views` migration before deploying the endpoint.

Uploads are authenticated, limited to 5 MB per file, restricted to JPEG/PNG/WebP/GIF, and checked against the file signature before being served from `/uploads/`. Local disk storage is for development and single-instance deployments; production should use private object storage/CDN with image decoding, malware scanning, lifecycle cleanup, and a shared media service.

## Socket.IO

The client loads Socket.IO from the API origin and authenticates with the short-lived access token in the handshake `auth.token` field. The server verifies JWT signature, issuer, audience, expiry, and account existence, then joins the connection to its private `user:<id>` room. Connections are disconnected at token expiry; Socket.IO reconnects and the browser refreshes the session when needed.

Events sent to authenticated clients include `notification:new`, `profile:updated`, `presence:update` (online state and last-seen timestamp), `post:new` (an ID-only event for new root posts), `user:suggestion:new` (a public profile projection after registration), `post:like-count`, `post:view-count`, `post:interaction` (global like/repost count and viewer-state synchronization, including unlikes and unreposts), `post:deleted`, `post:reply-count`, `post:comment:new`, and `message:new`. Authenticated sockets send `presence:heartbeat` every 30 seconds; presence is marked offline on the final socket disconnect or when its last heartbeat is older than 90 seconds. Apply the `20261101100000_global_user_presence` migration before deploying the presence endpoint and client. Mentions are matched to existing handles and notifications are committed with their post or reply; repeated mentions in an edited post do not create duplicate notifications. Clients may request `post:join` for public post engagement rooms and `conversation:join` only for conversations where they are a member. `typing:start` and `typing:stop` are accepted only after the socket has joined that authorized conversation room; updates contain the sender's public handle and display name. Direct message delivery is persisted before emitting; unread counts are derived from each membership's `lastReadAt`.

## Data model

- `User`: normalized account/profile data and password hash, online state, and last-seen timestamp.
- `Post`: authored content, optional media URL, reply parent, atomic reply and view counts, timestamps, and soft-delete timestamp.
- `post_views`: one idempotent view record per authenticated account or daily anonymous fingerprint; existing post view counts are preserved by migration.
- `Hashtag` / `PostHashtag`: normalized hashtag catalog and relational post links.
- `Interaction`: unique user/post/type rows for likes and reposts.
- `Follow`: unique directed follower/followed relationship.
- `Notification`: actor, recipient, optional post, type (including mentions), and read timestamp.
- `RefreshToken`: user-owned, hashed, expiring rotating refresh credentials.
- `Conversation`, `ConversationMember`, and `Message`: direct threads, per-member read cursors, and persisted messages.

Indexes and unique constraints are in the Prisma schema. Likes/reposts are aggregated in a grouped query per page; feed and notification pagination use indexed keysets. The SSE notifications endpoint remains available as a fallback and polls PostgreSQL every three seconds; multi-instance deployments should use a shared Socket.IO adapter and event bus. The HTML sets its API root in `<meta name="relay-api-base">`; change it when the API is hosted elsewhere.

## Security notes

Passwords use bcrypt with cost 12. Zod validates bodies and query parameters; auth, search, message-send, view-count, and upload endpoints have rate limits; Helmet sets common security headers; CORS allows only `CLIENT_ORIGIN`. View-count identities are derived server-side, anonymous fingerprints use `POST_VIEW_HMAC_SECRET`, and count requests require an allowed app origin. The authenticated public-profile route accepts a validated user ID and returns only the explicit public projection plus the requesting viewer's follow state; it never exposes email, password hashes, or refresh tokens. Errors do not expose database details. Access tokens are short-lived and refresh tokens are HttpOnly cookies. Local media files are ignored by Git; production media should use a controlled object store and scanning pipeline.
