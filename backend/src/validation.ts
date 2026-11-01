import { z } from "zod";

const mediaUrlSchema = z.string().max(2048).refine(
  (value) => value.startsWith("/uploads/") && !value.includes("..")
    ? true
    : z.string().url().safeParse(value).success && ["http:", "https:"].includes(new URL(value).protocol),
  { message: "Media must be an http(s) URL or a Relay upload path" },
);

const passwordSchema = z
  .string()
  .min(12)
  .max(128)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 72, {
    message: "Password must not exceed 72 UTF-8 bytes",
  });

export const registerSchema = z.object({
  handle: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,30}$/),
  email: z.string().trim().toLowerCase().email().max(254),
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(60),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128).refine((value) => Buffer.byteLength(value, "utf8") <= 72, {
    message: "Password must not exceed 72 UTF-8 bytes",
  }),
});

export const postSchema = z.object({
  body: z.string().trim().min(1).max(280),
  mediaUrl: mediaUrlSchema.optional(),
  location: z.string().trim().min(1).max(80).optional(),
  replyToId: z.string().cuid().optional(),
});

export const updatePostSchema = z.object({
  body: z.string().trim().min(1).max(280),
  mediaUrl: mediaUrlSchema.nullable().optional(),
  location: z.string().trim().min(1).max(80).nullable().optional(),
});

export const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  bio: z.string().trim().max(280).optional(),
  avatarUrl: mediaUrlSchema.nullable().optional(),
  bannerUrl: mediaUrlSchema.nullable().optional(),
});

export const updateEmailSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  currentPassword: z.string().min(1).max(128).refine((value) => Buffer.byteLength(value, "utf8") <= 72, {
    message: "Password must not exceed 72 UTF-8 bytes",
  }),
});

export const updatePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128).refine((value) => Buffer.byteLength(value, "utf8") <= 72, {
    message: "Password must not exceed 72 UTF-8 bytes",
  }),
  password: passwordSchema,
  confirmPassword: z.string().min(1).max(128),
}).refine((value) => value.password === value.confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
});

export const pageSchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const messageSchema = z.object({
  body: z.string().trim().max(2000).optional().default(""),
  mediaUrl: mediaUrlSchema.nullable().optional(),
  audioUrl: z.string().startsWith("/uploads/").max(2048).nullable().optional(),
  waveform: z.array(z.number().int().min(0).max(100)).min(40).max(64).optional(),
  stickerId: z.string().trim().regex(/^[a-z0-9_-]{1,64}$/).nullable().optional(),
}).refine((value) => !value.waveform || Boolean(value.audioUrl), {
  message: "A waveform requires an audio message",
}).refine((value) => value.body || value.mediaUrl || value.audioUrl || value.stickerId, {
  message: "A message must contain text, an image, audio, or a sticker",
});
