import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import { randomBytes, randomUUID } from "node:crypto";
import { NotificationType, Prisma, type InteractionType, type NotificationType as NotificationTypeValue } from "@prisma/client";
import { z } from "zod";
import { authOptional, authRequired, createAccessToken, hashPassword, hashRefreshToken, issueRefreshToken, verifyPassword } from "./auth";
import { clientOrigins, config } from "./config";
import { prisma } from "./db";
import { getNeonRealtime } from "./neon-realtime";
import { asyncRoute, errorHandler, HttpError } from "./http";
import { getReelStorageOrigins } from "./reel-storage";
import { reelProfileRouter, reelsRouter } from "./reels";
import { emitToAuthenticated, emitToConversation, emitToPost, emitToUser } from "./realtime";
import { audioUpload, imageUpload, readStoredUpload, saveAudio, saveImage, uploadDirectory } from "./uploads";
import { createViewerKey, viewRateLimiter, viewRequestGuard } from "./view-tracking";
import {
  loginSchema,
  messageSchema,
  pageSchema,
  postSchema,
  profileSchema,
  registerSchema,
  updateEmailSchema,
  updatePasswordSchema,
  updatePostSchema,
} from "./validation";

const app = express();
const api = express.Router();
api.use("/reels", reelsRouter);
api.use("/users", reelProfileRouter);
const publicUser = {
  id: true,
  handle: true,
  displayName: true,
  bio: true,
  avatarUrl: true,
  bannerUrl: true,
  isOnline: true,
  lastSeen: true,
  createdAt: true,
} as const;

async function withNotificationFollowState<T extends { actor: { id: string } }>(viewerId: string, notifications: T[]): Promise<T[]> {
  const actorIds = [...new Set(notifications.map((notification) => notification.actor.id))];
  const follows = actorIds.length
    ? await prisma.follow.findMany({
        where: { followerId: viewerId, followedId: { in: actorIds } },
        select: { followedId: true },
      })
    : [];
  const followedIds = new Set(follows.map((follow) => follow.followedId));
  return notifications.map((notification) => ({
    ...notification,
    actor: { ...notification.actor, viewerFollows: followedIds.has(notification.actor.id) },
  }));
}
const dummyPasswordHash = bcrypt.hash("relay-invalid-login", 12);
const refreshCookie = "relay_refresh";
const isProduction = process.env.NODE_ENV === "production";
const refreshCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? "none" as const : "strict" as const,
  path: "/api/auth",
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      mediaSrc: ["'self'", ...getReelStorageOrigins()],
    },
  },
}));
app.use(cors({
  origin: clientOrigins,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Range"],
  exposedHeaders: ["Accept-Ranges", "Content-Length", "Content-Range"],
}));
app.use(express.json({ limit: "32kb" }));
app.use("/uploads", express.static(uploadDirectory, {
  maxAge: "1d",
  immutable: true,
  setHeaders: (res) => res.setHeader("Cross-Origin-Resource-Policy", "cross-origin"),
}));
app.get("/uploads/:filename", asyncRoute(async (req, res) => {
  const filename = req.params.filename;
  if (typeof filename !== "string"
    || !/^[0-9a-f-]+\.(?:jpg|jpeg|png|webp|gif|webm|ogg|m4a|mp3|wav|aac|flac|opus)$/i.test(filename)) {
    res.sendStatus(404);
    return;
  }
  const stored = await readStoredUpload(filename);
  if (!stored) {
    res.sendStatus(404);
    return;
  }
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  if (stored.contentType) res.type(stored.contentType);
  stored.body.pipe(res);
}));
const localhostAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
app.use("/api/auth", rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => process.env.NODE_ENV !== "production"
    && localhostAddresses.has(req.socket.remoteAddress ?? ""),
}));
const uploadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const searchLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
const messageLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
const placesLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

type PostViewResult = { id: string; views: number | null; recorded: boolean };
async function recordPostView(
  tx: Prisma.TransactionClient,
  postId: string,
  viewerKey: string,
  userId: string | undefined,
): Promise<PostViewResult> {
  const [post] = await tx.$queryRaw<Array<{ id: string; authorId: string; views: number }>>(Prisma.sql`
    SELECT "id", "authorId", "view_count" AS "views"
    FROM "Post"
    WHERE "id" = ${postId} AND "deletedAt" IS NULL
    FOR UPDATE
  `);
  if (!post) return { id: postId, views: null, recorded: false };
  if (post.authorId === userId) return { id: postId, views: post.views, recorded: false };

  const inserted = await tx.$queryRaw<Array<{ post_id: string }>>(Prisma.sql`
    INSERT INTO post_views (post_id, viewer_key, user_id)
    VALUES (${postId}, ${viewerKey}, ${userId ?? null})
    ON CONFLICT (post_id, viewer_key) DO NOTHING
    RETURNING post_id
  `);
  if (!inserted.length) return { id: postId, views: post.views, recorded: false };

  const [updated] = await tx.$queryRaw<Array<{ views: number }>>(Prisma.sql`
    UPDATE "Post"
    SET "view_count" = "view_count" + 1
    WHERE "id" = ${postId} AND "deletedAt" IS NULL
    RETURNING "view_count" AS "views"
  `);
  return { id: postId, views: updated?.views ?? null, recorded: Boolean(updated) };
}

type Cursor = { createdAt: string; id: string; likes?: number; followers?: number };
const encodeCursor = (createdAt: Date, id: string): string =>
  Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id })).toString("base64url");
const encodeRankedCursor = (createdAt: Date, id: string, rank: "likes" | "followers", value: number): string =>
  Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id, [rank]: value })).toString("base64url");
const decodeCursor = (value: string | undefined): Cursor | undefined => {
  if (!value) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return z.object({
      createdAt: z.string().datetime(),
      id: z.string().cuid(),
      likes: z.number().int().nonnegative().optional(),
      followers: z.number().int().nonnegative().optional(),
    }).parse(decoded);
  } catch {
    throw new HttpError(400, "Invalid pagination cursor");
  }
};
const readRefreshCookie = (req: express.Request): string | undefined => {
  const cookie = req.header("cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${refreshCookie}=`));
  return cookie?.slice(refreshCookie.length + 1);
};

const notify = async (
  recipientId: string,
  actorId: string,
  type: NotificationTypeValue,
  postId?: string,
): Promise<void> => {
  if (recipientId === actorId) return;
  const notification = await prisma.notification.create({
    data: { recipientId, actorId, type, postId },
    include: { actor: { select: publicUser }, post: { select: { id: true, body: true } } },
  });
  emitToUser(recipientId, "notification:new", notification);
};

const postInclude = (viewerId: string) => ({
  author: { select: publicUser },
  replyTo: {
    select: {
      id: true,
      body: true,
      deletedAt: true,
      author: { select: publicUser },
    },
  },
  _count: { select: { replies: true } },
  interactions: { where: { userId: viewerId }, select: { type: true } },
  hashtags: { include: { hashtag: { select: { tag: true } } } },
});

type PostRecord = Prisma.PostGetPayload<{ include: ReturnType<typeof postInclude> }>;
type InteractionCounts = { likes: number; reposts: number };

const interactionCounts = async (postIds: string[]): Promise<Map<string, InteractionCounts>> => {
  const grouped = postIds.length
    ? await prisma.interaction.groupBy({
        by: ["postId", "type"],
        where: { postId: { in: postIds } },
        _count: { _all: true },
      })
    : [];
  const counts = new Map<string, InteractionCounts>();
  for (const row of grouped) {
    const current = counts.get(row.postId) ?? { likes: 0, reposts: 0 };
    if (row.type === "LIKE") current.likes = row._count._all;
    else current.reposts = row._count._all;
    counts.set(row.postId, current);
  }
  return counts;
};

const postResponse = (post: PostRecord, counts: InteractionCounts = { likes: 0, reposts: 0 }) => ({
  id: post.id,
  body: post.body,
  mediaUrl: post.mediaUrl,
  location: post.location,
  replyToId: post.replyToId,
  replyTo: post.replyTo && !post.replyTo.deletedAt
    ? {
        id: post.replyTo.id,
        body: post.replyTo.body,
        author: post.replyTo.author,
      }
    : null,
  hashtags: post.hashtags.map(({ hashtag }: { hashtag: { tag: string } }) => hashtag.tag),
  createdAt: post.createdAt,
  updatedAt: post.updatedAt,
  author: post.author,
  counts: {
    replies: post.replyCount,
    views: post.views,
    ...counts,
  },
  viewer: {
    liked: post.interactions.some((i: { type: InteractionType }) => i.type === "LIKE"),
    reposted: post.interactions.some((i: { type: InteractionType }) => i.type === "REPOST"),
  },
});

const extractHashtags = (body: string): string[] =>
  [...new Set(Array.from(body.matchAll(/#([\p{L}\p{N}_]{1,100})/gu), (match) => match[1].toLowerCase()))];

const syncHashtags = async (
  tx: Prisma.TransactionClient,
  postId: string,
  body: string,
): Promise<void> => {
  await tx.postHashtag.deleteMany({ where: { postId } });
  for (const tag of extractHashtags(body)) {
    const hashtag = await tx.hashtag.upsert({
      where: { tag },
      create: { tag },
      update: {},
      select: { id: true },
    });
    await tx.postHashtag.create({ data: { postId, hashtagId: hashtag.id } });
  }
};

const createMentionNotifications = async (
  tx: Prisma.TransactionClient,
  authorId: string,
  postId: string,
  body: string,
) => {
  const handles = [...new Set(
    Array.from(body.matchAll(/(?:^|[^\p{L}\p{N}_])@([a-zA-Z0-9_]{3,30})/gu), (match) => match[1].toLowerCase()),
  )];
  if (!handles.length) return [];

  const recipients = await tx.user.findMany({
    where: { handle: { in: handles }, id: { not: authorId } },
    select: { id: true },
  });
  if (!recipients.length) return [];

  const recipientIds = recipients.map(({ id }) => id);
  const existing = await tx.notification.findMany({
    where: { actorId: authorId, postId, type: NotificationType.MENTION, recipientId: { in: recipientIds } },
    select: { recipientId: true },
  });
  const existingIds = new Set(existing.map(({ recipientId }) => recipientId));
  const newRecipientIds = recipientIds.filter((id) => !existingIds.has(id));
  if (!newRecipientIds.length) return [];

  await tx.notification.createMany({
    data: newRecipientIds.map((recipientId) => ({
      recipientId,
      actorId: authorId,
      postId,
      type: NotificationType.MENTION,
    })),
  });
  return tx.notification.findMany({
    where: {
      actorId: authorId,
      postId,
      type: NotificationType.MENTION,
      recipientId: { in: newRecipientIds },
    },
    include: { actor: { select: publicUser }, post: { select: { id: true, body: true } } },
  });
};

const userCursorWhere = (cursor: Cursor | undefined): Prisma.UserWhereInput =>
  cursor
    ? {
        OR: [
          { createdAt: { lt: new Date(cursor.createdAt) } },
          { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
        ],
      }
    : {};

type TrendingItem = { term: string; postCount: number; uniqueUsers: number };
let trendingCache: { items: TrendingItem[]; expiresAt: number } | null = null;
let trendingRefresh: Promise<TrendingItem[]> | null = null;

const loadTrendingItems = async (): Promise<TrendingItem[]> => {
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
  return prisma.$queryRaw<TrendingItem[]>(Prisma.sql`
    WITH recent_posts AS (
      SELECT p."id", p."authorId", p."body", p."createdAt", p."replyCount"
      FROM "Post" AS p
      WHERE p."createdAt" >= ${since}
        AND p."deletedAt" IS NULL
    ),
    tokens AS (
      SELECT
        p."id" AS "postId",
        p."authorId",
        split.token,
        split.ordinal
      FROM recent_posts AS p
      CROSS JOIN LATERAL regexp_split_to_table(
        regexp_replace(LOWER(p."body"), '[^[:alnum:]#_]+', ' ', 'g'),
        '\\s+'
      ) WITH ORDINALITY AS split(token, ordinal)
      WHERE split.token <> ''
    ),
    stop_words(word) AS (
      VALUES
        ('about'), ('after'), ('again'), ('also'), ('and'), ('are'), ('because'),
        ('been'), ('before'), ('being'), ('but'), ('can'), ('could'), ('did'),
        ('does'), ('doing'), ('for'), ('from'), ('get'), ('got'), ('had'),
        ('has'), ('have'), ('here'), ('how'), ('into'), ('its'), ('just'),
        ('more'), ('most'), ('not'), ('now'), ('our'), ('out'), ('over'),
        ('really'), ('she'), ('should'), ('some'), ('such'), ('than'), ('that'),
        ('the'), ('their'), ('them'), ('then'), ('there'), ('these'), ('they'),
        ('this'), ('those'), ('through'), ('too'), ('under'), ('use'), ('very'),
        ('was'), ('were'), ('what'), ('when'), ('where'), ('which'), ('who'),
        ('will'), ('with'), ('would'), ('you'), ('your')
    ),
    candidate_terms AS (
      SELECT DISTINCT t."postId", t."authorId", t.token AS term
      FROM tokens AS t
      WHERE t.token ~ '^[[:alnum:]_]{3,}$'
        AND NOT EXISTS (SELECT 1 FROM stop_words AS s WHERE s.word = t.token)
      UNION
      SELECT DISTINCT first."postId", first."authorId",
        first.token || ' ' || second.token AS term
      FROM tokens AS first
      JOIN tokens AS second
        ON second."postId" = first."postId"
        AND second.ordinal = first.ordinal + 1
      WHERE first.token ~ '^[[:alnum:]_]{3,}$'
        AND second.token ~ '^[[:alnum:]_]{3,}$'
        AND NOT EXISTS (SELECT 1 FROM stop_words AS s WHERE s.word = first.token)
        AND NOT EXISTS (SELECT 1 FROM stop_words AS s WHERE s.word = second.token)
      UNION
      SELECT DISTINCT p."id", p."authorId", '#' || LOWER(h."tag") AS term
      FROM recent_posts AS p
      JOIN "PostHashtag" AS ph ON ph."postId" = p."id"
      JOIN "Hashtag" AS h ON h."id" = ph."hashtagId"
    ),
    term_post_metrics AS (
      SELECT
        candidate.term,
        recent."id" AS "postId",
        recent."authorId",
        recent."createdAt",
        recent."replyCount",
        COUNT(interaction.id) FILTER (WHERE interaction."type" = 'LIKE')::int AS likes,
        COUNT(interaction.id) FILTER (WHERE interaction."type" = 'REPOST')::int AS reposts
      FROM candidate_terms AS candidate
      JOIN recent_posts AS recent ON recent."id" = candidate."postId"
      LEFT JOIN "Interaction" AS interaction
        ON interaction."postId" = recent."id"
        AND interaction."createdAt" >= ${since}
      GROUP BY
        candidate.term,
        recent."id",
        recent."authorId",
        recent."createdAt",
        recent."replyCount"
    ),
    ranked_terms AS (
      SELECT
        metrics.term,
        SUM(
          (
            1
            + metrics.likes * 1.5
            + metrics.reposts * 3
            + metrics."replyCount" * 2
          )
          * EXP(
            -GREATEST(
              0,
              EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - metrics."createdAt"))
            ) / 21600.0
          )
        ) AS score,
        COUNT(*)::int AS "postCount",
        COUNT(DISTINCT metrics."authorId")::int AS "uniqueUsers"
      FROM term_post_metrics AS metrics
      GROUP BY term
      HAVING COUNT(*) >= 25 AND COUNT(DISTINCT metrics."authorId") >= 8
    )
    SELECT term, "postCount", "uniqueUsers"
    FROM ranked_terms
    ORDER BY score DESC, "uniqueUsers" DESC, "postCount" DESC, term ASC
    LIMIT 30
  `);
};

const getTrendingItems = (): Promise<TrendingItem[]> => {
  if (trendingCache && trendingCache.expiresAt > Date.now()) {
    return Promise.resolve(trendingCache.items);
  }
  if (!trendingRefresh) {
    trendingRefresh = loadTrendingItems()
      .then((items) => {
        trendingCache = { items, expiresAt: Date.now() + 60_000 };
        return items;
      })
      .finally(() => {
        trendingRefresh = null;
      });
  }
  return trendingRefresh;
};

const listPosts = async (
  viewerId: string,
  page: z.infer<typeof pageSchema>,
  where: Prisma.PostWhereInput,
) => {
  const cursor = decodeCursor(page.cursor);
  const cursorFilter: Prisma.PostWhereInput = cursor
    ? {
        OR: [
          { createdAt: { lt: new Date(cursor.createdAt) } },
          { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
        ],
      }
    : {};
  const records = await prisma.post.findMany({
    where: { deletedAt: null, AND: [where, cursorFilter] },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: page.limit + 1,
    include: postInclude(viewerId),
  });
  const hasMore = records.length > page.limit;
  const items = records.slice(0, page.limit);
  const last = items.at(-1);
  const interactions = await interactionCounts(items.map((item) => item.id));
  return {
    items: items.map((item) => postResponse(item, interactions.get(item.id))),
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  };
};

api.post("/auth/register", asyncRoute(async (req, res) => {
  const input = registerSchema.parse(req.body);
  const user = await prisma.user.create({
    data: {
      handle: input.handle,
      email: input.email,
      passwordHash: await hashPassword(input.password),
      displayName: input.displayName,
    },
    select: publicUser,
  });
  const refreshToken = await issueRefreshToken(user.id);
  res.cookie(refreshCookie, refreshToken, refreshCookieOptions);
  emitToAuthenticated("user:suggestion:new", user);
  res.status(201).json({ user, accessToken: createAccessToken(user.id) });
}));

api.post("/auth/login", asyncRoute(async (req, res) => {
  const input = loginSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  const valid = user
    ? await verifyPassword(input.password, user.passwordHash)
    : await bcrypt.compare(input.password, await dummyPasswordHash);
  if (!user || !valid) throw new HttpError(401, "Invalid email or password");
  const refreshToken = await issueRefreshToken(user.id);
  res.cookie(refreshCookie, refreshToken, refreshCookieOptions);
  const { passwordHash: _passwordHash, ...safeUser } = user;
  res.json({ user: safeUser, accessToken: createAccessToken(user.id) });
}));

api.get("/realtime-demo/live", authRequired, asyncRoute(async (req, res) => {
  const { rawSql } = await import("@neon/realtime/server");
  const query = rawSql<{
    id: string;
    value: string;
    createdAt: Date;
  }>(
    `SELECT "id", "value", "createdAt"
     FROM "RealtimeDemo"
     WHERE "ownerId" = $1
     ORDER BY "createdAt" DESC, "id" DESC
     LIMIT 20`,
    [req.userId!],
  );
  res.json(await (await getNeonRealtime()).seal({ query }));
}));

api.post("/realtime-demo", authRequired, asyncRoute(async (req, res) => {
  const input = z.object({ value: z.string().trim().min(1).max(240) }).parse(req.body);
  const [created] = await prisma.$queryRaw<Array<{ txid: string }>>(Prisma.sql`
    INSERT INTO "RealtimeDemo" ("id", "ownerId", "value", "createdAt")
    VALUES (${randomUUID()}, ${req.userId!}, ${input.value}, CURRENT_TIMESTAMP)
    RETURNING pg_current_xact_id()::text AS "txid"
  `);
  if (!created) throw new HttpError(500, "Could not create realtime demo row");
  res.status(201).json({ kind: "committed", txid: created.txid });
}));

api.post("/auth/refresh", asyncRoute(async (req, res) => {
  const refreshToken = readRefreshCookie(req);
  if (!refreshToken || refreshToken.length < 40 || refreshToken.length > 200) {
    throw new HttpError(401, "Invalid or expired refresh token");
  }
  const tokenHash = hashRefreshToken(refreshToken);
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!stored || stored.expiresAt <= new Date()) {
    if (stored) await prisma.refreshToken.delete({ where: { id: stored.id } });
    throw new HttpError(401, "Invalid or expired refresh token");
  }
  const replacement = await prisma.$transaction(async (tx) => {
    await tx.refreshToken.delete({ where: { id: stored.id } });
    const next = randomBytes(48).toString("base64url");
    await tx.refreshToken.create({
      data: {
        userId: stored.userId,
        tokenHash: hashRefreshToken(next),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    return next;
  });
  res.cookie(refreshCookie, replacement, refreshCookieOptions);
  res.json({ accessToken: createAccessToken(stored.userId) });
}));

api.post("/auth/logout", authRequired, asyncRoute(async (req, res) => {
  const refreshToken = readRefreshCookie(req);
  if (refreshToken) {
    await prisma.refreshToken.deleteMany({
      where: { userId: req.userId!, tokenHash: hashRefreshToken(refreshToken) },
    });
  }
  res.clearCookie(refreshCookie, { ...refreshCookieOptions, maxAge: undefined });
  res.status(204).end();
}));

api.get("/users/me", authRequired, asyncRoute(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId! }, select: { ...publicUser, email: true } });
  if (!user) throw new HttpError(404, "User not found");
  res.json(user);
}));

api.patch("/users/me/email", authRequired, asyncRoute(async (req, res) => {
  const input = updateEmailSchema.parse(req.body);
  const account = await prisma.user.findUnique({ where: { id: req.userId! }, select: { passwordHash: true } });
  if (!account || !(await verifyPassword(input.currentPassword, account.passwordHash))) {
    throw new HttpError(401, "Current password is incorrect");
  }
  const existing = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (existing && existing.id !== req.userId) throw new HttpError(409, "That email is already in use");
  const user = await prisma.user.update({
    where: { id: req.userId! },
    data: { email: input.email },
    select: { ...publicUser, email: true },
  });
  res.json(user);
}));

api.patch("/users/me/password", authRequired, asyncRoute(async (req, res) => {
  const input = updatePasswordSchema.parse(req.body);
  const account = await prisma.user.findUnique({ where: { id: req.userId! }, select: { passwordHash: true } });
  if (!account || !(await verifyPassword(input.currentPassword, account.passwordHash))) {
    throw new HttpError(401, "Current password is incorrect");
  }
  await prisma.user.update({ where: { id: req.userId! }, data: { passwordHash: await hashPassword(input.password) } });
  res.status(204).end();
}));

api.patch("/users/me", authRequired, asyncRoute(async (req, res) => {
  const input = profileSchema.parse(req.body);
  const user = await prisma.user.update({
    where: { id: req.userId! },
    data: input,
    select: publicUser,
  });
  emitToUser(user.id, "profile:updated", user);
  const followers = await prisma.follow.findMany({
    where: { followedId: user.id },
    select: { followerId: true },
  });
  for (const follower of followers) emitToUser(follower.followerId, "profile:updated", user);
  res.json(user);
}));

api.post("/uploads/audio", authRequired, uploadLimiter, audioUpload, asyncRoute(async (req, res) => {
  if (!req.file) throw new HttpError(400, "Choose an audio recording");
  const url = await saveAudio(req.file);
  res.status(201).json({ url });
}));

api.post("/uploads/:kind", authRequired, uploadLimiter, imageUpload, asyncRoute(async (req, res) => {
  const kind = z.enum(["post", "avatar", "banner", "message"]).parse(req.params.kind);
  if (!req.file) throw new HttpError(400, "Choose an image to upload");
  const url = await saveImage(req.file);
  if (kind === "avatar" || kind === "banner") {
    const user = await prisma.user.update({
      where: { id: req.userId! },
      data: kind === "avatar" ? { avatarUrl: url } : { bannerUrl: url },
      select: publicUser,
    });
    emitToUser(user.id, "profile:updated", user);
    const followers = await prisma.follow.findMany({ where: { followedId: user.id }, select: { followerId: true } });
    for (const follower of followers) emitToUser(follower.followerId, "profile:updated", user);
    res.status(201).json({ url, kind, user });
    return;
  }
  res.status(201).json({ url, kind });
}));

api.get("/users/suggestions", authRequired, asyncRoute(async (req, res) => {
  const page = pageSchema.parse(req.query);
  const following = await prisma.follow.findMany({
    where: { followerId: req.userId! },
    select: { followedId: true },
  });
  const followingIds = following.map((follow) => follow.followedId);
  const [mutualEdges, interestPosts] = await Promise.all([
    followingIds.length
      ? prisma.follow.findMany({
          where: { followerId: { in: followingIds }, followedId: { not: req.userId! } },
          select: { followerId: true, followedId: true },
        })
      : Promise.resolve([]),
    prisma.postHashtag.findMany({
      where: {
        post: {
          deletedAt: null,
          OR: [
            { authorId: req.userId! },
            { interactions: { some: { userId: req.userId! } } },
          ],
        },
      },
      select: { hashtag: { select: { tag: true } } },
      take: 100,
    }),
  ]);
  const mutualCounts = new Map<string, number>();
  for (const edge of mutualEdges) mutualCounts.set(edge.followedId, (mutualCounts.get(edge.followedId) || 0) + 1);
  const interestTerms = new Set(interestPosts.map((item) => item.hashtag.tag.toLowerCase()));
  const viewer = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { bio: true },
  });
  for (const term of (viewer?.bio || "").toLowerCase().match(/[a-z0-9\u00c0-\u024f]{3,}/gi) || []) interestTerms.add(term);
  const records = await prisma.user.findMany({
    where: {
      id: { not: req.userId! },
      followers: { none: { followerId: req.userId! } },
    },
    select: {
      ...publicUser,
      _count: { select: { followers: true } },
      posts: {
        where: { deletedAt: null },
        select: { createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 3,
      },
    },
    take: 200,
  });
  const candidateIds = records.map((record) => record.id);
  const followsYou = candidateIds.length
    ? new Set((await prisma.follow.findMany({
        where: { followerId: { in: candidateIds }, followedId: req.userId! },
        select: { followerId: true },
      })).map((follow) => follow.followerId))
    : new Set<string>();
  const scored = records.map(({ posts, _count, ...user }) => {
    const mutualScore = Math.min(mutualCounts.get(user.id) || 0, 5) * 100;
    const profileText = `${user.bio} ${user.displayName} ${user.handle}`.toLowerCase();
    const interestScore = [...interestTerms].filter((term) => profileText.includes(term)).length * 18;
    const latestActivity = posts[0]?.createdAt?.getTime() || user.createdAt.getTime();
    const activityScore = Math.max(0, 30 - ((Date.now() - latestActivity) / 86_400_000) * 4);
    return {
      ...user,
      followerCount: _count.followers,
      viewerFollows: false,
      followsYou: followsYou.has(user.id),
      recommendationScore: mutualScore + interestScore + activityScore,
    };
  }).sort((a, b) => b.recommendationScore - a.recommendationScore || b.createdAt.getTime() - a.createdAt.getTime());
  const items = scored.slice(0, Math.min(page.limit, 4)).map(({ recommendationScore: _score, ...user }) => user);
  res.json({
    items,
    nextCursor: null,
  });
}));

api.get("/users/directory", authRequired, searchLimiter, asyncRoute(async (req, res) => {
  const rawQuery = z.string().trim().min(1).max(60).parse(req.query.q ?? req.query.handle);
  const query = rawQuery.startsWith("@") ? rawQuery.slice(1) : rawQuery;
  if (!query) throw new HttpError(400, "Enter at least one character to search");
  const users = await prisma.user.findMany({
    where: {
      id: { not: req.userId! },
      OR: [
        { handle: { contains: query, mode: "insensitive" } },
        { displayName: { contains: query, mode: "insensitive" } },
      ],
    },
    select: {
      ...publicUser,
      _count: { select: { followers: true } },
      followers: { where: { followerId: req.userId! }, select: { followerId: true } },
    },
    orderBy: [{ handle: "asc" }, { id: "asc" }],
    take: 10,
  });
  res.json({
    items: users.map(({ _count, followers, ...user }) => ({
      ...user,
      followerCount: _count.followers,
      viewerFollows: followers.length > 0,
    })),
  });
}));

api.get("/places/search", authRequired, placesLimiter, asyncRoute(async (req, res) => {
  const query = z.string().trim().min(2).max(100).parse(req.query.q);
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.search = new URLSearchParams({
    q: query,
    format: "jsonv2",
    addressdetails: "1",
    limit: "6",
    "accept-language": "en",
  }).toString();
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Relay/1.0 place search (https://github.com/relay-social)",
      },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new HttpError(502, "Place search is temporarily unavailable");
  }
  if (!response.ok) throw new HttpError(502, "Place search is temporarily unavailable");
  const results = await response.json() as Array<{
    place_id?: number;
    display_name?: string;
    lat?: string;
    lon?: string;
    address?: { city?: string; town?: string; village?: string; municipality?: string; country?: string };
  }>;
  res.json({
    items: results
      .filter((place) => place.display_name)
      .map((place) => ({
        id: String(place.place_id ?? place.display_name),
        label: place.display_name,
        shortLabel: [
          place.address?.city || place.address?.town || place.address?.village || place.address?.municipality,
          place.address?.country,
        ].filter(Boolean).join(", ") || place.display_name,
        latitude: place.lat ?? null,
        longitude: place.lon ?? null,
      })),
  });
}));

api.get("/users/:id/profile", authRequired, asyncRoute(async (req, res) => {
  const userId = z.string().cuid().parse(req.params.id);
  const page = pageSchema.parse(req.query);
  const tab = z.enum(["Posts", "Replies", "Media"]).default("Posts").parse(req.query.tab);
  const feedOnly = req.query.feedOnly === "true";
  if (feedOnly) {
    const profile = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!profile) throw new HttpError(404, "User not found");
    const where: Prisma.PostWhereInput = { authorId: profile.id };
    if (tab === "Replies") {
      where.replyToId = { not: null };
    } else {
      where.replyToId = null;
      if (tab === "Media") where.mediaUrl = { not: null };
    }
    res.json({ posts: await listPosts(req.userId!, page, where) });
    return;
  }
  const profile = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      ...publicUser,
      _count: { select: { followers: true, following: true } },
      followers: { where: { followerId: req.userId! }, select: { followerId: true } },
    },
  });
  if (!profile) throw new HttpError(404, "User not found");
  const where: Prisma.PostWhereInput = { authorId: profile.id };
  if (tab === "Replies") {
    where.replyToId = { not: null };
  } else {
    where.replyToId = null;
    if (tab === "Media") where.mediaUrl = { not: null };
  }
  const posts = await listPosts(req.userId!, page, where);
  const { _count, followers, ...user } = profile;
  const postCount = await prisma.post.count({
    where: {
      authorId: profile.id,
      deletedAt: null,
      replyToId: null,
    },
  });
  res.json({
    user: {
      ...user,
      viewerFollows: followers.length > 0,
      counts: { followers: _count.followers, following: _count.following, posts: postCount },
    },
    posts,
  });
}));

api.get("/users/:handle", authRequired, asyncRoute(async (req, res) => {
  const handle = z.string().regex(/^[a-zA-Z0-9_]{3,30}$/).parse(req.params.handle).toLowerCase();
  const user = await prisma.user.findUnique({
    where: { handle },
    select: {
      ...publicUser,
      _count: { select: { followers: true, following: true, posts: true } },
      followers: { where: { followerId: req.userId! }, select: { followerId: true } },
    },
  });
  if (!user) throw new HttpError(404, "User not found");
  res.json({
    ...user,
    viewerFollows: user.followers.length > 0,
    counts: user._count,
    followers: undefined,
    _count: undefined,
  });
}));

api.put("/users/:userId/follow", authRequired, asyncRoute(async (req, res) => {
  const targetId = z.string().cuid().parse(req.params.userId);
  if (targetId === req.userId) throw new HttpError(400, "You cannot follow yourself");
  const key = { followerId_followedId: { followerId: req.userId!, followedId: targetId } };
  const existing = await prisma.follow.findUnique({ where: key });
  await prisma.follow.upsert({
    where: key,
    create: { followerId: req.userId!, followedId: targetId },
    update: {},
  });
  if (!existing) {
    await notify(targetId, req.userId!, "FOLLOW");
    emitToUser(req.userId!, "user:followed", { userId: targetId });
  }
  res.status(204).end();
}));

api.delete("/users/:userId/follow", authRequired, asyncRoute(async (req, res) => {
  const targetId = z.string().cuid().parse(req.params.userId);
  await prisma.follow.deleteMany({ where: { followerId: req.userId!, followedId: targetId } });
  res.status(204).end();
}));

api.get("/feed", authRequired, asyncRoute(async (req, res) => {
  const page = pageSchema.parse(req.query);
  const feed = z.enum(["for-you", "following"]).default("for-you").parse(req.query.feed);
  const where: Prisma.PostWhereInput = { replyToId: null };
  if (feed === "following") {
    const follows = await prisma.follow.findMany({
      where: { followerId: req.userId! },
      select: { followedId: true },
    });
    where.authorId = { in: follows.map((follow) => follow.followedId) };
  }
  res.json(await listPosts(req.userId!, page, where));
}));

api.get("/posts/:postId", authRequired, asyncRoute(async (req, res) => {
  const postId = z.string().cuid().parse(req.params.postId);
  const post = await prisma.post.findFirst({
    where: { id: postId, deletedAt: null },
    include: postInclude(req.userId!),
  });
  if (!post) throw new HttpError(404, "Post not found");
  const counts = await interactionCounts([post.id]);
  res.json(postResponse(post, counts.get(post.id)));
}));

api.post("/posts/:postId/view", authOptional, viewRequestGuard, viewRateLimiter, asyncRoute(async (req, res) => {
  const postId = z.string().cuid().parse(req.params.postId);
  z.object({}).strict().parse(req.body ?? {});
  const viewerKey = createViewerKey(req);
  const result = await prisma.$transaction((tx) => recordPostView(tx, postId, viewerKey, req.userId));
  if (result.recorded && result.views !== null) {
    emitToAuthenticated("post:view-count", { postId, views: result.views });
  }
  res.json(result);
}));

api.post("/posts/views", authOptional, viewRequestGuard, viewRateLimiter, asyncRoute(async (req, res) => {
  const { ids } = z.object({
    ids: z.array(z.string().cuid()).min(1).max(20),
  }).strict().parse(req.body);
  const viewerKey = createViewerKey(req);
  const uniqueIds = [...new Set(ids)].sort();
  const results = await prisma.$transaction(async (tx) => {
    const items: PostViewResult[] = [];
    for (const postId of uniqueIds) {
      items.push(await recordPostView(tx, postId, viewerKey, req.userId));
    }
    return items;
  });
  results.forEach((result) => {
    if (result.recorded && result.views !== null) {
      emitToAuthenticated("post:view-count", { postId: result.id, views: result.views });
    }
  });
  res.json({ items: results });
}));

api.get("/posts/:postId/replies", authRequired, asyncRoute(async (req, res) => {
  const postId = z.string().cuid().parse(req.params.postId);
  const parent = await prisma.post.findFirst({
    where: { id: postId, deletedAt: null },
    select: { id: true },
  });
  if (!parent) throw new HttpError(404, "Post not found");
  res.json(await listPosts(req.userId!, pageSchema.parse(req.query), { replyToId: postId }));
}));

api.get("/posts/:postId/thread", authRequired, asyncRoute(async (req, res) => {
  const postId = z.string().cuid().parse(req.params.postId);
  const page = pageSchema.parse(req.query);
  const chain = await prisma.$queryRaw<Array<{ id: string; parentId: string | null; depth: number }>>(Prisma.sql`
    WITH RECURSIVE thread_chain AS (
      SELECT id, "replyToId" AS "parentId", 0 AS depth
      FROM "Post"
      WHERE id = ${postId} AND "deletedAt" IS NULL
      UNION ALL
      SELECT parent.id, parent."replyToId" AS "parentId", thread_chain.depth + 1
      FROM "Post" AS parent
      INNER JOIN thread_chain ON parent.id = thread_chain."parentId"
      WHERE parent."deletedAt" IS NULL AND thread_chain.depth < 20
    )
    SELECT id, "parentId", depth FROM thread_chain ORDER BY depth DESC
  `);
  if (!chain.length) throw new HttpError(404, "Post not found");

  const records = await prisma.post.findMany({
    where: { id: { in: chain.map(({ id }) => id) }, deletedAt: null },
    include: postInclude(req.userId!),
  });
  const byId = new Map(records.map((record) => [record.id, record]));
  const interactions = await interactionCounts(records.map((record) => record.id));
  const root = byId.get(postId);
  if (!root) throw new HttpError(404, "Post not found");
  const ancestors = chain
    .filter(({ id }) => id !== postId)
    .map(({ id }) => byId.get(id))
    .filter((record): record is NonNullable<typeof record> => Boolean(record))
    .map((record) => postResponse(record, interactions.get(record.id)));

  res.json({
    ancestors,
    ancestorsTruncated: chain[0]?.depth === 20 && Boolean(chain[0].parentId),
    post: postResponse(root, interactions.get(root.id)),
    replies: await listPosts(req.userId!, page, { replyToId: postId }),
  });
}));

api.post("/posts", authRequired, asyncRoute(async (req, res) => {
  const input = postSchema.parse(req.body);
  let replyRecipientId: string | undefined;
  if (input.replyToId) {
    const parent = await prisma.post.findFirst({
      where: { id: input.replyToId, deletedAt: null },
      select: { id: true, authorId: true },
    });
    if (!parent) throw new HttpError(404, "Reply target not found");
    replyRecipientId = parent.authorId;
  }
  const { post, mentionNotifications } = await prisma.$transaction(async (tx) => {
    const created = await tx.post.create({
      data: { ...input, authorId: req.userId! },
      include: postInclude(req.userId!),
    });
    await syncHashtags(tx, created.id, input.body);
    if (input.replyToId) {
      const parentUpdated = await tx.post.updateMany({
        where: { id: input.replyToId, deletedAt: null },
        data: { replyCount: { increment: 1 } },
      });
      if (!parentUpdated.count) throw new HttpError(404, "Reply target not found");
    }
    const post = await tx.post.findUniqueOrThrow({
      where: { id: created.id },
      include: postInclude(req.userId!),
    });
    const mentionNotifications = await createMentionNotifications(
      tx,
      req.userId!,
      created.id,
      input.body,
    );
    return { post, mentionNotifications };
  });
  if (replyRecipientId) await notify(replyRecipientId, req.userId!, "REPLY", post.id);
  for (const notification of mentionNotifications) {
    emitToUser(notification.recipientId, "notification:new", notification);
  }
  const counts = await interactionCounts([post.id]);
  const response = postResponse(post, counts.get(post.id));
  if (input.replyToId) emitToPost(input.replyToId, "post:comment:new", response);
  else emitToAuthenticated("post:new", { postId: post.id, authorId: req.userId });
  emitToAuthenticated("trending:updated", {});
  res.status(201).json(response);
}));

api.patch("/posts/:postId", authRequired, asyncRoute(async (req, res) => {
  const postId = z.string().cuid().parse(req.params.postId);
  const input = updatePostSchema.parse(req.body);
  const existing = await prisma.post.findFirst({
    where: { id: postId, deletedAt: null },
    select: { authorId: true },
  });
  if (!existing) throw new HttpError(404, "Post not found");
  if (existing.authorId !== req.userId) throw new HttpError(403, "You can only edit your own posts");
  const { post, mentionNotifications } = await prisma.$transaction(async (tx) => {
    await tx.post.update({
      where: { id: postId },
      data: input,
    });
    await syncHashtags(tx, postId, input.body);
    const post = await tx.post.findUniqueOrThrow({
      where: { id: postId },
      include: postInclude(req.userId!),
    });
    const mentionNotifications = await createMentionNotifications(
      tx,
      req.userId!,
      postId,
      input.body,
    );
    return { post, mentionNotifications };
  });
  for (const notification of mentionNotifications) {
    emitToUser(notification.recipientId, "notification:new", notification);
  }
  const counts = await interactionCounts([post.id]);
  const updatedPost = postResponse(post, counts.get(post.id));
  emitToAuthenticated("post:updated", { postId: post.id, post: updatedPost });
  emitToAuthenticated("trending:updated", {});
  res.json(updatedPost);
}));

api.delete("/posts/:postId", authRequired, asyncRoute(async (req, res) => {
  const postId = z.string().cuid().parse(req.params.postId);
  const post = await prisma.post.findFirst({
    where: { id: postId, deletedAt: null },
    select: { authorId: true, replyToId: true },
  });
  if (!post) throw new HttpError(404, "Post not found");
  if (post.authorId !== req.userId) throw new HttpError(403, "You can only delete your own posts");
  const { deletedPosts, updatedParentReplyCount } = await prisma.$transaction(async (tx) => {
    const deletedPosts = await tx.$queryRaw<{ id: string; replyToId: string | null }[]>`
      WITH RECURSIVE post_tree AS (
        SELECT id, "replyToId"
        FROM "Post"
        WHERE id = ${postId}
        UNION ALL
        SELECT child.id, child."replyToId"
        FROM "Post" AS child
        INNER JOIN post_tree AS parent ON child."replyToId" = parent.id
      )
      SELECT id, "replyToId" FROM post_tree
    `;
    const deleted = await tx.post.deleteMany({
      where: { id: postId, authorId: req.userId! },
    });
    if (!deleted.count) throw new HttpError(404, "Post not found");
    let updatedParentReplyCount: number | null = null;
    if (post.replyToId) {
      const parentUpdated = await tx.post.updateMany({
        where: { id: post.replyToId, deletedAt: null, replyCount: { gt: 0 } },
        data: { replyCount: { decrement: 1 } },
      });
      if (parentUpdated.count) {
        const parent = await tx.post.findUnique({
          where: { id: post.replyToId },
          select: { replyCount: true },
        });
        updatedParentReplyCount = parent?.replyCount ?? null;
      }
    }
    return { deletedPosts, updatedParentReplyCount };
  });
  emitToAuthenticated("post:deleted", {
    postId,
    replyToId: post.replyToId,
    authorId: req.userId,
    deletedPosts,
  });
  emitToAuthenticated("trending:updated", {});
  if (post.replyToId && updatedParentReplyCount !== null) {
    emitToAuthenticated("post:reply-count", {
      postId: post.replyToId,
      replies: updatedParentReplyCount,
    });
  }
  res.json({ deletedPosts });
}));

const setInteraction = (
  type: InteractionType,
  active: boolean,
): ReturnType<typeof asyncRoute> => asyncRoute(async (req, res) => {
  const postId = z.string().cuid().parse(req.params.postId);
  const post = await prisma.post.findFirst({
    where: { id: postId, deletedAt: null },
    select: { id: true, authorId: true },
  });
  if (!post) throw new HttpError(404, "Post not found");
  if (active) {
    const key = { userId_postId_type: { userId: req.userId!, postId, type } };
    const existing = await prisma.interaction.findUnique({ where: key });
    await prisma.interaction.upsert({
      where: key,
      create: { userId: req.userId!, postId, type },
      update: {},
    });
    if (!existing) await notify(post.authorId, req.userId!, type === "LIKE" ? "LIKE" : "REPOST", postId);
  } else {
    await prisma.interaction.deleteMany({ where: { userId: req.userId!, postId, type } });
  }
  const count = await prisma.interaction.count({ where: { postId, type } });
  emitToAuthenticated("post:interaction", {
    postId,
    type,
    active,
    userId: req.userId,
    count,
  });
  if (type === "LIKE") emitToPost(postId, "post:like-count", { postId, likes: count });
  res.status(204).end();
});

api.put("/posts/:postId/like", authRequired, setInteraction("LIKE", true));
api.delete("/posts/:postId/like", authRequired, setInteraction("LIKE", false));
api.put("/posts/:postId/repost", authRequired, setInteraction("REPOST", true));
api.delete("/posts/:postId/repost", authRequired, setInteraction("REPOST", false));

api.get("/users/:handle/posts", authRequired, asyncRoute(async (req, res) => {
  const page = pageSchema.parse(req.query);
  const handle = z.string().regex(/^[a-zA-Z0-9_]{3,30}$/).parse(req.params.handle).toLowerCase();
  const tab = z.enum(["Posts", "Replies", "Media", "Likes"]).default("Posts").parse(req.query.tab);
  const user = await prisma.user.findUnique({ where: { handle }, select: { id: true } });
  if (!user) throw new HttpError(404, "User not found");
  if (tab === "Likes" && user.id !== req.userId) {
    throw new HttpError(403, "Liked posts are private to their owner");
  }
  const where: Prisma.PostWhereInput = { authorId: user.id };
  if (tab === "Replies") {
    where.replyToId = { not: null };
  } else {
    where.replyToId = null;
    if (tab === "Media") where.mediaUrl = { not: null };
  }
  if (tab === "Likes") {
    where.interactions = { some: { userId: user.id, type: "LIKE" } };
  }
  res.json(await listPosts(req.userId!, page, where));
}));

api.get("/explore", authRequired, asyncRoute(async (req, res) => {
  const page = pageSchema.parse(req.query);
  const q = z.string().trim().max(100).optional().parse(req.query.q);
  const cursor = decodeCursor(page.cursor);
  const where: Prisma.UserWhereInput = q
    ? { OR: [{ handle: { contains: q, mode: "insensitive" } }, { displayName: { contains: q, mode: "insensitive" } }] }
    : {};
  const records = await prisma.user.findMany({
    where: { AND: [where, { id: { not: req.userId! } }, userCursorWhere(cursor)] },
    select: {
      ...publicUser,
      _count: { select: { followers: true } },
      followers: { where: { followerId: req.userId! }, select: { followerId: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: page.limit + 1,
  });
  const hasMore = records.length > page.limit;
  const users = records.slice(0, page.limit);
  const last = users.at(-1);
  res.json({
    items: users.map(({ followers, _count, ...user }) => ({
      ...user,
      followerCount: _count.followers,
      viewerFollows: followers.length > 0,
    })),
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  });
}));

api.get("/trending", authRequired, asyncRoute(async (_req, res) => {
  const items = await getTrendingItems();
  res.json({
    items: items.map((item) => ({
      tag: item.term,
      postCount: item.postCount,
      uniqueUsers: item.uniqueUsers,
    })),
  });
}));

api.get("/search", authRequired, searchLimiter, asyncRoute(async (req, res) => {
  const rawQuery = z.string().trim().min(1).max(100).parse(req.query.q);
  const page = pageSchema.parse(req.query);
  const mode = z.enum(["top", "latest", "people", "hashtags", "users"]).default("top").parse(req.query.mode);
  const q = rawQuery.replace(/^[@#]+/, "").trim();
  if (!q) {
    res.json({
      posts: { items: [], nextCursor: null },
      users: [],
      hashtags: [],
      nextCursor: null,
    });
    return;
  }
  const cursor = decodeCursor(page.cursor);
  const normalizedTag = q.toLowerCase();
  if (mode === "hashtags") {
    const hashtags = await prisma.hashtag.findMany({
      where: { tag: { contains: normalizedTag, mode: "insensitive" } },
      select: { tag: true },
      take: page.limit,
      orderBy: { tag: "asc" },
    });
    res.json({
      posts: { items: [], nextCursor: null },
      users: [],
      hashtags: hashtags.map(({ tag }) => tag),
      nextCursor: null,
    });
    return;
  }
  if (mode === "people" || mode === "users") {
    if (cursor && cursor.followers === undefined) throw new HttpError(400, "Invalid people search cursor");
    const cursorFilter = cursor
      ? Prisma.sql`HAVING
          COUNT(f."followerId") < ${cursor.followers!}
          OR (
            COUNT(f."followerId") = ${cursor.followers!}
            AND (
              u."createdAt" < ${new Date(cursor.createdAt)}
              OR (u."createdAt" = ${new Date(cursor.createdAt)} AND u."id" < ${cursor.id})
            )
          )`
      : Prisma.empty;
    const rankedUsers = await prisma.$queryRaw<Array<{ id: string; createdAt: Date; followers: number }>>(Prisma.sql`
      SELECT u."id", u."createdAt", COUNT(f."followerId")::int AS "followers"
      FROM "User" AS u
      LEFT JOIN "Follow" AS f ON f."followedId" = u."id"
      WHERE u."id" <> ${req.userId!}
        AND (
          POSITION(LOWER(${q}) IN LOWER(u."handle")) > 0
          OR POSITION(LOWER(${q}) IN LOWER(u."displayName")) > 0
        )
      GROUP BY u."id"
      ${cursorFilter}
      ORDER BY COUNT(f."followerId") DESC, u."createdAt" DESC, u."id" DESC
      LIMIT ${page.limit + 1}
    `);
    const hasMore = rankedUsers.length > page.limit;
    const items = rankedUsers.slice(0, page.limit);
    const records = items.length
      ? await prisma.user.findMany({
          where: { id: { in: items.map(({ id }) => id) } },
          select: {
            ...publicUser,
            _count: { select: { followers: true } },
            followers: { where: { followerId: req.userId! }, select: { followerId: true } },
          },
        })
      : [];
    const usersById = new Map(records.map((user) => [user.id, user]));
    const last = items.at(-1);
    const nextCursor = hasMore && last
      ? encodeRankedCursor(last.createdAt, last.id, "followers", last.followers)
      : null;
    res.json({
      posts: { items: [], nextCursor: null },
      users: items.map(({ id }) => {
        const { followers, _count, ...user } = usersById.get(id)!;
        return { ...user, followerCount: _count.followers, viewerFollows: followers.length > 0 };
      }),
      hashtags: [],
      nextCursor,
    });
    return;
  }

  const postWhere: Prisma.PostWhereInput = {
    replyToId: null,
    OR: [
      { body: { contains: q, mode: "insensitive" } },
      { hashtags: { some: { hashtag: { tag: { contains: normalizedTag, mode: "insensitive" } } } } },
    ],
  };
  let posts: Awaited<ReturnType<typeof listPosts>>;
  if (mode === "latest") {
    posts = await listPosts(req.userId!, page, postWhere);
  } else {
    if (cursor && cursor.likes === undefined) throw new HttpError(400, "Invalid top search cursor");
    const cursorFilter = cursor
      ? Prisma.sql`HAVING
          COUNT(i."id") < ${cursor.likes!}
          OR (
            COUNT(i."id") = ${cursor.likes!}
            AND (
              p."createdAt" < ${new Date(cursor.createdAt)}
              OR (p."createdAt" = ${new Date(cursor.createdAt)} AND p."id" < ${cursor.id})
            )
          )`
      : Prisma.empty;
    const rankedPosts = await prisma.$queryRaw<Array<{ id: string; createdAt: Date; likes: number }>>(Prisma.sql`
      SELECT p."id", p."createdAt", COUNT(i."id")::int AS "likes"
      FROM "Post" AS p
      LEFT JOIN "Interaction" AS i ON i."postId" = p."id" AND i."type" = 'LIKE'
      WHERE p."deletedAt" IS NULL
        AND p."replyToId" IS NULL
        AND (
          POSITION(LOWER(${q}) IN LOWER(p."body")) > 0
          OR EXISTS (
            SELECT 1
            FROM "PostHashtag" AS ph
            JOIN "Hashtag" AS h ON h."id" = ph."hashtagId"
            WHERE ph."postId" = p."id"
              AND POSITION(LOWER(${normalizedTag}) IN LOWER(h."tag")) > 0
          )
        )
      GROUP BY p."id"
      ${cursorFilter}
      ORDER BY COUNT(i."id") DESC, p."createdAt" DESC, p."id" DESC
      LIMIT ${page.limit + 1}
    `);
    const hasMore = rankedPosts.length > page.limit;
    const items = rankedPosts.slice(0, page.limit);
    const records = items.length
      ? await prisma.post.findMany({
          where: { id: { in: items.map(({ id }) => id) } },
          include: postInclude(req.userId!),
        })
      : [];
    const recordsById = new Map(records.map((record) => [record.id, record]));
    const interactions = await interactionCounts(items.map(({ id }) => id));
    const last = items.at(-1);
    const nextCursor = hasMore && last
      ? encodeRankedCursor(last.createdAt, last.id, "likes", last.likes)
      : null;
    posts = {
      items: items.map(({ id }) => postResponse(recordsById.get(id)!, interactions.get(id))),
      nextCursor,
    };
  }
  res.json({
    posts,
    users: [],
    hashtags: [],
    nextCursor: posts.nextCursor,
  });
}));

api.get("/conversations", authRequired, asyncRoute(async (req, res) => {
  const rows = await prisma.conversationMember.findMany({
    where: { userId: req.userId! },
    include: {
      conversation: {
        include: {
          members: { include: { user: { select: publicUser } } },
          messages: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, include: { sender: { select: publicUser } } },
        },
      },
    },
    orderBy: { conversation: { updatedAt: "desc" } },
    take: 50,
  });
  const conversationIds = rows.map((row) => row.conversationId);
  const unreadRows = conversationIds.length
    ? await prisma.$queryRaw<Array<{ conversationId: string; unreadCount: number }>>(Prisma.sql`
        SELECT member."conversationId", COUNT(DISTINCT message."senderId")::int AS "unreadCount"
        FROM "ConversationMember" AS member
        LEFT JOIN "Message" AS message
          ON message."conversationId" = member."conversationId"
          AND message."senderId" <> member."userId"
          AND (member."lastReadAt" IS NULL OR message."createdAt" > member."lastReadAt")
        WHERE member."userId" = ${req.userId}
          AND member."conversationId" IN (${Prisma.join(conversationIds)})
        GROUP BY member."conversationId"
      `)
    : [];
  const unread = new Map(unreadRows.map((row) => [row.conversationId, row.unreadCount]));
  res.json({
    items: rows.map((row) => ({
      id: row.conversationId,
      updatedAt: row.conversation.updatedAt,
      members: row.conversation.members.map(({ user }) => user),
      lastMessage: row.conversation.messages[0] ?? null,
      unreadCount: unread.get(row.conversationId) ?? 0,
    })),
  });
}));

api.get("/conversations/search", authRequired, searchLimiter, asyncRoute(async (req, res) => {
  const rawQuery = z.string().trim().min(1).max(100).parse(req.query.q);
  const limit = z.coerce.number().int().min(1).max(50).default(50).parse(req.query.limit);
  const offset = z.coerce.number().int().min(0).max(100000).default(0).parse(req.query.offset);
  const requestedConversationId = z.string().cuid().optional().parse(req.query.conversationId);
  const searchMode = z.enum(["all", "conversations", "messages"]).default("all").parse(req.query.mode);
  const normalizedQuery = rawQuery.normalize("NFKC").toLowerCase();
  const terms = [...new Set(normalizedQuery.split(/\s+/).filter(Boolean))]
    .map((term) => term.replace(/[\\%_]/g, "\\$&"));
  const phrase = normalizedQuery.replace(/[\\%_]/g, "\\$&");
  const matchingMessage = (term: string) => Prisma.sql`
    EXISTS (
      SELECT 1
      FROM "Message" AS message
      WHERE message."conversationId" = conversation."id"
        AND message."body" ILIKE ${`%${term}%`} ESCAPE '\\'
    )
  `;
  const matchingParticipant = (term: string) => Prisma.sql`
    EXISTS (
      SELECT 1
      FROM "ConversationMember" AS peer
      JOIN "User" AS participant ON participant."id" = peer."userId"
      WHERE peer."conversationId" = conversation."id"
        AND peer."userId" <> ${req.userId!}
        AND (
          participant."displayName" ILIKE ${`%${term}%`} ESCAPE '\\'
          OR participant."handle" ILIKE ${`%${term}%`} ESCAPE '\\'
        )
    )
  `;
  const matchingAllMessageTerms = Prisma.sql`
    EXISTS (
      SELECT 1
      FROM "Message" AS message
      WHERE message."conversationId" = conversation."id"
        AND ${Prisma.join(terms.map((term) => Prisma.sql`
          message."body" ILIKE ${`%${term}%`} ESCAPE '\\'
        `), " AND ")}
    )
  `;
  const messageCountRows = searchMode === "messages"
    ? await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS "count"
      FROM "Message" AS message
      JOIN "ConversationMember" AS viewer
        ON viewer."conversationId" = message."conversationId"
        AND viewer."userId" = ${req.userId!}
      WHERE ${Prisma.join(terms.map((term) => Prisma.sql`
        message."body" ILIKE ${`%${term}%`} ESCAPE '\\'
      `), " AND ")}
      ${requestedConversationId
        ? Prisma.sql`AND message."conversationId" = ${requestedConversationId}`
        : Prisma.empty}
    `)
    : [];
  const messageCount = messageCountRows[0]?.count ?? 0;
  const searchedMessages = searchMode === "messages"
    ? await prisma.$queryRaw<Array<{ id: string; conversationId: string }>>(Prisma.sql`
      SELECT message."id", message."conversationId"
      FROM "Message" AS message
      JOIN "ConversationMember" AS viewer
        ON viewer."conversationId" = message."conversationId"
        AND viewer."userId" = ${req.userId!}
      WHERE ${Prisma.join(terms.map((term) => Prisma.sql`
        message."body" ILIKE ${`%${term}%`} ESCAPE '\\'
      `), " AND ")}
      ${requestedConversationId
        ? Prisma.sql`AND message."conversationId" = ${requestedConversationId}`
        : Prisma.empty}
      ORDER BY message."createdAt" ASC, message."id" ASC
      LIMIT ${limit}
      OFFSET ${offset}
    `)
    : [];
  const termConditions = searchMode === "messages"
    ? [matchingAllMessageTerms]
    : terms.map((term) => searchMode === "conversations"
      ? matchingParticipant(term)
      : Prisma.sql`(${matchingMessage(term)} OR ${matchingParticipant(term)})`);
  const rankedConversations = searchMode === "messages"
    ? []
    : await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT conversation."id"
    FROM "Conversation" AS conversation
    JOIN "ConversationMember" AS viewer
      ON viewer."conversationId" = conversation."id"
      AND viewer."userId" = ${req.userId!}
    WHERE ${Prisma.join(termConditions, " AND ")}
    ${requestedConversationId
      ? Prisma.sql`AND conversation."id" = ${requestedConversationId}`
      : Prisma.empty}
    ORDER BY
      (
        CASE WHEN ${matchingMessage(phrase)} THEN 8 ELSE 0 END
        + CASE WHEN ${matchingParticipant(phrase)} THEN 6 ELSE 0 END
      ) DESC,
      conversation."updatedAt" DESC,
      conversation."id" DESC
    LIMIT ${limit}
  `);
  const matchingMessages = searchMode === "messages"
    ? searchedMessages
    : searchMode === "conversations" || !rankedConversations.length
      ? []
      : await prisma.$queryRaw<Array<{ id: string; conversationId: string }>>(Prisma.sql`
        WITH ranked_messages AS (
          SELECT
            message."id",
            message."conversationId",
            ROW_NUMBER() OVER (
              PARTITION BY message."conversationId"
              ORDER BY message."createdAt" ASC, message."id" ASC
            ) AS message_rank
          FROM "Message" AS message
          WHERE message."conversationId" IN (${Prisma.join(rankedConversations.map(({ id }) => id))})
            AND ${Prisma.join(terms.map((term) => Prisma.sql`
              message."body" ILIKE ${`%${term}%`} ESCAPE '\\'
            `), " AND ")}
        )
        SELECT "id", "conversationId"
        FROM ranked_messages
        WHERE message_rank = 1
      `);
  const conversationIds = searchMode === "messages"
    ? [...new Set(matchingMessages.map(({ conversationId }) => conversationId))]
    : rankedConversations.map(({ id }) => id);
  if (!conversationIds.length) {
    res.json({ items: [], count: messageCount });
    return;
  }
  const matchedMessageIds = matchingMessages.map(({ id }) => id);
  const matchedMessages = matchedMessageIds.length
    ? await prisma.message.findMany({
        where: { id: { in: matchedMessageIds } },
        include: { sender: { select: publicUser } },
      })
    : [];
  const matchedMessagesById = new Map(matchedMessages.map((message) => [message.id, message]));
  const matchedMessageByConversation = new Map(
    matchingMessages.map(({ id, conversationId }) => [
      conversationId,
      matchedMessagesById.get(id) ?? null,
    ]),
  );
  const rows = await prisma.conversation.findMany({
    where: { id: { in: conversationIds } },
    include: {
      members: { include: { user: { select: publicUser } } },
      messages: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
        include: { sender: { select: publicUser } },
      },
    },
  });
  const unreadRows = await prisma.$queryRaw<Array<{ conversationId: string; unreadCount: number }>>(Prisma.sql`
    SELECT member."conversationId", COUNT(DISTINCT message."senderId")::int AS "unreadCount"
    FROM "ConversationMember" AS member
    LEFT JOIN "Message" AS message
      ON message."conversationId" = member."conversationId"
      AND message."senderId" <> member."userId"
      AND (member."lastReadAt" IS NULL OR message."createdAt" > member."lastReadAt")
    WHERE member."userId" = ${req.userId!}
      AND member."conversationId" IN (${Prisma.join(conversationIds)})
    GROUP BY member."conversationId"
  `);
  const unread = new Map(unreadRows.map((row) => [row.conversationId, row.unreadCount]));
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const serializeConversation = (id: string, matchedMessageId?: string) => {
    const row = rowsById.get(id);
    if (!row) return null;
    return {
      id: row.id,
      updatedAt: row.updatedAt,
      members: row.members.map(({ user }) => user),
      lastMessage: row.messages[0] ?? null,
      matchedMessage: matchedMessageId === undefined
        ? matchedMessageByConversation.get(row.id) ?? null
        : matchedMessagesById.get(matchedMessageId) ?? null,
      unreadCount: unread.get(row.id) ?? 0,
    };
  };
  res.json({
    count: messageCount,
    items: searchMode === "messages"
      ? matchingMessages.flatMap(({ conversationId, id }) => {
        const item = serializeConversation(conversationId, id);
        return item ? [item] : [];
      })
      : rankedConversations.flatMap(({ id }) => {
        const item = serializeConversation(id);
        return item ? [item] : [];
      }),
  });
}));

api.post("/conversations", authRequired, asyncRoute(async (req, res) => {
  const { userId: recipientId } = z.object({ userId: z.string().cuid() }).parse(req.body);
  if (recipientId === req.userId) throw new HttpError(400, "You cannot message yourself");
  const recipient = await prisma.user.findUnique({ where: { id: recipientId }, select: { id: true } });
  if (!recipient) throw new HttpError(404, "User not found");
  const directKey = [req.userId!, recipientId].sort().join(":");
  const conversation = await prisma.conversation.upsert({
    where: { directKey },
    create: {
      directKey,
      members: { create: [{ userId: req.userId! }, { userId: recipientId }] },
    },
    update: {},
    include: { members: { include: { user: { select: publicUser } } } },
  });
  res.status(200).json({
    id: conversation.id,
    members: conversation.members.map(({ user }) => user),
  });
}));

api.get("/conversations/:conversationId/messages", authRequired, asyncRoute(async (req, res) => {
  const conversationId = z.string().cuid().parse(req.params.conversationId);
  const page = pageSchema.parse(req.query);
  const memberKey = { conversationId_userId: { conversationId, userId: req.userId! } };
  const member = await prisma.conversationMember.findUnique({ where: memberKey, select: { conversationId: true } });
  if (!member) throw new HttpError(404, "Conversation not found");
  const cursor = decodeCursor(page.cursor);
  const records = await prisma.message.findMany({
    where: {
      conversationId,
      ...(cursor ? {
        OR: [
          { createdAt: { lt: new Date(cursor.createdAt) } },
          { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
        ],
      } : {}),
    },
    include: { sender: { select: publicUser } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: page.limit + 1,
  });
  await prisma.conversationMember.update({ where: memberKey, data: { lastReadAt: new Date() } });
  const hasMore = records.length > page.limit;
  const items = records.slice(0, page.limit).reverse();
  const oldest = items[0];
  res.json({
    items,
    nextCursor: hasMore && oldest ? encodeCursor(oldest.createdAt, oldest.id) : null,
  });
}));

api.post("/conversations/:conversationId/messages", authRequired, messageLimiter, asyncRoute(async (req, res) => {
  const conversationId = z.string().cuid().parse(req.params.conversationId);
  const messageInput = messageSchema.parse(req.body);
  const members = await prisma.conversationMember.findMany({
    where: { conversationId },
    select: { userId: true },
  });
  if (!members.some((member) => member.userId === req.userId)) throw new HttpError(404, "Conversation not found");
  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: { conversationId, senderId: req.userId!, ...messageInput },
      include: { sender: { select: publicUser } },
    });
    await tx.conversation.update({ where: { id: conversationId }, data: { updatedAt: created.createdAt } });
    return created;
  });
  emitToConversation(conversationId, "message:new", message);
  for (const member of members) {
    if (member.userId !== req.userId) {
      emitToUser(member.userId, "message:new", message);
      emitToUser(member.userId, "messages:unread-increment", { conversationId });
    }
  }
  res.status(201).json(message);
}));

api.get("/notifications", authRequired, asyncRoute(async (req, res) => {
  const page = pageSchema.parse(req.query);
  const cursor = decodeCursor(page.cursor);
  const records = await prisma.notification.findMany({
    where: {
      recipientId: req.userId!,
      ...(cursor
        ? { OR: [{ createdAt: { lt: new Date(cursor.createdAt) } }, { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } }] }
        : {}),
    },
    include: { actor: { select: publicUser }, post: { select: { id: true, body: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: page.limit + 1,
  });
  const hasMore = records.length > page.limit;
  const items = records.slice(0, page.limit);
  const last = items.at(-1);
  res.json({
    items: await withNotificationFollowState(req.userId!, items),
    unreadCount: await prisma.notification.count({ where: { recipientId: req.userId!, readAt: null } }),
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  });
}));

api.get("/notifications/stream", authRequired, asyncRoute(async (req, res) => {
  const lastEventId = req.header("last-event-id");
  const resumeFrom = lastEventId
    ? await prisma.notification.findFirst({
        where: { id: lastEventId, recipientId: req.userId! },
        select: { id: true, createdAt: true },
      })
    : null;
  let cursor = resumeFrom ?? { id: "", createdAt: new Date() };
  let polling = false;
  res.status(200).set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write("retry: 5000\n\n");

  const timer = setInterval(async () => {
    if (polling || res.writableEnded || res.destroyed) return;
    polling = true;
    try {
      const fresh = await prisma.notification.findMany({
        where: {
          recipientId: req.userId!,
          OR: [
            { createdAt: { gt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { gt: cursor.id } },
          ],
        },
        include: { actor: { select: publicUser }, post: { select: { id: true, body: true } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 100,
      });
      for (const notification of await withNotificationFollowState(req.userId!, fresh)) {
        if (res.destroyed) return;
        res.write(`id: ${notification.id}\nevent: notification\ndata: ${JSON.stringify(notification)}\n\n`);
        cursor = { id: notification.id, createdAt: notification.createdAt };
      }
      if (!fresh.length && !res.destroyed) res.write(": keep-alive\n\n");
    } catch (error) {
      if (res.destroyed) return;
      console.error("Notification stream poll failed", error);
      res.write("event: error\ndata: {\"error\":\"Notification stream temporarily unavailable\"}\n\n");
    } finally {
      polling = false;
    }
  }, 3000);
  res.on("close", () => clearInterval(timer));
}));

api.patch("/notifications/read", authRequired, asyncRoute(async (req, res) => {
  const { ids } = z.object({ ids: z.array(z.string().cuid()).min(1).max(100).optional() }).parse(req.body);
  const result = await prisma.notification.updateMany({
    where: {
      recipientId: req.userId!,
      readAt: null,
      ...(ids ? { id: { in: ids } } : {}),
    },
    data: { readAt: new Date() },
  });
  res.json({ updated: result.count });
}));

app.use("/api", api);
app.use((_req, res) => res.status(404).json({ error: "Route not found" }));
app.use(errorHandler);

export { app };
