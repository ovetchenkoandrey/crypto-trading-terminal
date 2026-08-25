// Runs a list of segment jobs, either in this thread or across worker threads.
//
// Both executors satisfy the same interface, so the optimizer never branches on
// which one it got and the unit tests can drive the sequential one. Measured on
// this dataset a single night-mr segment over a 30-day window costs tens of
// milliseconds, so the crossover is around a hundred jobs: below that the
// worker startup and the per-worker dataset load dominate, above it the pool
// wins roughly linearly in cores.

import { Worker } from "node:worker_threads";
import { failedOutcome, runSegment, type SegmentContext, type SegmentJob, type SegmentOutcome } from "./segmentRun.ts";
import type { WorkerInit } from "./optimizeWorker.ts";

export interface ExecutorProgress {
  done: number;
  total: number;
  job: SegmentJob;
}

export interface DatasetInfo {
  bars: number;
  fundingEvents: number;
}

export interface SegmentExecutor {
  readonly workers: number;
  readonly dataset: DatasetInfo;
  run(jobs: readonly SegmentJob[], onProgress?: (p: ExecutorProgress) => void): Promise<SegmentOutcome[]>;
  close(): Promise<void>;
}

export function inlineExecutor(ctx: SegmentContext): SegmentExecutor {
  return {
    workers: 1,
    dataset: { bars: ctx.candles.length, fundingEvents: ctx.fundingEvents.length },
    async run(jobs, onProgress) {
      const out: SegmentOutcome[] = [];
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        try {
          out.push(await runSegment(ctx, job));
        } catch (err) {
          out.push(failedOutcome(job, ctx.spec.initialBalance, err instanceof Error ? err.message : String(err)));
        }
        onProgress?.({ done: i + 1, total: jobs.length, job });
      }
      return out;
    },
    async close() {
      /* nothing to release */
    },
  };
}

interface PoolWorker {
  worker: Worker;
  busy: boolean;
}

/**
 * Spawns `count` workers and waits until each has its own copy of the dataset
 * in memory. Loading the bars per worker rather than sharing them costs a few
 * hundred megabytes on a wide sweep, but keeps the candle store untouched and
 * the workers free of shared mutable state.
 */
export async function createWorkerExecutor(init: WorkerInit, count: number): Promise<SegmentExecutor> {
  const url = new URL("./optimizeWorker.ts", import.meta.url);
  const pool: PoolWorker[] = [];
  const dataset: DatasetInfo = { bars: 0, fundingEvents: 0 };

  const spawn = () =>
    new Promise<PoolWorker>((resolve, reject) => {
      const worker = new Worker(url, { workerData: init });
      const entry: PoolWorker = { worker, busy: false };
      const onFirst = (msg: { type: string; error?: string; bars?: number; funding?: number }) => {
        if (msg.type === "ready") {
          worker.off("message", onFirst);
          dataset.bars = msg.bars ?? 0;
          dataset.fundingEvents = msg.funding ?? 0;
          resolve(entry);
        } else if (msg.type === "fatal") {
          worker.terminate();
          reject(new Error(msg.error ?? "worker failed to start"));
        }
      };
      worker.on("message", onFirst);
      worker.once("error", reject);
    });

  try {
    for (const entry of await Promise.all(Array.from({ length: count }, spawn))) pool.push(entry);
  } catch (err) {
    await Promise.all(pool.map((p) => p.worker.terminate()));
    throw err;
  }

  return {
    workers: pool.length,
    dataset,
    run(jobs, onProgress) {
      if (jobs.length === 0) return Promise.resolve([]);
      return new Promise<SegmentOutcome[]>((resolve, reject) => {
        const out: SegmentOutcome[] = [];
        let next = 0;
        let done = 0;
        let settled = false;

        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          for (const p of pool) {
            p.worker.removeAllListeners("message");
            p.worker.removeAllListeners("error");
          }
          if (err) reject(err);
          else resolve(out);
        };

        const dispatch = (entry: PoolWorker) => {
          if (next >= jobs.length) {
            entry.busy = false;
            return;
          }
          entry.busy = true;
          entry.worker.postMessage({ type: "job", job: jobs[next++] });
        };

        for (const entry of pool) {
          entry.worker.on("message", (msg: { type: string; outcome?: SegmentOutcome }) => {
            if (msg.type !== "result" || !msg.outcome) return;
            out.push(msg.outcome);
            done += 1;
            onProgress?.({ done, total: jobs.length, job: jobs[Math.min(done - 1, jobs.length - 1)] });
            if (done >= jobs.length) {
              finish();
              return;
            }
            dispatch(entry);
          });
          entry.worker.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
        }

        for (const entry of pool) dispatch(entry);
      });
    },
    async close() {
      await Promise.all(pool.map((p) => p.worker.terminate()));
    },
  };
}
