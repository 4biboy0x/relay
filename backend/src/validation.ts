import { z } from "zod";

const mediaUrlSchema = z.string().max(2048).refine(
  (value) => value.startsWith("/uploads/") && !value.includes("..")
    ? true
    : z.string().url().safeParse(value).success && ["http:", "https:"].includes(new URL(value).protocol),
  { message: "Media must be an http(s) URL or a Relay upload path" },
);

const messageAttachmentUrlSchema = mediaUrlSchema.refine((value) => {
  const url = new URL(value, "https://relay.invalid");
  return /\.(?:jpe?g|png|webp|gif)$/i.test(url.pathname);
}, { message: "Message attachments must be images or GIFs" });

const strippedControlCharacters = (value: string): string =>
  value.replace(/[\u0000-\u001f\u007f]/g, "");

const mediaCropSchema = z.object({
  ratio: z.enum(["original", "16:9", "1:1", "4:5"]),
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
  zoom: z.number().finite().min(1).max(3),
}).strict();

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

export const otpRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  purpose: z.enum(["signup", "reset"]).default("signup"),
});

export const forgotPasswordSchema = z.object({
  identifier: z.string().trim().min(1).max(254).optional(),
  email: z.string().trim().max(254).optional(),
  purpose: z.enum(["reset"]).default("reset"),
}).refine((data) => Boolean(data.identifier || data.email), {
  message: "Identifier or email is required",
});

export const otpVerifySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  code: z.string().trim().regex(/^\d{6}$/),
  purpose: z.enum(["signup", "reset"]).default("signup"),
});

export const changeVerificationEmailSchema = z.object({
  currentEmail: z.string().trim().toLowerCase().email().max(254),
  newEmail: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128).refine((value) => Buffer.byteLength(value, "utf8") <= 72, {
    message: "Password must not exceed 72 UTF-8 bytes",
  }),
});

export const resetPasswordSchema = z.object({
  resetToken: z.string().min(1),
  password: passwordSchema,
  confirmPassword: z.string().min(1).max(128),
}).refine((value) => value.password === value.confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
});

export const postSchema = z.object({
  body: z.string().trim().min(1).max(280),
  mediaUrl: mediaUrlSchema.optional(),
  mediaCrop: mediaCropSchema.nullable().optional(),
  mediaAlt: z.string().transform(strippedControlCharacters).transform((value) => value.slice(0, 1000)).optional(),
  location: z.string().trim().min(1).max(80).optional(),
  replyToId: z.string().cuid().optional(),
});

export const updatePostSchema = z.object({
  body: z.string().trim().min(1).max(280),
  mediaUrl: mediaUrlSchema.nullable().optional(),
  mediaCrop: mediaCropSchema.nullable().optional(),
  mediaAlt: z.string().transform(strippedControlCharacters).transform((value) => value.slice(0, 1000)).nullable().optional(),
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
  attachments: z.array(messageAttachmentUrlSchema).min(1).max(4).optional(),
  mediaDimensions: z.array(z.object({
    width: z.number().int().min(1).max(10000),
    height: z.number().int().min(1).max(10000),
  })).max(4).optional(),
  audioUrl: z.string().startsWith("/uploads/").max(2048).nullable().optional(),
  waveform: z.array(z.number().int().min(0).max(100)).min(40).max(64).optional(),
  stickerId: z.string().trim().regex(/^[a-z0-9_-]{1,64}$/).nullable().optional(),
  replyToId: z.string().cuid().nullable().optional(),
}).refine((value) => !value.waveform || Boolean(value.audioUrl), {
  message: "A waveform requires an audio message",
}).refine((value) => !value.mediaDimensions
  || value.mediaDimensions.length === (value.attachments?.length || (value.mediaUrl ? 1 : 0)), {
  message: "Media dimensions must match the message attachments",
}).refine((value) => value.body || value.mediaUrl || value.attachments?.length || value.audioUrl || value.stickerId, {
  message: "A message must contain text, an image, audio, or a sticker",
});
