import { execFile as execFileCallback, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { ProcessingJobStatus, ReelStatus } from "@prisma/client";
import { z } from "zod";
import { config } from "./config";
import { prisma } from "./db";
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
  hasAudio: boolean;
};

export type ReelProcessingTimings = {
  probeMs: number;
  transcodeMs: number;
  posterMs: number;
};

export class ReelProcessingFailure extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly diagnostic?: string,
    readonly timings?: ReelProcessingTimings,
  ) {
    super(message);
    this.name = "ReelProcessingFailure";
  }
}

const unsafeMetadataKey = /gps|latitude|longitude|location|coordinates?/i;

const checkMediaTool = (name: "ffmpeg" | "ffprobe", executable: string, envName: string): Promise<boolean> =>
  new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (available: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(available);
    };
    const child = spawn(executable, ["-version"], { windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      console.error(`${name} not found in PATH. Set ${envName} to the executable path (version check timed out).`);
      finish(false);
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (output.length < 4096) output += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      console.error(`${name} not found in PATH. Set ${envName} to the executable path.`, error.message);
      finish(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        console.info(output.trim().split(/\r?\n/, 1)[0] || `${name} version check passed`);
        finish(true);
        return;
      }
      console.error(`${name} not found in PATH. Set ${envName} to the executable path (exit code ${code}).`);
      finish(false);
    });
  });

export const checkReelMediaTools = async (): Promise<boolean> => {
  const [ffmpegAvailable, ffprobeAvailable] = await Promise.all([
    checkMediaTool("ffmpeg", config.FFMPEG_PATH, "FFMPEG_PATH"),
    checkMediaTool("ffprobe", config.FFPROBE_PATH, "FFPROBE_PATH"),
  ]);
  return ffmpegAvailable && ffprobeAvailable;
};

const runMediaCommand = async (
  executable: string,
  args: string[],
  tool: "ffmpeg" | "ffprobe",
  timeout = tool === "ffprobe" ? 30_000 : 5 * 60_000,
): Promise<{ stdout: string }> => {
  try {
    return await execFile(executable, args, { timeout, maxBuffer: 2 * 1024 * 1024 });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    const diagnostic = (error instanceof Error ? error.message : `${tool} exited unsuccessfully`)
      .replace(/\s+/g, " ")
      .slice(0, 500);
    const message = code === "ENOENT"
      ? "Video processing is unavailable. Configure ffmpeg and ffprobe on the server."
      : tool === "ffprobe"
        ? "The uploaded video could not be read. Choose a valid MP4, MOV, or WebM video."
        : "The uploaded video could not be processed. Please try another video.";
    throw new ReelProcessingFailure(message, false, `${tool}: ${diagnostic}`);
  }
};

export const detectReelContainer = (prefix: Buffer): "video/mp4" | "video/webm" | null => {
  if (prefix.length >= 12 && prefix.toString("ascii", 4, 8) === "ftyp") return "video/mp4";
  if (prefix.length >= 4 && prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return "video/webm";
  }
  return null;
};

const probeVideo = async (filePath: string): Promise<VideoProbe> => {
  const { stdout } = await runMediaCommand(config.FFPROBE_PATH, [
    "-v", "error",
    "-show_format",
    "-show_streams",
    "-of", "json",
    filePath,
  ], "ffprobe");
  let probe: z.infer<typeof probeSchema>;
  try {
    probe = probeSchema.parse(JSON.parse(stdout));
  } catch (error) {
    throw new ReelProcessingFailure(
      "The uploaded video could not be read. Choose a valid MP4, MOV, or WebM video.",
      false,
      error instanceof Error ? `ffprobe returned invalid metadata: ${error.message}` : "ffprobe returned invalid metadata",
    );
  }
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  if (!video?.width || !video.height) {
    throw new ReelProcessingFailure("The selected file has no video stream.", false, "No video stream found");
  }

  const metadataTags = [
    ...(probe.format?.tags ? Object.keys(probe.format.tags) : []),
    ...probe.streams.flatMap((stream) => stream.tags ? Object.keys(stream.tags) : []),
  ];
  if (metadataTags.some((tag) => unsafeMetadataKey.test(tag))) {
    throw new ReelProcessingFailure("The video contains location metadata and cannot be processed.", false);
  }

  const durationSeconds = Number(probe.format?.duration ?? video.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new ReelProcessingFailure("The video duration could not be determined.", false);
  }
  const durationMs = Math.round(durationSeconds * 1000);
  if (durationMs > MAX_DURATION_MS) {
    throw new ReelProcessingFailure("Videos must be 60 seconds or shorter.", false);
  }
  if (Math.max(video.width, video.height) > MAX_DIMENSION) {
    throw new ReelProcessingFailure("Video resolution exceeds the supported 4K limit.", false);
  }

  return {
    durationMs,
    width: video.width,
    height: video.height,
    hasAudio: probe.streams.some((stream) => stream.codec_type === "audio"),
  };
};

const transcodeVideo = async (inputPath: string, videoPath: string, hasAudio: boolean): Promise<void> => {
  const args = [
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
  ];
  if (hasAudio) {
    args.push("-c:a", "aac", "-b:a", "128k", "-af", "loudnorm=I=-16:LRA=11:TP=-1.5");
  } else {
    args.push("-an");
  }
  args.push("-movflags", "+faststart", "-f", "mp4", videoPath);
  await runMediaCommand(config.FFMPEG_PATH, args, "ffmpeg");
};

const createPoster = async (videoPath: string, posterPath: string): Promise<void> => {
  await runMediaCommand(config.FFMPEG_PATH, [
    "-y",
    "-ss", "0.5",
    "-i", videoPath,
    "-frames:v", "1",
    "-vf", "scale=w='min(iw,720)':h=-2",
    "-map_metadata", "-1",
    "-q:v", "3",
    "-update", "1",
    posterPath,
  ], "ffmpeg", 60_000);
};

const measureStage = async <T>(
  timings: ReelProcessingTimings,
  stage: keyof ReelProcessingTimings,
  operation: () => Promise<T>,
): Promise<T> => {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    timings[stage] += Math.round(performance.now() - startedAt);
  }
};

export const processReelJob = async (jobId: string, reelId: string): Promise<ReelProcessingTimings | null> => {
  const timings: ReelProcessingTimings = { probeMs: 0, transcodeMs: 0, posterMs: 0 };
  try {
    const reel = await prisma.reel.findUnique({
      where: { id: reelId },
      select: { id: true, authorId: true, originalKey: true, deletedAt: true },
    });
    if (!reel || reel.deletedAt) {
      await prisma.processingJob.update({
        where: { id: jobId },
        data: { status: ProcessingJobStatus.COMPLETED, lockedAt: null },
      });
      return null;
    }

    const sourceHead = await getReelObjectHead(reel.originalKey);
    if (!sourceHead) {
      throw new ReelProcessingFailure(
        "The uploaded video is missing. Please try uploading it again.",
        false,
        "Uploaded source object not found",
      );
    }
    if (sourceHead.contentLength <= 0 || sourceHead.contentLength > config.REEL_MAX_UPLOAD_BYTES) {
      throw new ReelProcessingFailure("Video upload is empty or exceeds the 100 MB limit.", false);
    }

    if (!detectReelContainer(await readReelObjectPrefix(reel.originalKey))) {
      throw new ReelProcessingFailure("Upload must be an MP4, MOV, or WebM video.", false);
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

      const inputProbe = await measureStage(timings, "probeMs", () => probeVideo(inputPath));
      await measureStage(timings, "transcodeMs", () => transcodeVideo(inputPath, outputPath, inputProbe.hasAudio));
      const outputProbe = await measureStage(timings, "probeMs", () => probeVideo(outputPath));
      await measureStage(timings, "posterMs", () => createPoster(outputPath, posterPath));
      let outputStats: Awaited<ReturnType<typeof stat>>;
      try {
        outputStats = await stat(outputPath);
        await stat(posterPath);
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
        if (code !== "ENOENT") throw error;
        throw new ReelProcessingFailure(
          "The uploaded video could not be processed. Please try another video.",
          false,
          "A generated video or poster file was missing",
        );
      }

      await putReelFile(videoKey, outputPath, "video/mp4");
      outputStored = true;
      await putReelFile(posterKey, posterPath, "image/jpeg");

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

        await tx.reel.update({
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
        });
        await tx.processingJob.update({
          where: { id: jobId },
          data: { status: ProcessingJobStatus.COMPLETED, lockedAt: null, lastError: null },
        });
        return true;
      });

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
      return timings;
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
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "ENOENT" && !(error instanceof ReelProcessingFailure)) {
      throw new ReelProcessingFailure(
        "The uploaded video is missing. Please try uploading it again.",
        false,
        "Uploaded source file was missing during processing",
        timings,
      );
    }
    if (error instanceof ReelProcessingFailure && !error.timings) {
      throw new ReelProcessingFailure(error.message, error.retryable, error.diagnostic, timings);
    }
    throw error;
  }
};

export const processingErrorText = (error: unknown): string =>
  error instanceof ReelProcessingFailure
    ? error.message
    : "The video could not be processed. Please try again.";
