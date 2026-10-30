import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import type { RequestHandler } from "express";
import { HttpError } from "./http";

export const uploadDirectory = path.resolve(process.cwd(), "uploads");

const storage = multer.memoryStorage();
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
  await mkdir(uploadDirectory, { recursive: true });
  const filename = `${randomUUID()}${extension}`;
  await writeFile(path.join(uploadDirectory, filename), file.buffer, { flag: "wx" });
  return `/uploads/${filename}`;
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
  await mkdir(uploadDirectory, { recursive: true });
  const filename = `${randomUUID()}${extension}`;
  await writeFile(path.join(uploadDirectory, filename), file.buffer, { flag: "wx" });
  return `/uploads/${filename}`;
};
