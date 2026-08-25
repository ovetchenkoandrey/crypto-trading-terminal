// Worker-thread half of the sweep. Loads the dataset slice once, then answers
// one segment job at a time until the pool closes it.
//
// Pull model rather than a pre-split batch: segments differ in cost by a factor
// of several (a training window is three times a test window, and a combination
// that trades a lot is slower than one that never fires), so handing every
// worker a fixed share would leave most of them idle waiting for the unlucky one.

import "./headless.ts";
import { parentPort, workerData } from "node:worker_threads";
import { createCandleStore } from "../data/candleStore.ts";
import { createFundingStore } from "../data/fundingStore.ts";
import { loadCandles, loadFunding } from "./cliRun.ts";
import { failedOutcome, runSegment, type SegmentContext, type SegmentJob } from "./segmentRun.ts";
import type { RunSpec } from "./runConfig.ts";

export interface WorkerInit {
  dataRoot: string;
  spec: RunSpec;
  warmupBars: number;
}

type Incoming = { type: "job"; job: SegmentJob } | { type: "close" };

if (!parentPort) throw new Error("optimizeWorker must be started as a worker thread");
const port = parentPort;

let ctx: SegmentContext | null = null;

try {
  const init = workerData as WorkerInit;
  const candleStore = createCandleStore(init.dataRoot);
  const fundingStore = createFundingStore(init.dataRoot);
  const candles = loadCandles(candleStore, init.spec);
  const fundingEvents = init.spec.costs.funding ? loadFunding(fundingStore, init.spec) : [];
  ctx = { spec: init.spec, candles, fundingEvents, warmupBars: init.warmupBars };
  port.postMessage({ type: "ready", bars: candles.length, funding: fundingEvents.length });
} catch (err) {
  port.postMessage({ type: "fatal", error: err instanceof Error ? err.message : String(err) });
}

port.on("message", (msg: Incoming) => {
  if (msg.type === "close") {
    port.close();
    return;
  }
  if (msg.type !== "job" || !ctx) return;
  runSegment(ctx, msg.job)
    .then((outcome) => port.postMessage({ type: "result", outcome }))
    .catch((err) =>
      port.postMessage({
        type: "result",
        outcome: failedOutcome(msg.job, ctx?.spec.initialBalance ?? 0, err instanceof Error ? err.message : String(err)),
      }),
    );
});
