import { createHash, randomUUID } from "node:crypto";
import express, { type RequestHandler } from "express";
import multer from "multer";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import {
  NotificationType,
  ProcessingJobType,
  ProcessingJobStatus,
  ReelReportReason,
  ReelReportStatus,
  ReelStatus,
  Prisma,
} from "@prisma/client";
import { z } from "zod";
import { authOptional, authRequired } from "./auth";
import { config } from "./config";
import { prisma } from "./db";
import { asyncRoute, HttpError } from "./http";
import { emitToUser } from "./realtime";
import { wakeReelWorker } from "./reel-worker";
import {
  createLocalReelReadUrl,
  createReelReadUrl,
  createReelStorageKey,
  createReelUploadUrl,
  deleteReelObject,
  getReelObjectHead,
  getReelObjectStream,
  putReelBuffer,
  readReelObjectPrefix,
  verifyLocalReelReadUrl,
} from "./reel-storage";
import { detectReelContainer } from "./reel-processing";

const router = express.Router();
const profileRouter = express.Router();
const uuidSchema = z.string().uuid();
const profileUserSelect = {
  id: true,
  handle: true,
  displayName: true,
  avatarUrl: true,
} as const;
const relationInclude = (userId: string | null) => ({
  author: { select: profileUserSelect },
  likes: { where: { userId: userId ?? "__anonymous__" }, select: { userId: true } },
  bookmarks: { where: { userId: userId ?? "__anonymous__" }, select: { userId: true } },
  reposts: { where: { userId: userId ?? "__anonymous__" }, select: { userId: true } },
});

const isFollowing = async (viewerId: string | null, authorId: string): Promise<boolean> =>
  (await followingAuthors(viewerId, [authorId])).has(authorId);
type ReelRecord = Prisma.ReelGetPayload<{ include: ReturnType<typeof relationInclude> }>;
type ProfileCursor = { createdAt: string; id: string };
type FeedCursor = ProfileCursor & {
  followRank: number;
  score: number;
  asOf: string;
};

const profileCursorSchema = z.object({
  createdAt: z.string().datetime(),
  id: uuidSchema,
});
const localUploadOnly: RequestHandler = (_req, _res, next) => {
  if (config.REEL_STORAGE_DRIVER !== "local") {
    next(new HttpError(404, "Local uploads are disabled"));
    return;
  }
  next();
};
const feedCursorSchema = profileCursorSchema.extend({
  followRank: z.number().int().min(0).max(1),
  score: z.number().finite(),
  asOf: z.string().datetime(),
});
const uploadSchema = z.object({
  caption: z.string().max(280).nullable().optional(),
  mime: z.enum(["video/mp4", "video/quicktime", "video/webm"]),
  sizeBytes: z.number().int().positive().max(config.REEL_MAX_UPLOAD_BYTES),
});
const captionSchema = z.object({ caption: z.string().max(280).nullable() });
const completeSchema = captionSchema.partial();
const commentSchema = z.object({
  body: z.string().trim().min(1).max(280),
  replyToId: z.string().cuid().optional(),
});
const reportSchema = z.object({
  reason: z.nativeEnum(ReelReportReason),
  details: z.string().trim().max(1000).optional(),
});
const reportStatusSchema = z.object({
  status: z.enum([ReelReportStatus.DISMISSED, ReelReportStatus.ACTIONED]),
});
const paginationSchema = z.object({
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});
const mediaKindSchema = z.enum(["video", "poster"]);

const writeLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId ?? ipKeyGenerator(req.ip ?? "unknown"),
});
const uploadLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId ?? ipKeyGenerator(req.ip ?? "unknown"),
});
const viewLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
const statusLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId ?? ipKeyGenerator(req.ip ?? "unknown"),
});
const multipartUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.REEL_MAX_UPLOAD_BYTES, files: 1 },
});
const reelMultipartUpload: RequestHandler = (req, res, next) => {
  multipartUpload.single("file")(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError) {
      next(new HttpError(error.code === "LIMIT_FILE_SIZE" ? 413 : 400, "Reel upload is invalid or too large"));
      return;
    }
    next(error);
  });
};

const parseCursor = <T>(value: string | undefined, schema: z.ZodType<T>): T | undefined => {
  if (!value) return undefined;
  try {
    return schema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    throw new HttpError(400, "Invalid pagination cursor");
  }
};
const encodeCursor = (cursor: ProfileCursor | FeedCursor): string =>
  Buffer.from(JSON.stringify(cursor)).toString("base64url");
const reelIdFrom = (value: string | string[] | undefined): string => uuidSchema.parse(value);
const viewerIdFrom = (req: express.Request): string => {
  if (!req.userId) throw new HttpError(401, "Authentication required");
  return req.userId;
};

const followingAuthors = async (viewerId: string | null, authorIds: string[]): Promise<Set<string>> => {
  if (!viewerId || !authorIds.length) return new Set();
  const follows = await prisma.follow.findMany({
    where: { followerId: viewerId, followedId: { in: [...new Set(authorIds)] } },
    select: { followedId: true },
  });
  return new Set(follows.map((follow) => follow.followedId));
};

const mediaUrl = async (reelId: string, key: string | null, kind: "video" | "poster"): Promise<string | null> => {
  if (!key) return null;
  return config.REEL_STORAGE_DRIVER === "s3"
    ? createReelReadUrl(key)
    : createLocalReelReadUrl(reelId, kind);
};

const reelResponse = async (reel: ReelRecord, followsAuthor: boolean) => ({
  id: reel.id,
  caption: reel.caption,
  status: reel.status,
  durationMs: reel.durationMs,
  width: reel.width,
  height: reel.height,
  createdAt: reel.createdAt,
  publishedAt: reel.publishedAt,
  author: { ...reel.author, isFollowing: followsAuthor },
  counts: {
    likes: reel.likeCount,
    comments: reel.commentCount,
    reposts: reel.repostCount,
    shares: reel.shareCount,
    views: reel.viewCount,
  },
  viewer: {
    liked: reel.likes.length > 0,
    bookmarked: reel.bookmarks.length > 0,
    reposted: reel.reposts.length > 0,
  },
  videoUrl: await mediaUrl(reel.id, reel.videoKey, "video"),
  posterUrl: await mediaUrl(reel.id, reel.posterKey, "poster"),
});

const ensureVisibleReel = async (reelId: string): Promise<{
  id: string;
  authorId: string;
  status: ReelStatus;
}> => {
  const reel = await prisma.reel.findFirst({
    where: { id: reelId, status: ReelStatus.READY, deletedAt: null },
    select: { id: true, authorId: true, status: true },
  });
  if (!reel) throw new HttpError(404, "Reel not found");
  return reel;
};

const notificationInclude = {
  actor: { select: { id: true, handle: true, displayName: true, avatarUrl: true } },
} as const;

const encodeViewerKey = (req: express.Request): string => {
  if (req.userId) return `user:${req.userId}`;
  const digest = createHash("sha256")
    .update(config.JWT_ACCESS_SECRET)
    .update("\0")
    .update(req.ip ?? "unknown")
    .update("\0")
    .update(req.header("user-agent") ?? "")
    .digest("hex");
  return `anon:${digest}`;
};

router.get("/feed", authOptional, asyncRoute(async (req, res) => {
  const { cursor: rawCursor, limit } = paginationSchema.parse(req.query);
  const cursor = parseCursor(rawCursor, feedCursorSchema);
  const asOf = cursor ? new Date(cursor.asOf) : new Date();
  const viewerId = req.userId ?? null;
  const viewerKey = encodeViewerKey(req);
  const seenAfter = new Date(Date.now() - 7 * 24 * 60 * 60_000);
  const seenFilter = Prisma.sql`
    AND NOT EXISTS (
      SELECT 1 FROM "ReelView" seen
      WHERE seen."reelId" = r."id"
        AND seen."viewerKey" = ${viewerKey}
        AND seen."createdAt" >= ${seenAfter}
    )
  `;
  const cursorFilter = cursor
    ? Prisma.sql`
      WHERE "followRank" > ${cursor.followRank}
        OR ("followRank" = ${cursor.followRank} AND (
          "score" < ${cursor.score}
          OR ("score" = ${cursor.score} AND (
            "publishedAt" < ${new Date(cursor.createdAt)}
            OR ("publishedAt" = ${new Date(cursor.createdAt)} AND "id" < ${cursor.id}::uuid)
          ))
        ))
    `
    : Prisma.empty;

  type RankedReel = {
    id: string;
    caption: string | null;
    authorId: string;
    authorHandle: string;
    authorDisplayName: string;
    authorAvatarUrl: string | null;
    status: ReelStatus;
    videoKey: string | null;
    posterKey: string | null;
    durationMs: number | null;
    width: number | null;
    height: number | null;
    likeCount: number;
    commentCount: number;
    repostCount: number;
    shareCount: number;
    viewCount: number;
    createdAt: Date;
    publishedAt: Date;
    viewerLiked: boolean;
    viewerBookmarked: boolean;
    viewerReposted: boolean;
    followRank: number;
    score: number;
  };

  // Engagement/hour is time-decayed; followed authors are promoted ahead of the score-ranked public feed.
  const rows = await prisma.$queryRaw<RankedReel[]>`
    WITH ranked AS (
      SELECT
        r."id", r."caption", r."authorId", u."handle" AS "authorHandle",
        u."displayName" AS "authorDisplayName", u."avatarUrl" AS "authorAvatarUrl",
        r."status", r."videoKey", r."posterKey", r."durationMs", r."width", r."height",
        r."likeCount", r."commentCount", r."repostCount", r."shareCount", r."viewCount",
        r."createdAt", r."publishedAt",
        EXISTS (
          SELECT 1 FROM "ReelLike" liked
          WHERE liked."reelId" = r."id" AND liked."userId" = ${viewerId ?? ""}
        ) AS "viewerLiked",
        EXISTS (
          SELECT 1 FROM "ReelBookmark" saved
          WHERE saved."reelId" = r."id" AND saved."userId" = ${viewerId ?? ""}
        ) AS "viewerBookmarked",
        EXISTS (
          SELECT 1 FROM "ReelRepost" reposted
          WHERE reposted."reelId" = r."id" AND reposted."userId" = ${viewerId ?? ""}
        ) AS "viewerReposted",
        CASE WHEN EXISTS (
          SELECT 1 FROM "Follow" f
          WHERE f."followerId" = ${viewerId ?? ""} AND f."followedId" = r."authorId"
        ) THEN 0 ELSE 1 END AS "followRank",
        (
          (r."likeCount" + 2.0 * r."commentCount" + 2.0 * r."repostCount"
            + 0.25 * r."shareCount" + 0.05 * r."viewCount")
          / POWER(GREATEST(1.0, EXTRACT(EPOCH FROM (${asOf}::timestamp - r."publishedAt")) / 3600.0 + 1), 1.2)
        )::double precision AS "score"
      FROM "Reel" r
      JOIN "User" u ON u."id" = r."authorId"
      WHERE r."status" = 'READY'
        AND r."deletedAt" IS NULL
        AND r."publishedAt" IS NOT NULL
        ${seenFilter}
    )
    SELECT * FROM ranked
    ${cursorFilter}
    ORDER BY "followRank" ASC, "score" DESC, "publishedAt" DESC, "id" DESC
    LIMIT ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const items = await Promise.all(page.map(async (reel) => ({
    id: reel.id,
    caption: reel.caption,
    status: reel.status,
    durationMs: reel.durationMs,
    width: reel.width,
    height: reel.height,
    createdAt: reel.createdAt,
    publishedAt: reel.publishedAt,
    author: {
      id: reel.authorId,
      handle: reel.authorHandle,
      displayName: reel.authorDisplayName,
      avatarUrl: reel.authorAvatarUrl,
      isFollowing: reel.followRank === 0,
    },
    counts: {
      likes: reel.likeCount,
      comments: reel.commentCount,
      reposts: reel.repostCount,
      shares: reel.shareCount,
      views: reel.viewCount,
    },
    viewer: {
      liked: reel.viewerLiked,
      bookmarked: reel.viewerBookmarked,
      reposted: reel.viewerReposted,
    },
    videoUrl: await mediaUrl(reel.id, reel.videoKey, "video"),
    posterUrl: await mediaUrl(reel.id, reel.posterKey, "poster"),
  })));
  const last = page.at(-1);
  res.json({
    items,
    nextCursor: hasMore && last
      ? encodeCursor({
          createdAt: last.publishedAt.toISOString(),
          id: last.id,
          followRank: last.followRank,
          score: last.score,
          asOf: asOf.toISOString(),
        })
      : null,
  });
}));

router.get("/bookmarks", authRequired, asyncRoute(async (req, res) => {
  const { cursor: rawCursor, limit } = paginationSchema.parse(req.query);
  const cursor = parseCursor(rawCursor, profileCursorSchema);
  const userId = viewerIdFrom(req);
  const bookmarks = await prisma.reelBookmark.findMany({
    where: {
      userId,
      reel: { status: ReelStatus.READY, deletedAt: null },
      ...(cursor ? {
        OR: [
          { createdAt: { lt: new Date(cursor.createdAt) } },
          { createdAt: new Date(cursor.createdAt), reelId: { lt: cursor.id } },
        ],
      } : {}),
    },
    include: { reel: { include: relationInclude(userId) } },
    orderBy: [{ createdAt: "desc" }, { reelId: "desc" }],
    take: limit + 1,
  });
  const hasMore = bookmarks.length > limit;
  const page = bookmarks.slice(0, limit);
  const followedAuthors = await followingAuthors(userId, page.map(({ reel }) => reel.authorId));
  const items = await Promise.all(page.map(({ reel }) =>
    reelResponse(reel, followedAuthors.has(reel.authorId))));
  const last = page.at(-1);
  res.json({
    items,
    nextCursor: hasMore && last
      ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.reelId })
      : null,
  });
}));

router.post("/uploads", authRequired, uploadLimiter, asyncRoute(async (req, res) => {
  const input = uploadSchema.parse(req.body);
  const userId = viewerIdFrom(req);
  const reelId = randomUUID();
  const originalKey = createReelStorageKey(reelId, "original");
  const uploadUrl = await createReelUploadUrl(originalKey, input.mime, input.sizeBytes);
  const reel = await prisma.reel.create({
    data: {
      id: reelId,
      authorId: userId,
      caption: input.caption ?? null,
      originalKey,
      sizeBytes: BigInt(input.sizeBytes),
      mime: input.mime,
    },
    select: { id: true, status: true },
  });
  res.status(201).json({
    id: reel.id,
    status: reel.status,
    upload: {
      method: config.REEL_STORAGE_DRIVER === "s3" ? "PUT" : "POST",
      url: uploadUrl,
      headers: config.REEL_STORAGE_DRIVER === "s3" ? { "Content-Type": input.mime } : {},
    },
  });
}));

router.post("/local-upload", authRequired, writeLimiter, localUploadOnly, reelMultipartUpload, asyncRoute(async (req, res) => {
  const reelId = uuidSchema.parse(req.body.reelId);
  const file = req.file;
  if (!file) throw new HttpError(400, "Choose a video to upload");
  const reel = await prisma.reel.findFirst({
    where: { id: reelId, authorId: viewerIdFrom(req), status: ReelStatus.UPLOADING, deletedAt: null },
    select: { id: true, originalKey: true, sizeBytes: true },
  });
  if (!reel) throw new HttpError(404, "Reel upload not found");
  if (BigInt(file.size) !== reel.sizeBytes) throw new HttpError(400, "Uploaded video size does not match the upload request");

  const mime = detectReelContainer(file.buffer);
  if (!mime) throw new HttpError(400, "Upload must be an MP4, MOV, or WebM video");
  await putReelBuffer(reel.originalKey, file.buffer, mime);
  await prisma.reel.update({
    where: { id: reel.id },
    data: { mime },
  });
  res.status(204).end();
}));

router.post("/:id/complete", authRequired, writeLimiter, asyncRoute(async (req, res) => {
  const reelId = reelIdFrom(req.params.id);
  const input = completeSchema.parse(req.body ?? {});
  const reel = await prisma.reel.findFirst({
    where: { id: reelId, authorId: viewerIdFrom(req), deletedAt: null },
    select: { id: true, originalKey: true, sizeBytes: true, status: true },
  });
  if (!reel) throw new HttpError(404, "Reel upload not found");
  if (reel.status === ReelStatus.PROCESSING || reel.status === ReelStatus.READY) {
    res.status(202).json({ id: reel.id, status: reel.status });
    return;
  }
  if (reel.status !== ReelStatus.UPLOADING) throw new HttpError(409, "This Reel upload cannot be completed");

  const head = await getReelObjectHead(reel.originalKey);
  if (!head) throw new HttpError(409, "The video has not finished uploading");
  if (head.contentLength <= 0 || head.contentLength > config.REEL_MAX_UPLOAD_BYTES
    || BigInt(head.contentLength) !== reel.sizeBytes) {
    await deleteReelObject(reel.originalKey);
    await prisma.reel.update({
      where: { id: reel.id },
      data: { status: ReelStatus.FAILED, processingError: "Uploaded video size is invalid" },
    });
    throw new HttpError(413, "Uploaded video is empty or exceeds the 100 MB limit");
  }
  if (!detectReelContainer(await readReelObjectPrefix(reel.originalKey))) {
    await deleteReelObject(reel.originalKey);
    await prisma.reel.update({
      where: { id: reel.id },
      data: { status: ReelStatus.FAILED, processingError: "Upload is not a supported video container" },
    });
    throw new HttpError(400, "Upload must be an MP4, MOV, or WebM video");
  }

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.reel.updateMany({
      where: { id: reel.id, status: ReelStatus.UPLOADING },
      data: {
        status: ReelStatus.PROCESSING,
        ...(input.caption !== undefined ? { caption: input.caption } : {}),
      },
    });
    if (updated.count !== 1) return false;
    await tx.processingJob.create({
      data: {
        type: ProcessingJobType.PROCESS_REEL,
        payload: { reelId: reel.id },
      },
    });
    return true;
  });
  if (!result) throw new HttpError(409, "This Reel upload is already being processed");
  wakeReelWorker();
  res.status(202).json({ id: reel.id, status: ReelStatus.PROCESSING });
}));

router.get("/:id/status", authRequired, statusLimiter, asyncRoute(async (req, res) => {
  const reelId = reelIdFrom(req.params.id);
  const reel = await prisma.reel.findFirst({
    where: { id: reelId, authorId: viewerIdFrom(req) },
    select: { id: true, status: true, processingError: true, durationMs: true },
  });
  if (!reel) throw new HttpError(404, "Reel not found");
  const body = {
    id: reel.id,
    status: reel.status,
    processingError: reel.processingError,
    durationMs: reel.durationMs,
  };
  const etag = `"${createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 24)}"`;
  res.set({ "Cache-Control": "no-store", ETag: etag });
  if (req.fresh) {
    res.status(304).end();
    return;
  }
  res.json(body);
}));

router.get("/:id/media/:kind", asyncRoute(async (req, res) => {
  const reelId = reelIdFrom(req.params.id);
  const kind = mediaKindSchema.parse(req.params.kind);
  const reel = await prisma.reel.findFirst({
    where: { id: reelId, status: ReelStatus.READY, deletedAt: null },
    select: { videoKey: true, posterKey: true },
  });
  if (!reel) throw new HttpError(404, "Reel not found");
  const key = kind === "video" ? reel.videoKey : reel.posterKey;
  if (!key) throw new HttpError(404, "Reel media not found");

  if (config.REEL_STORAGE_DRIVER === "s3") {
    res.redirect(302, await createReelReadUrl(key));
    return;
  }
  if (!verifyLocalReelReadUrl(reelId, kind, req.query.expires?.toString(), req.query.signature?.toString())) {
    throw new HttpError(403, "Media link is invalid or expired");
  }

  const range = req.header("range");
  if (range && !/^bytes=\d+-\d*$/.test(range)) {
    res.status(416).end();
    return;
  }
  let file;
  try {
    file = await getReelObjectStream(key, range);
  } catch (error) {
    const invalidRange = error instanceof RangeError
      || (typeof error === "object" && error !== null && "name" in error && error.name === "InvalidRange");
    if (!invalidRange) throw error;
    const head = await getReelObjectHead(key);
    res.setHeader("Content-Range", `bytes */${head?.contentLength ?? 0}`);
    res.status(416).end();
    return;
  }
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("Content-Type", file.contentType || (kind === "video" ? "video/mp4" : "image/jpeg"));
  if (file.contentLength !== undefined) res.setHeader("Content-Length", file.contentLength);
  if (file.contentRange) {
    res.status(206);
    res.setHeader("Content-Range", file.contentRange);
  }
  file.body.on("error", (error) => {
    console.error(`Failed to stream ${kind} media for Reel ${reelId}:`, error);
    res.destroy(error);
  });
  file.body.pipe(res);
}));

router.get("/:id", authOptional, asyncRoute(async (req, res) => {
  const reelId = reelIdFrom(req.params.id);
  const viewerId = req.userId ?? null;
  const reel = await prisma.reel.findUnique({
    where: { id: reelId },
    include: relationInclude(viewerId),
  });
  if (!reel || reel.deletedAt || reel.status === ReelStatus.REMOVED
    || (reel.status !== ReelStatus.READY && reel.authorId !== viewerId)) {
    res.status(410).json({ unavailable: true, error: "This Reel is unavailable" });
    return;
  }
  if (reel.status !== ReelStatus.READY) {
    res.json({
      id: reel.id,
      status: reel.status,
      processingError: reel.authorId === viewerId ? reel.processingError : null,
    });
    return;
  }
  res.json(await reelResponse(reel, await isFollowing(viewerId, reel.authorId)));
}));

const makeInteractionResponse = (reel: {
  likeCount: number;
  commentCount: number;
  repostCount: number;
  shareCount: number;
  viewCount: number;
}, viewer: { liked: boolean; bookmarked: boolean; reposted: boolean }) => ({
  counts: {
    likes: reel.likeCount,
    comments: reel.commentCount,
    reposts: reel.repostCount,
    shares: reel.shareCount,
    views: reel.viewCount,
  },
  viewer,
});

type RelationKind = "like" | "bookmark" | "repost";

const setRelation = async (
  req: express.Request,
  res: express.Response,
  kind: RelationKind,
  active: boolean,
): Promise<void> => {
  const reelId = reelIdFrom(req.params.id);
  const userId = viewerIdFrom(req);
  const result = await prisma.$transaction(async (tx) => {
    const reel = await tx.reel.findFirst({
      where: { id: reelId, status: ReelStatus.READY, deletedAt: null },
      select: { id: true, authorId: true },
    });
    if (!reel) throw new HttpError(404, "Reel not found");

    let changed = 0;
    if (kind === "like") {
      changed = active
        ? (await tx.reelLike.createMany({ data: { userId, reelId }, skipDuplicates: true })).count
        : (await tx.reelLike.deleteMany({ where: { userId, reelId } })).count;
      if (changed) {
        await tx.reel.update({
          where: { id: reelId },
          data: { likeCount: { [active ? "increment" : "decrement"]: 1 } },
        });
      }
    } else if (kind === "bookmark") {
      changed = active
        ? (await tx.reelBookmark.createMany({ data: { userId, reelId }, skipDuplicates: true })).count
        : (await tx.reelBookmark.deleteMany({ where: { userId, reelId } })).count;
    } else {
      changed = active
        ? (await tx.reelRepost.createMany({ data: { userId, reelId }, skipDuplicates: true })).count
        : (await tx.reelRepost.deleteMany({ where: { userId, reelId } })).count;
      if (changed) {
        await tx.reel.update({
          where: { id: reelId },
          data: { repostCount: { [active ? "increment" : "decrement"]: 1 } },
        });
      }
    }

    let notification = null;
    if (active && changed && reel.authorId !== userId && (kind === "like" || kind === "repost")) {
      notification = await tx.notification.create({
        data: {
          recipientId: reel.authorId,
          actorId: userId,
          reelId,
          type: kind === "like" ? NotificationType.REEL_LIKE : NotificationType.REEL_REPOST,
        },
        include: notificationInclude,
      });
    }

    const [fresh, liked, bookmarked, reposted] = await Promise.all([
      tx.reel.findUniqueOrThrow({
        where: { id: reelId },
        select: { likeCount: true, commentCount: true, repostCount: true, shareCount: true, viewCount: true },
      }),
      tx.reelLike.findUnique({ where: { userId_reelId: { userId, reelId } }, select: { userId: true } }),
      tx.reelBookmark.findUnique({ where: { userId_reelId: { userId, reelId } }, select: { userId: true } }),
      tx.reelRepost.findUnique({ where: { userId_reelId: { userId, reelId } }, select: { userId: true } }),
    ]);
    return {
      response: makeInteractionResponse(fresh, {
        liked: Boolean(liked),
        bookmarked: Boolean(bookmarked),
        reposted: Boolean(reposted),
      }),
      notification,
    };
  });
  if (result.notification) {
    emitToUser(result.notification.recipientId, "notification:new", result.notification);
  }
  res.json(result.response);
};

router.post("/:id/like", authRequired, writeLimiter, asyncRoute(async (req, res) => {
  await setRelation(req, res, "like", true);
}));
router.delete("/:id/like", authRequired, writeLimiter, asyncRoute(async (req, res) => {
  await setRelation(req, res, "like", false);
}));
router.post("/:id/bookmark", authRequired, writeLimiter, asyncRoute(async (req, res) => {
  await setRelation(req, res, "bookmark", true);
}));
router.delete("/:id/bookmark", authRequired, writeLimiter, asyncRoute(async (req, res) => {
  await setRelation(req, res, "bookmark", false);
}));
router.post("/:id/repost", authRequired, writeLimiter, asyncRoute(async (req, res) => {
  await setRelation(req, res, "repost", true);
}));
router.delete("/:id/repost", authRequired, writeLimiter, asyncRoute(async (req, res) => {
  await setRelation(req, res, "repost", false);
}));

router.post("/:id/share", authRequired, writeLimiter, asyncRoute(async (req, res) => {
  const reelId = reelIdFrom(req.params.id);
  const counts = await prisma.$transaction(async (tx) => {
    const reel = await tx.reel.findFirst({
      where: { id: reelId, status: ReelStatus.READY, deletedAt: null },
      select: { id: true },
    });
    if (!reel) throw new HttpError(404, "Reel not found");
    return tx.reel.update({
      where: { id: reelId },
      data: { shareCount: { increment: 1 } },
      select: { likeCount: true, commentCount: true, repostCount: true, shareCount: true, viewCount: true },
    });
  });
  res.json({ counts });
}));

router.post("/:id/view", authOptional, viewLimiter, asyncRoute(async (req, res) => {
  const reelId = reelIdFrom(req.params.id);
  const { watchedMs } = z.object({ watchedMs: z.number().int().min(0).max(60_000) }).parse(req.body);
  const reel = await ensureVisibleReel(reelId);
  if (watchedMs < 3000 || reel.authorId === req.userId) {
    res.json({ counted: false });
    return;
  }

  const now = new Date();
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const created = await prisma.$transaction(async (tx) => {
    const inserted = await tx.reelView.createMany({
      data: { reelId, viewerKey: encodeViewerKey(req), day },
      skipDuplicates: true,
    });
    if (inserted.count) {
      await tx.reel.update({ where: { id: reelId }, data: { viewCount: { increment: 1 } } });
    }
    return inserted.count === 1;
  });
  res.json({ counted: created });
}));

router.patch("/:id", authRequired, writeLimiter, asyncRoute(async (req, res) => {
  const reelId = reelIdFrom(req.params.id);
  const { caption } = captionSchema.parse(req.body);
  const result = await prisma.reel.updateMany({
    where: { id: reelId, authorId: viewerIdFrom(req), deletedAt: null },
    data: { caption },
  });
  if (!result.count) throw new HttpError(404, "Reel not found");
  const updated = await prisma.reel.findUniqueOrThrow({
    where: { id: reelId },
    include: relationInclude(req.userId ?? null),
  });
  res.json(await reelResponse(updated, await isFollowing(req.userId ?? null, updated.authorId)));
}));

router.delete("/:id", authRequired, writeLimiter, asyncRoute(async (req, res) => {
  const reelId = reelIdFrom(req.params.id);
  const userId = viewerIdFrom(req);
  const result = await prisma.reel.updateMany({
    where: { id: reelId, authorId: userId, deletedAt: null },
    data: { deletedAt: new Date(), status: ReelStatus.REMOVED },
  });
  if (!result.count) throw new HttpError(404, "Reel not found");
  await prisma.reelReport.updateMany({
    where: { reelId, status: ReelReportStatus.PENDING },
    data: { status: ReelReportStatus.ACTIONED },
  });
  res.status(204).end();
}));

router.get("/:id/comments", authOptional, asyncRoute(async (req, res) => {
  const reelId = reelIdFrom(req.params.id);
  await ensureVisibleReel(reelId);
  const { cursor: rawCursor, limit } = paginationSchema.parse(req.query);
  const cursor = parseCursor(rawCursor, profileCursorSchema);
  const comments = await prisma.reelComment.findMany({
    where: {
      reelId,
      replyToId: null,
      deletedAt: null,
      ...(cursor ? {
        OR: [
          { createdAt: { lt: new Date(cursor.createdAt) } },
          { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
        ],
      } : {}),
    },
    include: {
      author: { select: profileUserSelect },
      replies: {
        where: { deletedAt: null },
        include: { author: { select: profileUserSelect } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const hasMore = comments.length > limit;
  const page = comments.slice(0, limit);
  const last = page.at(-1);
  res.json({
    items: page,
    nextCursor: hasMore && last
      ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
      : null,
  });
}));

router.post("/:id/comments", authRequired, writeLimiter, asyncRoute(async (req, res) => {
  const reelId = reelIdFrom(req.params.id);
  const userId = viewerIdFrom(req);
  const input = commentSchema.parse(req.body);
  const result = await prisma.$transaction(async (tx) => {
    const reel = await tx.reel.findFirst({
      where: { id: reelId, status: ReelStatus.READY, deletedAt: null },
      select: { id: true, authorId: true },
    });
    if (!reel) throw new HttpError(404, "Reel not found");

    if (input.replyToId) {
      const parent = await tx.reelComment.findFirst({
        where: { id: input.replyToId, reelId, replyToId: null, deletedAt: null },
        select: { id: true },
      });
      if (!parent) throw new HttpError(404, "Reply target not found");
    }
    const comment = await tx.reelComment.create({
      data: {
        reelId,
        authorId: userId,
        body: input.body,
        replyToId: input.replyToId,
      },
      include: { author: { select: profileUserSelect } },
    });
    await tx.reel.update({ where: { id: reelId }, data: { commentCount: { increment: 1 } } });
    const notification = reel.authorId !== userId
      ? await tx.notification.create({
          data: {
            recipientId: reel.authorId,
            actorId: userId,
            reelId,
            type: NotificationType.REEL_COMMENT,
          },
          include: notificationInclude,
        })
      : null;
    return { comment, notification };
  });
  if (result.notification) emitToUser(result.notification.recipientId, "notification:new", result.notification);
  res.status(201).json(result.comment);
}));

router.delete("/:id/comments/:commentId", authRequired, writeLimiter, asyncRoute(async (req, res) => {
  const reelId = reelIdFrom(req.params.id);
  const commentId = z.string().cuid().parse(req.params.commentId);
  const userId = viewerIdFrom(req);
  await prisma.$transaction(async (tx) => {
    const [comment, reel] = await Promise.all([
      tx.reelComment.findFirst({ where: { id: commentId, reelId, deletedAt: null } }),
      tx.reel.findUnique({ where: { id: reelId }, select: { authorId: true } }),
    ]);
    if (!comment) throw new HttpError(404, "Comment not found");
    if (comment.authorId !== userId && reel?.authorId !== userId) {
      throw new HttpError(403, "You cannot delete this comment");
    }
    const deletedAt = new Date();
    const deleted = await tx.reelComment.updateMany({
      where: {
        reelId,
        deletedAt: null,
        OR: [{ id: commentId }, { replyToId: commentId }],
      },
      data: { deletedAt },
    });
    await tx.reel.update({
      where: { id: reelId },
      data: { commentCount: { decrement: deleted.count } },
    });
  });
  res.status(204).end();
}));

router.post("/:id/report", authRequired, writeLimiter, asyncRoute(async (req, res) => {
  const reelId = reelIdFrom(req.params.id);
  const userId = viewerIdFrom(req);
  const input = reportSchema.parse(req.body);
  const result = await prisma.$transaction(async (tx) => {
    const reel = await tx.reel.findFirst({
      where: { id: reelId, status: ReelStatus.READY, deletedAt: null },
      select: { id: true },
    });
    if (!reel) throw new HttpError(404, "Reel not found");
    await tx.reelReport.create({
      data: {
        reelId,
        reporterId: userId,
        reason: input.reason,
        details: input.details,
      },
    });
    const pendingCount = await tx.reelReport.count({
      where: { reelId, status: ReelReportStatus.PENDING },
    });
    if (pendingCount >= config.REEL_REPORT_AUTO_HIDE_COUNT) {
      await tx.reel.update({
        where: { id: reelId },
        data: { status: ReelStatus.REMOVED, deletedAt: new Date() },
      });
    }
    return { hidden: pendingCount >= config.REEL_REPORT_AUTO_HIDE_COUNT };
  });
  res.status(201).json(result);
}));

router.get("/:id/reports", authRequired, asyncRoute(async (req, res) => {
  const reelId = reelIdFrom(req.params.id);
  const reel = await prisma.reel.findFirst({
    where: { id: reelId, authorId: viewerIdFrom(req) },
    select: { id: true },
  });
  if (!reel) throw new HttpError(404, "Reel not found");
  const reports = await prisma.reelReport.findMany({
    where: { reelId },
    select: { id: true, reason: true, details: true, status: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  res.json({ items: reports });
}));

router.patch("/:id/reports/:reportId", authRequired, writeLimiter, asyncRoute(async (req, res) => {
  const reelId = reelIdFrom(req.params.id);
  const reportId = z.string().cuid().parse(req.params.reportId);
  const { status } = reportStatusSchema.parse(req.body);
  const ownerId = viewerIdFrom(req);
  const result = await prisma.reelReport.updateMany({
    where: { id: reportId, reelId, reel: { authorId: ownerId } },
    data: { status },
  });
  if (!result.count) throw new HttpError(404, "Report not found");
  res.json({ updated: true, status });
}));

profileRouter.get("/:handle/reels", authOptional, asyncRoute(async (req, res) => {
  const handle = z.string().min(1).max(30).parse(req.params.handle);
  const user = await prisma.user.findUnique({
    where: { handle },
    select: { id: true },
  });
  if (!user) throw new HttpError(404, "User not found");
  const { cursor: rawCursor, limit } = paginationSchema.parse(req.query);
  const cursor = parseCursor(rawCursor, profileCursorSchema);
  const viewerId = req.userId ?? null;
  const reels = await prisma.reel.findMany({
    where: {
      authorId: user.id,
      status: ReelStatus.READY,
      deletedAt: null,
      publishedAt: { not: null },
      ...(cursor ? {
        OR: [
          { publishedAt: { lt: new Date(cursor.createdAt) } },
          { publishedAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
        ],
      } : {}),
    },
    include: relationInclude(viewerId),
    orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const hasMore = reels.length > limit;
  const page = reels.slice(0, limit);
  const followedAuthors = await followingAuthors(viewerId, page.map((reel) => reel.authorId));
  const items = await Promise.all(page.map((reel) =>
    reelResponse(reel, followedAuthors.has(reel.authorId))));
  const last = page.at(-1);
  res.json({
    items,
    nextCursor: hasMore && last
      ? encodeCursor({ createdAt: last.publishedAt?.toISOString() ?? last.createdAt.toISOString(), id: last.id })
      : null,
  });
}));

export { profileRouter as reelProfileRouter, router as reelsRouter };
