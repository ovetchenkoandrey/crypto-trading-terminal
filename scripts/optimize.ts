// Must come first: it installs the storage the shared zustand store expects
// before any import chain reaches it.
import "../src/lib/backtest/headless.ts";
import fs from "node:fs";
import path from "node:path";
import { writeReportFiles } from "../src/lib/data/datasetReport.ts";
import { resolveDataRoot } from "../src/lib/data/paths.ts";
import { BOT_FACTORIES } from "../src/lib/bots/registry.ts";
import { OBJECTIVES } from "../src/lib/backtest/objective.ts";
import { parseGridSpec } from "../src/lib/backtest/paramGrid.ts";
import { costsPreset, isCostPreset } from "../src/lib/backtest/costPresets.ts";
import { parseOptimizePlan, type OptimizeDecl } from "../src/lib/backtest/optimizeConfig.ts";
import { runOptimize } from "../src/lib/backtest/optimizer.ts";
import { buildOptimizeReport, formatOptimizeReportText } from "../src/lib/backtest/optimizeReport.ts";

const USAGE = `
Usage:
  npm run optimize -- --config runs/night-mr-wf.json
  npm run optimize -- --symbol BTCUSDT --from 2025-01 --to 2025-04 --bot night-mr \\
                      --interval 1m --signal 15m --costs full \\
                      --grid "bbPeriod=15,20,30;bbMult=2,2.5,3;stopAtrMult=1:2.5:0.5" \\
                      --train-days 45 --test-days 15

  --config <file>       JSON optimizer file: { base, grid, walkForward, ... }

  Ad-hoc run (ignored when --config is given). Everything the single-run CLI
  takes, plus:
  --grid <spec>         "key=a,b,c;key2=from:to:step" — the parameters to sweep
  --train-days <n>      length of each fitting window (required without --config)
  --test-days <n>       length of each validation window (required without --config)
  --step-days <n>       distance between folds (default: --test-days)
  --mode <name>         rolling | anchored (default: rolling)
  --warmup-bars <n>     execution bars fed before each window, trimmed from its metrics
  --min-folds <n>       refuse to run with fewer folds than this (default: 2)

  Base run:
  --symbol <sym>        e.g. BTCUSDT                --market <name>   linear | spot
  --interval <tf>       execution bars (default 1m) --signal <tf>     signal timeframe
  --from <when>         YYYY-MM | YYYY-MM-DD | ISO | epoch seconds
  --to <when>           same shapes
  --params <k=v,...>    parameters held fixed, merged over the bot defaults
  --bot <kind>          ${Object.keys(BOT_FACTORIES).join(" | ")}
  --balance <n>         initial balance per fold (default: 1000)
  --costs <preset>      none | fees | full  (required)
  --slippage-bps <n>    base slippage for the "full" preset (default: 5)
  --stress <n>          also run the selected track with slippage x n (default: 2)
  --window-days <n>     rolling window for the "profitable months" share (default: 30)
  --window-step <n>     step between those windows in days (default: 7)

  Search behaviour:
  --objective <name>    ${OBJECTIVES.join(" | ")} (default: sharpe)
  --min-train-trades <n> a combination below this is not selectable (default: 20)
  --top <n>             combinations listed in the report (default: 10)
  --max-combos <n>      refuse to expand a grid larger than this (default: 20000)
  --workers <n|auto>    worker threads (default: auto = cores - 1)
  --seed <n>            bootstrap seed, for reproducible p-values
  --bootstrap <n>       bootstrap draws for the reality check (default: 2000)
  --plateau-axes <a,b>  parameters to draw the ASCII map over
  --no-test-all         skip evaluating every combination out of sample
                        (faster, but no reality check and no out-of-sample map)
  --no-naive            skip the "what plain optimization would have claimed" run

  --data-dir <path>     dataset root (default: ./data, or $TRADING_DATA_DIR)
  --out <path>          report directory (default: <data-dir>/reports/optimize)
  --no-write            print only, write no files
  --strict              exit 1 unless the gate, the correction and the plateau all pass
  --quiet               no progress lines
  --help
`.trim();

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(2);
}

function failConfig(message: string): never {
  process.stderr.write(`${message}\n\nrun "npm run optimize -- --help" for the config format\n`);
  process.exit(2);
}

function parseParams(raw: string | undefined): Record<string, number | string> {
  if (!raw) return {};
  const out: Record<string, number | string> = {};
  for (const pair of raw.split(",")) {
    if (!pair.trim()) continue;
    const eq = pair.indexOf("=");
    if (eq < 0) fail(`--params: "${pair}" is not key=value`);
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const num = Number(value);
    out[key] = value !== "" && Number.isFinite(num) ? num : value;
  }
  return out;
}

interface Flags {
  get(name: string): string | undefined;
  has(name: string): boolean;
  bare(name: string): boolean;
  number(name: string, fallback?: number): number | undefined;
}

function readFlags(argv: string[]): Flags {
  const flags = new Map<string, string>();
  const bare = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq !== -1) {
      flags.set(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i++;
    } else {
      bare.add(name);
    }
  }
  return {
    get: (name) => flags.get(name),
    has: (name) => flags.has(name),
    bare: (name) => bare.has(name),
    number: (name, fallback) => {
      if (!flags.has(name)) return fallback;
      const n = Number(flags.get(name));
      if (!Number.isFinite(n)) fail(`--${name} must be a number`);
      return n;
    },
  };
}

function buildDecl(flags: Flags): OptimizeDecl {
  const configPath = flags.get("config");
  if (configPath) {
    const file = path.resolve(configPath);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      failConfig(`cannot read config ${file}`);
    }
    try {
      return JSON.parse(raw) as OptimizeDecl;
    } catch (err) {
      failConfig(`config ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!flags.has("symbol")) fail("--symbol is required without --config");
  if (!flags.has("bot")) fail("--bot is required without --config");
  if (!flags.has("grid")) fail("--grid is required without --config");
  if (!flags.has("costs")) fail("--costs is required: a run has to declare which cost models it pays (none | fees | full)");
  if (!flags.has("train-days") || !flags.has("test-days")) fail("--train-days and --test-days are required without --config");

  const market = flags.get("market") ?? "linear";
  const preset = flags.get("costs")!;
  if (!isCostPreset(preset)) fail(`--costs must be none, fees or full (got "${preset}")`);
  const slippageBps = flags.number("slippage-bps", 5)!;
  if (slippageBps < 0) fail("--slippage-bps must be non-negative");

  let grid;
  try {
    grid = parseGridSpec(flags.get("grid")!);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const plateauAxes = flags.get("plateau-axes");

  return {
    name: flags.get("name"),
    base: {
      market: market as "linear" | "spot",
      symbol: flags.get("symbol"),
      interval: flags.get("interval") ?? "1m",
      signalInterval: flags.get("signal"),
      from: flags.get("from"),
      to: flags.get("to"),
      initialBalance: flags.number("balance"),
      bot: { kind: flags.get("bot"), params: parseParams(flags.get("params")) },
      costs: costsPreset(preset, market, slippageBps),
      stressSlippage: flags.has("stress") ? flags.number("stress") : 2,
      window: { days: flags.number("window-days"), stepDays: flags.number("window-step") },
    },
    grid,
    walkForward: {
      trainDays: flags.number("train-days")!,
      testDays: flags.number("test-days")!,
      stepDays: flags.number("step-days"),
      mode: (flags.get("mode") as "rolling" | "anchored" | undefined) ?? undefined,
      warmupBars: flags.number("warmup-bars"),
      minFolds: flags.number("min-folds"),
    },
    objective: flags.get("objective") as OptimizeDecl["objective"],
    minTrainTrades: flags.number("min-train-trades"),
    topN: flags.number("top"),
    maxCombos: flags.number("max-combos"),
    workers: flags.get("workers") === "auto" ? "auto" : flags.number("workers"),
    seed: flags.number("seed"),
    bootstrapSamples: flags.number("bootstrap"),
    evaluateAllOnTest: !flags.bare("no-test-all"),
    compareNaive: !flags.bare("no-naive"),
    plateauAxes: plateauAxes ? plateauAxes.split(",").map((s) => s.trim()) : undefined,
  };
}

function createReporter(quiet: boolean): (line: string, transient?: boolean) => void {
  const tty = Boolean(process.stdout.isTTY);
  let lastAt = 0;
  return (line, transient = false) => {
    if (transient) {
      if (quiet || !tty) return;
      const now = Date.now();
      if (now - lastAt < 250) return;
      lastAt = now;
      process.stdout.write(`\r\x1b[2K${line}`);
      return;
    }
    if (tty) process.stdout.write("\r\x1b[2K");
    process.stdout.write(`${line}\n`);
  };
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "optimize";
}

async function main(): Promise<void> {
  const flags = readFlags(process.argv.slice(2));
  if (flags.bare("help") || flags.has("help")) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  const decl = buildDecl(flags);
  let plan;
  try {
    plan = parseOptimizePlan(decl, flags.get("config") ? path.basename(flags.get("config")!) : "cli");
  } catch (err) {
    failConfig(err instanceof Error ? err.message : String(err));
  }

  const root = resolveDataRoot(flags.get("data-dir") ?? plan.dataDir);
  const outDir = path.resolve(flags.get("out") ?? plan.out ?? path.join(root, "reports", "optimize"));
  const say = createReporter(flags.bare("quiet"));

  say(`data root: ${root}`);
  say(`plan "${plan.name}": ${plan.grid.size} combination(s), ${plan.walkForward.folds.length} fold(s)`);

  const started = Date.now();
  const elapsed = () => ((Date.now() - started) / 1000).toFixed(1);
  const result = await runOptimize(plan, {
    dataRoot: root,
    onPhase: (phase, detail) => say(`[${elapsed()}s] ${phase}: ${detail}`),
    onProgress: (p) => {
      const share = p.total > 0 ? (p.done / p.total) * 100 : 0;
      const rate = p.done / Math.max(0.001, (Date.now() - started) / 1000);
      say(`${p.phase}: ${p.done}/${p.total} (${share.toFixed(1)}%) ${rate.toFixed(1)} runs/s`, true);
    },
  });

  say(`[${elapsed()}s] done`);
  say("");
  say(formatOptimizeReportText(result));

  if (!flags.bare("no-write")) {
    const files = writeReportFiles(outDir, safeName(plan.name), buildOptimizeReport(result), formatOptimizeReportText(result));
    say("");
    say(`report: ${files.json}`);
    say(`report: ${files.txt}`);
  }

  if (flags.bare("strict")) {
    const ok =
      result.stitched.criteria?.passed === true &&
      result.multipleTesting.verdict === "survives" &&
      result.plateau?.train.verdict === "plateau";
    if (!ok) process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
