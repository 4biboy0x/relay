import "dotenv/config";
import { NotificationType, ProcessingJobStatus, ReelStatus, type Prisma } from "@prisma/client";
import { z } from "zod";
import { config } from "./config";
import { prisma } from "./db";
import { emitToUser } from "./realtime";
import {
  deleteReelObject,
} from "./reel-storage";
import { processReelJob, processingErrorText } from "./reel-processing";

type ClaimedJob = {
  id: string;
  payload: Prisma.JsonValue;
  attempts: number;
};

const jobPayloadSchema = z.object({ reelId: z.string().uuid() });
const claimNextJob = async (): Promise<ClaimedJob | null> => prisma.$transaction(async (tx) => {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "ProcessingJob"
    WHERE (
      ("status" = 'PENDING' AND "runAt" <= NOW())
      OR ("status" = 'RUNNING' AND "lockedAt" < NOW() - INTERVAL '15 minutes')
    )
    AND "attempts" < 3
    ORDER BY "runAt", "createdAt"
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  `;
  const row = rows[0];
  if (!row) return null;

  return tx.processingJob.update({
    where: { id: row.id },
    data: {
      status: ProcessingJobStatus.RUNNING,
      attempts: { increment: 1 },
      lockedAt: new Date(),
    },
    select: { id: true, payload: true, attempts: true },
  });
});

const notificationInclude = {
  actor: { select: { id: true, handle: true, displayName: true, avatarUrl: true } },
} as const;

const emitFailedNotification = async (reelId: string): Promise<void> => {
  const notification = await prisma.$transaction(async (tx) => {
    const reel = await tx.reel.findUnique({
      where: { id: reelId },
      select: { id: true, authorId: true, deletedAt: true },
    });
    if (!reel || reel.deletedAt) return null;
    await tx.reel.update({
      where: { id: reelId },
      data: { status: ReelStatus.FAILED },
    });
    return tx.notification.create({
      data: {
        recipientId: reel.authorId,
        actorId: reel.authorId,
        reelId,
        type: NotificationType.REEL_FAILED,
      },
      include: notificationInclude,
    });
  });
  if (notification) emitToUser(notification.actor.id, "notification:new", notification);
};

const handleJobFailure = async (job: ClaimedJob, error: unknown): Promise<void> => {
  const message = processingErrorText(error).slice(0, 1000);
  const isFinalAttempt = job.attempts >= 3;
  await prisma.processingJob.update({
    where: { id: job.id },
    data: {
      status: isFinalAttempt ? ProcessingJobStatus.FAILED : ProcessingJobStatus.PENDING,
      runAt: new Date(Date.now() + Math.min(10 * 60_000, 30_000 * (2 ** (job.attempts - 1)))),
      lockedAt: null,
      lastError: message,
    },
  });
  console.error(`Reel processing job ${job.id} failed on attempt ${job.attempts}: ${message}`);

  if (isFinalAttempt) {
    const payload = jobPayloadSchema.safeParse(job.payload);
    if (payload.success) {
      await prisma.reel.updateMany({
        where: { id: payload.data.reelId, deletedAt: null },
        data: { status: ReelStatus.FAILED, processingError: message },
      });
      await emitFailedNotification(payload.data.reelId);
    }
  }
};

const failExhaustedStaleJobs = async (): Promise<void> => {
  const staleJobs = await prisma.processingJob.findMany({
    where: {
      status: ProcessingJobStatus.RUNNING,
      attempts: { gte: 3 },
      lockedAt: { lt: new Date(Date.now() - 15 * 60_000) },
    },
    select: { id: true, payload: true, lastError: true },
    take: 100,
  });

  for (const job of staleJobs) {
    const updated = await prisma.processingJob.updateMany({
      where: { id: job.id, status: ProcessingJobStatus.RUNNING },
      data: {
        status: ProcessingJobStatus.FAILED,
        lockedAt: null,
        lastError: job.lastError || "Worker stopped during the final processing attempt",
      },
    });
    if (updated.count !== 1) continue;

    const payload = jobPayloadSchema.safeParse(job.payload);
    if (!payload.success) continue;
    await prisma.reel.updateMany({
      where: { id: payload.data.reelId, deletedAt: null },
      data: {
        status: ReelStatus.FAILED,
        processingError: job.lastError || "Worker stopped during the final processing attempt",
      },
    });
    await emitFailedNotification(payload.data.reelId);
  }
};

const cleanupExpiredMedia = async (): Promise<void> => {
  const expiredUploads = await prisma.reel.findMany({
    where: {
      status: ReelStatus.UPLOADING,
      createdAt: { lt: new Date(Date.now() - 60 * 60_000) },
    },
    select: { id: true, originalKey: true },
    take: 100,
  });
  for (const reel of expiredUploads) {
    await deleteReelObject(reel.originalKey);
    await prisma.reel.updateMany({
      where: { id: reel.id, status: ReelStatus.UPLOADING },
      data: { status: ReelStatus.FAILED, processingError: "Upload expired before completion" },
    });
  }

  const expiredSoftDeletes = await prisma.reel.findMany({
    where: {
      deletedAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60_000) },
      storageDeletedAt: null,
    },
    select: { id: true, originalKey: true, videoKey: true, posterKey: true },
    take: 100,
  });
  for (const reel of expiredSoftDeletes) {
    const keys = [reel.originalKey, reel.videoKey, reel.posterKey].filter((key): key is string => key !== null);
    await Promise.all(keys.map((key) => deleteReelObject(key)));
    await prisma.reel.updateMany({
      where: { id: reel.id, deletedAt: { not: null }, storageDeletedAt: null },
      data: {
        status: ReelStatus.REMOVED,
        videoKey: null,
        posterKey: null,
        storageDeletedAt: new Date(),
      },
    });
  }
};

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function runReelWorker(): Promise<void> {
  let stopping = false;
  let lastCleanup = 0;
  let lastRecovery = 0;
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });

  try {
    while (!stopping) {
      if (Date.now() - lastRecovery >= 60_000) {
        await failExhaustedStaleJobs();
        lastRecovery = Date.now();
      }
      if (Date.now() - lastCleanup >= 15 * 60_000) {
        await cleanupExpiredMedia();
        lastCleanup = Date.now();
      }

      const job = await claimNextJob();
      if (!job) {
        await sleep(1000);
        continue;
      }

      const payload = jobPayloadSchema.safeParse(job.payload);
      if (!payload.success) {
        await handleJobFailure(job, new Error("Processing job has an invalid payload"));
        continue;
      }
      try {
        await processReelJob(job.id, payload.data.reelId);
      } catch (error) {
        await handleJobFailure(job, error);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.endsWith("reel-worker.ts") || process.argv[1]?.endsWith("reel-worker.js")) {
  void runReelWorker().catch((error: unknown) => {
    console.error("Reel worker stopped unexpectedly:", error);
    process.exitCode = 1;
  });
}
