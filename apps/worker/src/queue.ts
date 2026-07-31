import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { config } from './config.js';

export const connection: ConnectionOptions = { url: config.redisUrl } as unknown as ConnectionOptions;

export const PUSH_QUEUE = 'spk-push';
export const VERIFY_QUEUE = 'spk-verify';

export interface PushJob {
  spkId: string;
  branchCode: string;
}
export interface VerifyJob {
  spkId: string;
  branchCode: string;
}

export const pushQueue = new Queue<PushJob>(PUSH_QUEUE, { connection });
export const verifyQueue = new Queue<VerifyJob>(VERIFY_QUEUE, { connection });

/** Enqueue a push, deduped by spkId so the poller can re-scan safely. */
export async function enqueuePush(job: PushJob): Promise<void> {
  await pushQueue.add('push', job, {
    jobId: `push:${job.spkId}`,
    removeOnComplete: 1000,
    removeOnFail: 5000,
    attempts: 1, // retries are managed by us via nextAttemptAt, not BullMQ
  });
}

export async function enqueueVerify(job: VerifyJob, delayMs = 5000): Promise<void> {
  await verifyQueue.add('verify', job, {
    jobId: `verify:${job.spkId}`,
    delay: delayMs,
    removeOnComplete: 1000,
    removeOnFail: 5000,
    attempts: 3,
    backoff: { type: 'exponential', delay: 15_000 },
  });
}

export function makeWorker<T>(name: string, processor: (data: T) => Promise<void>, concurrency: number): Worker<T> {
  return new Worker<T>(
    name,
    async (job) => {
      await processor(job.data);
    },
    { connection, concurrency },
  );
}
