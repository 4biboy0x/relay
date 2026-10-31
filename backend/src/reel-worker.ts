import "dotenv/config";
import { NotificationType, ProcessingJobStatus, ReelStatus, type Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./db";
import { emitToUser } from "./realtime";
import { deleteReelObject } from "./reel-storage";
import {
  checkReelMediaTools,
  processReelJob,
  processingErrorText,
  ReelProcessingFailure,
  type ReelProcessingTimings,
} from "./reel-processing";

type ClaimedJob = {
  id: string;
  payload: Prisma.JsonValue;
  attempts: number;
};

type StaleJob = ClaimedJob & { lastError: string | null };
type FailureNotification = NonNullable<Awaited<ReturnType<typeof failReelInTransaction>>>;

const jobPayloadSchema = z.object({ reelId: z.string().uuid() });
const claimNextJob = async (): Promise<ClaimedJob | null> => prisma.$transaction(async (tx) => {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "ProcessingJob"
    WHERE "type" = 'PROCESS_REEL' AND "status" = 'PENDING' AND "runAt" <= NOW()
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

const failReelInTransaction = async (
  tx: Prisma.TransactionClient,
  reelId: string,
  reason: string,
) => {
  const reel = await tx.reel.findFirst({
    where: { id: reelId, status: ReelStatus.PROCESSING, deletedAt: null },
    select: { id: true, authorId: true },
  });
  if (!reel) return null;
  await tx.reel.update({
    where: { id: reelId },
    data: { status: ReelStatus.FAILED, processingError: reason },
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
};

const emitFailureNotification = (notification: FailureNotification | null): void => {
  if (notification) emitToUser(notification.actor.id, "notification:new", notification);
};

const processingTimings = (error: unknown): ReelProcessingTimings =>
  error instanceof ReelProcessingFailure && error.timings
    ? error.timings
    : { probeMs: 0, transcodeMs: 0, posterMs: 0 };

const lifecycleLog = (reelId: string, timings: ReelProcessingTimings, outcome: "ready" | "failed", reason?: string): string =>
  `reel ${reelId}: uploading -> processing (probe ${timings.probeMs}ms, transcode ${timings.transcodeMs}ms, poster ${timings.posterMs}ms) -> ${outcome}${reason ? `: ${reason}` : ""}`;

const jobErrorDetails = (error: unknown): string =>
  error instanceof ReelProcessingFailure
    ? error.diagnostic || error.message
    : error instanceof Error ? error.message : "The video could not be processed";

const handleJobFailure = async (job: ClaimedJob, reelId: string, error: unknown): Promise<void> => {
  const reason = processingErrorText(error).slice(0, 1000);
  const details = jobErrorDetails(error).replace(/\s+/g, " ").slice(0, 1000);
  const isPermanentFailure = error instanceof ReelProcessingFailure && !error.retryable;
  const isFinalAttempt = isPermanentFailure || job.attempts >= 3;
  const notification = await prisma.$transaction(async (tx) => {
    await tx.processingJob.update({
      where: { id: job.id },
      data: {
        status: isFinalAttempt ? ProcessingJobStatus.FAILED : ProcessingJobStatus.PENDING,
        runAt: new Date(Date.now() + Math.min(10 * 60_000, 30_000 * (2 ** (job.attempts - 1)))),
        lockedAt: null,
        lastError: details,
      },
    });
    return isFinalAttempt ? failReelInTransaction(tx, reelId, reason) : null;
  });
  emitFailureNotification(notification);

  if (isFinalAttempt) {
    console.error(lifecycleLog(reelId, processingTimings(error), "failed", details));
  } else {
    console.error(`reel ${reelId}: processing attempt ${job.attempts} failed: ${details}; retry scheduled`);
  }
};

const recoverStaleJobs = async (): Promise<void> => {
  const notifications: FailureNotification[] = [];
  const failed: Array<{ reelId: string; details: string }> = [];
  const recovered = await prisma.$transaction(async (tx) => {
    const staleJobs = await tx.$queryRaw<StaleJob[]>`
      SELECT "id", "payload", "attempts", "lastError" AS "lastError"
      FROM "ProcessingJob"
      WHERE "type" = 'PROCESS_REEL' AND "status" = 'RUNNING'
        AND "lockedAt" < NOW() - INTERVAL '5 minutes'
      ORDER BY "lockedAt"
      LIMIT 100
      FOR UPDATE SKIP LOCKED
    `;
    let count = 0;
    for (const job of staleJobs) {
      const attempts = job.attempts + 1;
      const reason = "Processing stopped unexpectedly. Please try uploading again.";
      const lastError = job.lastError || reason;
      const isFinalAttempt = attempts >= 3;
      await tx.processingJob.update({
        where: { id: job.id },
        data: {
          status: isFinalAttempt ? ProcessingJobStatus.FAILED : ProcessingJobStatus.PENDING,
          attempts,
          runAt: new Date(),
          lockedAt: null,
          lastError,
        },
      });
      const payload = jobPayloadSchema.safeParse(job.payload);
      if (isFinalAttempt && payload.success) {
        const notification = await failReelInTransaction(tx, payload.data.reelId, reason);
        if (notification) notifications.push(notification);
        failed.push({ reelId: payload.data.reelId, details: lastError });
      }
      count += 1;
    }
    return count;
  });
  for (const notification of notifications) emitFailureNotification(notification);
  for (const job of failed) {
    console.error(lifecycleLog(job.reelId, processingTimings(null), "failed", job.details.replace(/\s+/g, " ").slice(0, 1000)));
  }
  if (recovered > 0) console.warn(`Recovered ${recovered} stale Reel processing job(s)`);
};

const sleepUntilWakeOrTimeout = (): Promise<void> =>
  new Promise((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      wakeWorker = null;
      resolve();
    };
    const timer = setTimeout(finish, 500);
    wakeWorker = finish;
  });

let stopping = false;
let wakeWorker: (() => void) | null = null;
let workerPromise: Promise<void> | null = null;

export const wakeReelWorker = (): void => wakeWorker?.();

export const stopReelWorker = async (): Promise<void> => {
  stopping = true;
  wakeReelWorker();
  await workerPromise;
};

export async function runReelWorker(options: { checkMediaTools?: boolean } = {}): Promise<void> {
  if (workerPromise) return workerPromise;
  stopping = false;
  const loop = async (): Promise<void> => {
    if (options.checkMediaTools !== false) await checkReelMediaTools();
    let lastCleanup = 0;
    let lastRecovery = 0;

    while (!stopping) {
      if (Date.now() - lastRecovery >= 60_000) {
        await recoverStaleJobs();
        lastRecovery = Date.now();
      }
      if (Date.now() - lastCleanup >= 15 * 60_000) {
        await cleanupExpiredMedia();
        lastCleanup = Date.now();
      }

      const job = await claimNextJob();
      if (!job) {
        await sleepUntilWakeOrTimeout();
        continue;
      }

      const payload = jobPayloadSchema.safeParse(job.payload);
      if (!payload.success) {
        await prisma.processingJob.update({
          where: { id: job.id },
          data: {
            status: ProcessingJobStatus.FAILED,
            lockedAt: null,
            lastError: "Processing job does not contain a valid Reel id",
          },
        });
        console.error(`Reel processing job ${job.id} failed: invalid Reel id in job payload`);
        continue;
      }
      const heartbeat = setInterval(() => {
        void prisma.processingJob.updateMany({
          where: { id: job.id, status: ProcessingJobStatus.RUNNING },
          data: { lockedAt: new Date() },
        }).catch((error: unknown) => {
          console.error(`Could not renew the processing lock for Reel job ${job.id}:`, error);
        });
      }, 60_000);
      try {
        const timings = await processReelJob(job.id, payload.data.reelId);
        if (timings) console.info(lifecycleLog(payload.data.reelId, timings, "ready"));
      } catch (error) {
        await handleJobFailure(job, payload.data.reelId, error);
      } finally {
        clearInterval(heartbeat);
      }
    }
  };
  workerPromise = loop();
  try {
    await workerPromise;
  } finally {
    workerPromise = null;
    wakeWorker = null;
  }
}

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

if (process.argv[1]?.endsWith("reel-worker.ts") || process.argv[1]?.endsWith("reel-worker.js")) {
  const requestStop = (): void => { void stopReelWorker(); };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  void runReelWorker().catch((error: unknown) => {
    console.error("Reel worker stopped unexpectedly:", error);
    process.exitCode = 1;
  }).finally(() => prisma.$disconnect());
}
