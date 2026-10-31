import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "./config";

const publicUploadDirectory = path.resolve(process.cwd(), "uploads");
export const reelStorageDirectory = path.resolve(process.cwd(), config.REEL_STORAGE_DIR);
const s3Endpoint = config.REEL_S3_ENDPOINT;

if (reelStorageDirectory === publicUploadDirectory
  || reelStorageDirectory.startsWith(`${publicUploadDirectory}${path.sep}`)) {
  throw new Error("REEL_STORAGE_DIR must be outside the public uploads directory");
}

const bucket = config.REEL_S3_BUCKET;
const s3 = config.REEL_STORAGE_DRIVER === "s3"
  ? new S3Client({
      region: config.REEL_S3_REGION,
      endpoint: s3Endpoint,
      forcePathStyle: Boolean(s3Endpoint),
    })
  : null;

export type ReelObjectHead = {
  contentLength: number;
  contentType?: string;
};

const safeStoragePath = (key: string): string => {
  if (!key || key.includes("\\") || key.startsWith("/") || key.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid generated media storage key");
  }

  const resolved = path.resolve(reelStorageDirectory, key);
  if (!resolved.startsWith(`${reelStorageDirectory}${path.sep}`)) {
    throw new Error("Media storage key escaped the private storage directory");
  }
  return resolved;
};

const requireBucket = (): string => {
  if (!bucket) throw new Error("REEL_S3_BUCKET is required for S3 storage");
  return bucket;
};

export const createReelStorageKey = (reelId: string, suffix: "original" | "video.mp4" | "poster.jpg"): string => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reelId)) {
    throw new Error("Invalid Reel id for a generated storage key");
  }
  return `reels/${reelId}/${suffix}`;
};

export const createReelUploadUrl = async (
  key: string,
  contentType: string,
  contentLength: number,
): Promise<string> => {
  if (s3) {
    return getSignedUrl(s3, new PutObjectCommand({
      Bucket: requireBucket(),
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
    }), { expiresIn: 10 * 60 });
  }
  return "/api/reels/local-upload";
};

export const createReelReadUrl = async (key: string): Promise<string> => {
  if (!s3) return "";
  return getSignedUrl(s3, new GetObjectCommand({
    Bucket: requireBucket(),
    Key: key,
    ResponseContentDisposition: "inline",
  }), { expiresIn: 60 * 60 });
};

export const createLocalReelReadUrl = (reelId: string, kind: "video" | "poster"): string => {
  const expires = Math.floor(Date.now() / 1000) + 60 * 60;
  const signature = createHmac("sha256", config.JWT_ACCESS_SECRET)
    .update(`${reelId}:${kind}:${expires}`)
    .digest("base64url");
  return `/api/reels/${reelId}/media/${kind}?expires=${expires}&signature=${signature}`;
};

export const verifyLocalReelReadUrl = (
  reelId: string,
  kind: "video" | "poster",
  expiresValue: string | undefined,
  signature: string | undefined,
): boolean => {
  if (!expiresValue || !signature || !/^\d{10}$/.test(expiresValue)) return false;
  const expires = Number(expiresValue);
  const now = Math.floor(Date.now() / 1000);
  if (expires < now || expires > now + 60 * 60 + 30) return false;

  const expected = createHmac("sha256", config.JWT_ACCESS_SECRET)
    .update(`${reelId}:${kind}:${expires}`)
    .digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export const getReelStorageOrigins = (): string[] => {
  if (!s3) return [];
  if (s3Endpoint) return [new URL(s3Endpoint).origin];
  return [`https://${requireBucket()}.s3.${config.REEL_S3_REGION}.amazonaws.com`];
};

export const putReelFile = async (key: string, filePath: string, contentType: string): Promise<void> => {
  const fileStats = await stat(filePath);
  if (s3) {
    await s3.send(new PutObjectCommand({
      Bucket: requireBucket(),
      Key: key,
      Body: createReadStream(filePath),
      ContentLength: fileStats.size,
      ContentType: contentType,
    }));
    return;
  }

  const destination = safeStoragePath(key);
  await mkdir(path.dirname(destination), { recursive: true });
  await pipeline(createReadStream(filePath), createWriteStream(destination, { flags: "w" }));
};

export const putReelBuffer = async (key: string, buffer: Buffer, contentType: string): Promise<void> => {
  if (s3) {
    await s3.send(new PutObjectCommand({
      Bucket: requireBucket(),
      Key: key,
      Body: buffer,
      ContentLength: buffer.byteLength,
      ContentType: contentType,
    }));
    return;
  }

  const destination = safeStoragePath(key);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, buffer, { flag: "w" });
};

export const getReelObjectStream = async (key: string, range?: string): Promise<{
  body: Readable;
  contentType?: string;
  contentLength?: number;
  contentRange?: string;
}> => {
  if (s3) {
    const result = await s3.send(new GetObjectCommand({
      Bucket: requireBucket(),
      Key: key,
      ...(range ? { Range: range } : {}),
    }));
    if (!(result.Body instanceof Readable)) throw new Error("Object storage returned no readable media body");
    return {
      body: result.Body,
      contentType: result.ContentType,
      contentLength: result.ContentLength,
      contentRange: result.ContentRange,
    };
  }

  const filePath = safeStoragePath(key);
  const fileStats = await stat(filePath);
  const parsedRange = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
  if (range && !parsedRange) throw new Error("Unsupported media byte range");
  const start = parsedRange ? Number(parsedRange[1]) : 0;
  const end = parsedRange?.[2] ? Math.min(Number(parsedRange[2]), fileStats.size - 1) : fileStats.size - 1;
  if (start >= fileStats.size || end < start) throw new RangeError("Media byte range is unsatisfiable");
  return {
    body: createReadStream(filePath, { start, end }),
    contentType: key.endsWith(".jpg") ? "image/jpeg"
      : key.endsWith(".svg") ? "image/svg+xml"
        : key.endsWith(".mp4") ? "video/mp4" : "application/octet-stream",
    contentLength: end - start + 1,
    contentRange: range ? `bytes ${start}-${end}/${fileStats.size}` : undefined,
  };
};

export const readReelObjectPrefix = async (key: string, byteCount = 4096): Promise<Buffer> => {
  let stream: Readable;
  if (s3) {
    const result = await s3.send(new GetObjectCommand({
        Bucket: requireBucket(),
        Key: key,
        Range: `bytes=0-${byteCount - 1}`,
      }));
    if (!(result.Body instanceof Readable)) throw new Error("Object storage returned no readable media body");
    stream = result.Body;
  } else {
    stream = createReadStream(safeStoragePath(key), { start: 0, end: byteCount - 1 });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).subarray(0, byteCount);
};

export const getReelObjectHead = async (key: string): Promise<ReelObjectHead | null> => {
  if (s3) {
    try {
      const result = await s3.send(new HeadObjectCommand({ Bucket: requireBucket(), Key: key }));
      if (result.ContentLength === undefined) throw new Error("Object storage did not report media size");
      return { contentLength: result.ContentLength, contentType: result.ContentType };
    } catch (error) {
      if (typeof error === "object" && error !== null && "name" in error
        && (error.name === "NotFound" || error.name === "NoSuchKey")) {
        return null;
      }
      throw error;
    }
  }

  try {
    const result = await stat(safeStoragePath(key));
    return { contentLength: result.size };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
};

export const deleteReelObject = async (key: string): Promise<void> => {
  if (s3) {
    await s3.send(new DeleteObjectCommand({ Bucket: requireBucket(), Key: key }));
    return;
  }
  await rm(safeStoragePath(key), { force: true });
};
