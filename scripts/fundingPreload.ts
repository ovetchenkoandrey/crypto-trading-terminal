// Side-effect module: hands the on-disk funding history to the funding-extreme bot.
//
// The bot itself has no file access — it has to stay bundleable for the browser
// alongside the rest of the registry — so something Node-side must push the
// settlements in before a run starts. Loading it as `--import` rather than
// calling it from a CLI entry point is deliberate: worker threads inherit
// `execArgv`, so the optimizer's workers get the same history without
// `scripts/optimize.ts` knowing this bot exists.
//
//   node --experimental-transform-types --import ./scripts/tsLoader.mjs \
//        --import ./scripts/fundingPreload.ts scripts/optimize.ts ...
//
// Two megabytes of JSON for four symbols; loading all of it unconditionally is
// cheaper than threading the symbol through the command line.

import { createFundingStore } from "../src/lib/data/fundingStore.ts";
import { resolveDataRoot } from "../src/lib/data/paths.ts";
import { setFundingHistory } from "../src/lib/bots/fundingExtreme.ts";

const SYMBOLS = (process.env.FUNDING_PRELOAD_SYMBOLS ?? "BTCUSDT,ETHUSDT,XRPUSDT,SOLUSDT")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const store = createFundingStore(resolveDataRoot(process.env.TRADING_DATA_DIR));
for (const symbol of SYMBOLS) {
  const events = store.readRange("linear", symbol, 0, 2_000_000_000);
  if (events.length > 0) setFundingHistory(symbol, events);
}
