import "dotenv/config";
import { z } from "zod";

const optionalEnvString = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().min(1).optional(),
);

const configSchema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32),
  POST_VIEW_HMAC_SECRET: z.string().min(32),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CLIENT_ORIGIN: z.string().url()
    .transform((value) => new URL(value).origin)
    .default("http://localhost:5173"),
  REEL_STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  REEL_STORAGE_DIR: z.string().min(1).default("./private-reels"),
  REEL_S3_BUCKET: optionalEnvString,
  REEL_S3_ENDPOINT: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().url().optional(),
  ),
  REEL_S3_REGION: z.string().min(1).default(process.env.AWS_REGION || "us-east-1"),
  REEL_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(100 * 1024 * 1024).default(100 * 1024 * 1024),
  FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
  FFPROBE_PATH: z.string().min(1).default("ffprobe"),
  REEL_KEEP_ORIGINAL: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  REEL_REPORT_AUTO_HIDE_COUNT: z.coerce.number().int().positive().default(5),
}).superRefine((value, context) => {
  if (value.REEL_STORAGE_DRIVER === "s3" && !value.REEL_S3_BUCKET) {
    context.addIssue({
      code: "custom",
      path: ["REEL_S3_BUCKET"],
      message: "REEL_S3_BUCKET is required when REEL_STORAGE_DRIVER=s3",
    });
  }
});

export const config = configSchema.parse({
  ...process.env,
  REEL_S3_ENDPOINT: process.env.REEL_S3_ENDPOINT || process.env.AWS_ENDPOINT_URL_S3,
});

export const clientOrigins = [
  config.CLIENT_ORIGIN,
  "https://relay-4vm.pages.dev",
  "http://localhost:4173",
  "http://localhost:5173",
];
