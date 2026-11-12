import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import multer from "multer";
import type { RequestHandler } from "express";
import { HttpError } from "./http";
import { createSignedMediaUrl } from "./media-url";
import { prisma } from "./db";

export const uploadDirectory = path.resolve(process.cwd(), "uploads");
export const objectStorageBucket = process.env.NEON_OBJECT_STORAGE_BUCKET || "assets";
const objectStorageEndpoint = process.env.AWS_ENDPOINT_URL_S3;
const objectStorageEnabled = Boolean(
  objectStorageEndpoint && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY,
);
const objectStorage = objectStorageEnabled
  ? new S3Client({
      endpoint: objectStorageEndpoint,
      region: process.env.AWS_REGION || "us-east-1",
      forcePathStyle: true,
    })
  : null;

const storage = multer.memoryStorage();

const localMediaLifetimeMs = 48 * 60 * 60 * 1000;

const signLocalMedia = (payload: string): string =>
  createHmac("sha256", config.POST_VIEW_HMAC_SECRET).update(payload).digest("base64url");

const createLocalUploadToken = (filename: string, viewerId: string): string => {
  const expiresAt = Math.floor((Date.now() + localMediaLifetimeMs) / 1000);
  const payload = `${filename}.${viewerId}.${expiresAt}`;
  return `${Buffer.from(payload).toString("base64url")}.${signLocalMedia(payload)}`;
};

const verifyLocalUploadToken = (filename: string, token: string): boolean => {
  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator === token.length - 1) return false;
  const encodedPayload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  let payload: string;
  try {
    payload = Buffer.from(encodedPayload, "base64url").toString("utf8");
  } catch {
    return false;
  }
  const expectedSignature = signLocalMedia(payload);
  const expectedBuffer = Buffer.from(expectedSignature);
  const signatureBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== signatureBuffer.length
    || !timingSafeEqual(expectedBuffer, signatureBuffer)) return false;
  const parts = payload.split(".");
  if (parts.length !== 3) return false;
  const [tokenFilename, , expiresAtText] = parts;
  const expiresAt = Number(expiresAtText);
  return tokenFilename === filename && Number.isSafeInteger(expiresAt) && expiresAt * 1000 > Date.now();
};
const acceptedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!acceptedMimeTypes.has(file.mimetype)) {
      callback(new HttpError(400, "Upload a JPEG, PNG, WebP, or GIF image"));
      return;
    }
    callback(null, true);
  },
});

export const imageUpload: RequestHandler = (req, res, next) => {
  upload.single("file")(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError) {
      next(new HttpError(error.code === "LIMIT_FILE_SIZE" ? 413 : 400, "Image upload is invalid or too large"));
      return;
    }
    next(error);
  });
};

const extensionFor = (file: Express.Multer.File): string | null => {
  const { buffer } = file;
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return ".jpg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (buffer.toString("ascii", 0, 4) === "GIF8") return ".gif";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return ".webp";
  return null;
};

const audioUploadHandler = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!file.mimetype.startsWith("audio/") && file.mimetype !== "video/webm") callback(new HttpError(400, "Upload an audio recording"));
    else callback(null, true);
  },
});

export const audioUpload: RequestHandler = (req, res, next) => {
  audioUploadHandler.single("file")(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError) next(new HttpError(error.code === "LIMIT_FILE_SIZE" ? 413 : 400, "Audio upload is invalid or too large"));
    else next(error);
  });
};

export const saveUpload = async (file: Express.Multer.File, extension: string): Promise<string> => {
  const filename = `${randomUUID()}${extension}`;
  if (objectStorage) {
    await objectStorage.send(new PutObjectCommand({
      Bucket: objectStorageBucket,
      Key: filename,
      Body: file.buffer,
      ContentType: file.mimetype,
      CacheControl: "public, max-age=31536000, immutable",
    }));
  } else {
    if (process.env.NODE_ENV === "production") {
      throw new HttpError(
        503,
        "Persistent image storage is not configured. Configure Neon Object Storage before accepting uploads.",
      );
    }
    await mkdir(uploadDirectory, { recursive: true });
    await writeFile(path.join(uploadDirectory, filename), file.buffer, { flag: "wx" });
  }
  return `/uploads/${filename}`;
};

export const createUploadReadUrl = async (
  storedPath: string,
  viewerId?: string,
  suppliedToken?: unknown,
): Promise<string> => {
  const filename = /^\/uploads\/([0-9a-f-]+\.(?:jpg|jpeg|png|webp|gif|webm|ogg|m4a|mp3|wav|aac|flac|opus))$/i.exec(storedPath)?.[1];
  if (!filename) throw new Error("Invalid generated upload storage path");
  const privateMessage = await prisma.message.findFirst({
    where: {
      OR: [
        { mediaUrl: storedPath },
        { audioUrl: storedPath },
        { attachments: { array_contains: [storedPath] } },
      ],
    },
    select: { conversationId: true },
  });
  if (privateMessage) {
    if (!viewerId) return "/uploads/unauthorized";
    const membership = await prisma.conversationMember.findUnique({
      where: {
        conversationId_userId: {
          conversationId: privateMessage.conversationId,
          userId: viewerId,
        },
      },
      select: { userId: true },
    });
    if (!membership) return "/uploads/unauthorized";
  }
  if (!objectStorage) {
    if (typeof suppliedToken === "string") {
      const verified = verifyLocalUploadToken(filename, suppliedToken);
      if (!verified) throw new HttpError(403, "Invalid or expired media URL");
      return storedPath;
    }
    return `${storedPath}?token=${encodeURIComponent(createLocalUploadToken(filename, viewerId || "anonymous"))}`;
  }
  return createSignedMediaUrl(objectStorage, objectStorageBucket, filename);
};

export const getUploadStorageOrigins = (): string[] => {
  if (!objectStorage || !objectStorageEndpoint) return [];
  return [new URL(objectStorageEndpoint).origin];
};

export const saveAudio = async (file: Express.Multer.File): Promise<string> => {
  const mime = file.mimetype.split(";")[0].toLowerCase();
  const extensions: Record<string, string> = {
    "audio/webm": ".webm",
    "video/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/mp4": ".m4a",
    "video/mp4": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/aac": ".aac",
    "audio/flac": ".flac",
    "audio/x-flac": ".flac",
    "audio/opus": ".opus",
  };
  const extension = extensions[mime] || (file.originalname.match(/\.(webm|ogg|m4a|mp3|wav|aac|flac|opus)$/i)?.[0].toLowerCase()) || null;
  if (!extension) throw new HttpError(400, `Unsupported audio format: ${file.mimetype || "unknown"}`);
  return saveUpload(file, extension.startsWith(".") ? extension : `.${extension}`);
};

export const saveImage = async (file: Express.Multer.File): Promise<string> => {
  const extension = extensionFor(file);
  if (!extension) throw new HttpError(400, "The uploaded file is not a supported image");
  return saveUpload(file, extension);
};
