# Post Bookmark Audit

Audit target: `main` at `dd1ccf45ec978f6dfd751bf418cf040505e929d6`  
Scope: read-only code audit. No application code, data, accounts, or posts changed.

## Finding

**Result: C) does nothing.** The post bookmark icon is rendered, but the delegated post-action handler has no bookmark implementation. When authenticated, it handles only `like`, `repost`, and `share`. There is no local/session storage write for post bookmarks and no post-bookmark API request.

## Frontend

- `Relay — Social interface.html:19025` and `:19038` render the post bookmark button with `data-a="bookmark"`.
- `Relay — Social interface.html:31022-31039` handles delegated post-action clicks. It skips repost-menu clicks, handles comments, requires authentication, then branches only for `like` and `repost`.
- `Relay — Social interface.html:31058-31073` sends like/repost requests or copies a share URL. There is no bookmark branch after these cases. An authenticated click therefore reaches the end without changing state, sending a request, or toggling a class.
- `Relay — Social interface.html:3798` and `:9344-9413` contain bookmark styling/layout only.
- The frontend contains no post-bookmark localStorage/sessionStorage key or write. Existing storage references are for theme, auth, Reel settings/cache, view cache, drafts, notification preferences, and other unrelated state. There is no post-bookmark key to survive refresh or be shared with another browser.

## Saved-posts page

No saved-posts page or tab is present. The Home feed tabs are only `For you` and `Following` (`Relay — Social interface.html:15090-15105`). No saved-posts view or frontend route exists.

## Backend

- `backend/prisma/schema.prisma:69-97` defines `Post`; it has interactions and views, but no bookmark relation.
- `backend/prisma/schema.prisma:162-170` defines `ReelBookmark`; `User` and `Reel` relate to it at lines 38 and 138. This is Reel-only.
- `backend/prisma/schema.prisma:266-276` defines generic `Interaction`; `InteractionType` at lines 411-414 contains only `LIKE` and `REPOST`.
- `backend/src/app.ts:1916-1919` registers post like/repost routes only. There is no `/posts/:postId/bookmark` route or saved-posts endpoint.
- `backend/src/app.ts:53` mounts the Reel router. Reel bookmark listing and mutation do exist: `backend/src/reels.ts:279-310` (`GET /bookmarks`) and `:671-675` (`POST/DELETE /:id/bookmark`), backed by `ReelBookmark`.

## Storage and cross-browser behavior

No post-bookmark localStorage or sessionStorage key exists. Nothing is persisted locally or remotely, so the icon cannot retain a saved state after refresh or show saved posts in another browser.

## Options

| Option | Effort | Risk | Notes |
|---|---:|---|---|
| Remove the icon | Low | Low | Honest UI; removes a dead affordance but removes a familiar action. |
| Hide it until supported | Very low | Low | Smallest reversible change; avoids promising functionality while keeping the option to restore it later. |
| Build real backend support | Medium–high | Medium | Add a PostBookmark model/migration, authenticated create/delete/list routes, frontend state and API handling, and a saved-posts page. Requires access-control, pagination, deletion/cascade, and cross-device tests. |

**Recommendation: hide it until real support is implemented.** This is the smallest reversible fix and avoids exposing a nonfunctional control. No implementation is included in this audit.
