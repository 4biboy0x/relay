import { execFile as execFileCallback } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { NotificationType, ProcessingJobStatus, ReelStatus } from "@prisma/client";
import { z } from "zod";
import { config } from "./config";
import { prisma } from "./db";
import { emitToUser } from "./realtime";
import {
  createReelStorageKey,
  deleteReelObject,
  getReelObjectHead,
  getReelObjectStream,
  putReelFile,
  readReelObjectPrefix,
} from "./reel-storage";

const execFile = promisify(execFileCallback);
const MAX_DURATION_MS = 60_000;
const MAX_DIMENSION = 4096;
const probeSchema = z.object({
  streams: z.array(z.object({
    codec_type: z.string().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    duration: z.string().optional(),
    tags: z.record(z.string(), z.unknown()).optional(),
  })).default([]),
  format: z.object({
    duration: z.string().optional(),
    tags: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
});

type VideoProbe = {
  durationMs: number;
  width: number;
  height: number;
};

const unsafeMetadataKey = /gps|latitude|longitude|location|coordinates?/i;

export const detectReelContainer = (prefix: Buffer): "video/mp4" | "video/webm" | null => {
  if (prefix.length >= 12 && prefix.toString("ascii", 4, 8) === "ftyp") return "video/mp4";
  if (prefix.length >= 4 && prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return "video/webm";
  }
  return null;
};

const probeVideo = async (filePath: string): Promise<VideoProbe> => {
  const { stdout } = await execFile(config.FFPROBE_PATH, [
    "-v", "error",
    "-show_format",
    "-show_streams",
    "-of", "json",
    filePath,
  ], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  const probe = probeSchema.parse(JSON.parse(stdout));
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  if (!video?.width || !video.height) throw new Error("The selected file has no video stream");

  const metadataTags = [
    ...(probe.format?.tags ? Object.keys(probe.format.tags) : []),
    ...probe.streams.flatMap((stream) => stream.tags ? Object.keys(stream.tags) : []),
  ];
  if (metadataTags.some((tag) => unsafeMetadataKey.test(tag))) {
    throw new Error("The video contains location metadata and cannot be processed");
  }

  const durationSeconds = Number(probe.format?.duration ?? video.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("The video duration could not be determined");
  }
  const durationMs = Math.round(durationSeconds * 1000);
  if (durationMs > MAX_DURATION_MS) throw new Error("Videos must be 60 seconds or shorter");
  if (Math.max(video.width, video.height) > MAX_DIMENSION) {
    throw new Error("Video resolution exceeds the supported 4K limit");
  }

  return { durationMs, width: video.width, height: video.height };
};

const encodeVideo = async (inputPath: string, videoPath: string, posterPath: string): Promise<VideoProbe> => {
  await execFile(config.FFMPEG_PATH, [
    "-y",
    "-i", inputPath,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-map_metadata", "-1",
    "-map_chapters", "-1",
    "-sn",
    "-dn",
    "-vf", "scale=w='min(iw,720)':h='min(ih,1280)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-af", "loudnorm=I=-16:LRA=11:TP=-1.5",
    "-movflags", "+faststart",
    "-f", "mp4",
    videoPath,
  ], { timeout: 5 * 60_000, maxBuffer: 2 * 1024 * 1024 });

  await execFile(config.FFMPEG_PATH, [
    "-y",
    "-ss", "0.5",
    "-i", videoPath,
    "-frames:v", "1",
    "-vf", "scale=w='min(iw,720)':h=-2",
    "-map_metadata", "-1",
    "-q:v", "3",
    "-update", "1",
    posterPath,
  ], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });

  return probeVideo(videoPath);
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "The video could not be processed";

export const processReelJob = async (jobId: string, reelId: string): Promise<void> => {
  const reel = await prisma.reel.findUnique({
    where: { id: reelId },
    select: { id: true, authorId: true, originalKey: true, deletedAt: true },
  });
  if (!reel || reel.deletedAt) {
    await prisma.processingJob.update({
      where: { id: jobId },
      data: { status: ProcessingJobStatus.COMPLETED, lockedAt: null },
    });
    return;
  }

  const sourceHead = await getReelObjectHead(reel.originalKey);
  if (!sourceHead) throw new Error("Uploaded video was not found in private storage");
  if (sourceHead.contentLength <= 0 || sourceHead.contentLength > config.REEL_MAX_UPLOAD_BYTES) {
    throw new Error("Video upload is empty or exceeds the 100 MB limit");
  }

  if (!detectReelContainer(await readReelObjectPrefix(reel.originalKey))) {
    throw new Error("Upload must be an MP4, MOV, or WebM video");
  }

  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "relay-reel-"));
  const inputPath = path.join(tempDirectory, "original");
  const outputPath = path.join(tempDirectory, "processed.mp4");
  const posterPath = path.join(tempDirectory, "poster.jpg");
  const videoKey = createReelStorageKey(reel.id, "video.mp4");
  const posterKey = createReelStorageKey(reel.id, "poster.jpg");
  let outputStored = false;

  try {
    const source = await getReelObjectStream(reel.originalKey);
    await pipeline(source.body, createWriteStream(inputPath, { flags: "wx" }));

    await probeVideo(inputPath);
    const outputProbe = await encodeVideo(inputPath, outputPath, posterPath);
    const outputStats = await stat(outputPath);

    await putReelFile(videoKey, outputPath, "video/mp4");
    await putReelFile(posterKey, posterPath, "image/jpeg");
    outputStored = true;

    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.reel.findFirst({
        where: { id: reel.id, deletedAt: null, status: ReelStatus.PROCESSING },
        select: { id: true },
      });
      if (!current) {
        await tx.processingJob.update({
          where: { id: jobId },
          data: { status: ProcessingJobStatus.COMPLETED, lockedAt: null },
        });
        return null;
      }

      const saved = await tx.reel.update({
        where: { id: reel.id },
        data: {
          status: ReelStatus.READY,
          videoKey,
          posterKey,
          durationMs: outputProbe.durationMs,
          width: outputProbe.width,
          height: outputProbe.height,
          sizeBytes: BigInt(outputStats.size),
          mime: "video/mp4",
          publishedAt: new Date(),
          processingError: null,
        },
        select: { authorId: true, id: true },
      });
      await tx.processingJob.update({
        where: { id: jobId },
        data: { status: ProcessingJobStatus.COMPLETED, lockedAt: null, lastError: null },
      });
      const notification = await tx.notification.create({
        data: {
          recipientId: saved.authorId,
          actorId: saved.authorId,
          reelId: saved.id,
          type: NotificationType.REEL_READY,
        },
        include: { actor: { select: { id: true, handle: true, displayName: true, avatarUrl: true } } },
      });
      return { notification, authorId: saved.authorId };
    });

    if (updated) emitToUser(updated.authorId, "notification:new", updated.notification);
    if (!config.REEL_KEEP_ORIGINAL) {
      try {
        await deleteReelObject(reel.originalKey);
      } catch (error) {
        console.error(`Processed Reel ${reel.id}, but failed to remove its original upload:`, error);
      }
    }

    if (!updated) {
      await deleteReelObject(videoKey);
      await deleteReelObject(posterKey);
    }
  } catch (error) {
    if (outputStored) {
      const cleanupResults = await Promise.allSettled([
        deleteReelObject(videoKey),
        deleteReelObject(posterKey),
      ]);
      for (const result of cleanupResults) {
        if (result.status === "rejected") {
          console.error(`Could not clean generated media for Reel ${reel.id}:`, result.reason);
        }
      }
    }
    throw error;
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
};

export const processingErrorText = errorMessage;
