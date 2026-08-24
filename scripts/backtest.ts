import fs from "node:fs";
import path from "node:path";
import { writeReportFiles } from "../src/lib/data/datasetReport.ts";
import { resolveDataRoot } from "../src/lib/data/paths.ts";
import { BOT_FACTORIES } from "../src/lib/bots/registry.ts";
import { parseRunPlan, type CostsDecl, type RunDecl, type RunPlan } from "../src/lib/backtest/runConfig.ts";
import { runSpecs, type CliRunOutcome } from "../src/lib/backtest/cliRun.ts";
import { formatReportText, formatSummaryTable, summaryRow } from "../src/lib/backtest/report.ts";

const USAGE = `
Usage:
  npm run backtest -- --config runs/grid-btc.json
  npm run backtest -- --symbol BTCUSDT --from 2026-04 --to 2026-04 --bot grid \\
                      --params lowPrice=78000,highPrice=88000,levels=12,qtyPerLevel=0.002 \\
                      --costs full

  --config <file>       JSON run file. One run, or "runs": [...] for a batch.

  Ad-hoc run (ignored when --config is given):
  --symbol <sym>        e.g. BTCUSDT
  --market <name>       linear | spot (default: linear)
  --interval <tf>       execution bars: 1m 5m 15m 1h 4h 1d ... (default: 1m)
  --signal <tf>         timeframe the strategy reasons on; must be a multiple
                        of --interval (default: same as --interval)
  --from <when>         YYYY-MM | YYYY-MM-DD | ISO | epoch seconds (required)
  --to <when>           same shapes; a bare month/day means its last second
  --bot <kind>          ${Object.keys(BOT_FACTORIES).join(" | ")}
  --params <k=v,...>    bot parameters, merged over the factory defaults
  --balance <n>         initial balance in USDT (default: 1000)
  --name <text>         report name

  Costs — must be stated, never inferred:
  --costs <preset>      none  = no models at all, zero fees
                        fees  = maker/taker fees only
                        full  = fees + slippage + time-of-day context + rejection
                                + instrument rules + funding from disk
                                + 10x leverage cap with liquidation
  --slippage-bps <n>    base slippage for the "full" preset (default: 5)
  --stress <n>          also run a paired backtest with slippage x n and check
                        the "survives x2 slippage" criterion (default: off)

  --window-days <n>     rolling window for the "profitable months" share (default: 30)
  --window-step <n>     step between windows in days (default: 7)

  --data-dir <path>     dataset root (default: ./data, or $TRADING_DATA_DIR)
  --out <path>          report directory (default: <data-dir>/reports/backtest)
  --no-write            print only, write no files
  --strict              exit 1 when a run fails the acceptance criteria
  --quiet               no per-bar progress lines (reports still print)
  --help
`.trim();

interface Args {
  config?: string;
  ad: RunDecl;
  dataDir?: string;
  out?: string;
  write: boolean;
  strict: boolean;
  quiet: boolean;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(2);
}

/** Config problems are user errors, not crashes — no stack trace. */
function failConfig(message: string): never {
  process.stderr.write(`${message}\n\nrun "npm run backtest -- --help" for the config format\n`);
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

function costsPreset(preset: string, market: string, slippageBps: number): CostsDecl {
  switch (preset) {
    case "none":
      return { fees: false, slippage: false };
    case "fees":
      return { fees: market === "spot" ? "bybit-spot" : "bybit-linear", slippage: false };
    case "full":
      return {
        fees: market === "spot" ? "bybit-spot" : "bybit-linear",
        slippage: { kind: "fixed_bps", bps: slippageBps },
        slippageContext: true,
        rejection: true,
        rules: true,
        funding: market !== "spot",
        margin: market !== "spot",
      };
    default:
      return fail(`--costs must be none, fees or full (got "${preset}")`);
  }
}

function parseArgs(argv: string[]): Args {
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

  if (bare.has("help") || flags.has("help")) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  const config = flags.get("config");
  const market = flags.get("market") ?? "linear";
  const ad: RunDecl = {};

  if (!config) {
    if (!flags.has("symbol")) fail("--symbol is required without --config");
    if (!flags.has("bot")) fail("--bot is required without --config");
    if (!flags.has("costs")) {
      fail("--costs is required: a run has to declare which cost models it pays (none | fees | full)");
    }
    const slippageBps = Number(flags.get("slippage-bps") ?? 5);
    if (!Number.isFinite(slippageBps) || slippageBps < 0) fail("--slippage-bps must be a non-negative number");

    ad.name = flags.get("name");
    ad.market = market as RunDecl["market"];
    ad.symbol = flags.get("symbol");
    ad.interval = flags.get("interval") ?? "1m";
    const signal = flags.get("signal");
    if (signal) ad.signalInterval = signal;
    ad.from = flags.get("from");
    ad.to = flags.get("to");
    ad.bot = { kind: flags.get("bot"), params: parseParams(flags.get("params")) };
    ad.costs = costsPreset(flags.get("costs")!, market, slippageBps);
    if (flags.has("balance")) ad.initialBalance = Number(flags.get("balance"));
    if (flags.has("stress")) ad.stressSlippage = Number(flags.get("stress"));
    ad.window = {
      days: flags.has("window-days") ? Number(flags.get("window-days")) : undefined,
      stepDays: flags.has("window-step") ? Number(flags.get("window-step")) : undefined,
    };
  }

  return {
    config,
    ad,
    dataDir: flags.get("data-dir"),
    out: flags.get("out"),
    write: !bare.has("no-write"),
    strict: bare.has("strict"),
    quiet: bare.has("quiet"),
  };
}

function loadPlan(args: Args): RunPlan {
  if (!args.config) return build(() => parseRunPlan(args.ad, "cli"));
  const file = path.resolve(args.config);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    failConfig(`cannot read config ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    failConfig(`config ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return build(() => parseRunPlan(parsed, path.basename(file)));
}

function build(fn: () => RunPlan): RunPlan {
  try {
    return fn();
  } catch (err) {
    failConfig(err instanceof Error ? err.message : String(err));
  }
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

function createReporter(quiet: boolean): (line: string, transient?: boolean) => void {
  const tty = Boolean(process.stdout.isTTY);
  let lastAt = 0;
  return (line, transient = false) => {
    if (transient) {
      if (quiet) return;
      const now = Date.now();
      if (now - lastAt < 250) return;
      lastAt = now;
      if (!tty) return;
      process.stdout.write(`\r\x1b[2K${line}`);
      return;
    }
    if (tty) process.stdout.write("\r\x1b[2K");
    process.stdout.write(`${line}\n`);
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const plan = loadPlan(args);
  const root = resolveDataRoot(args.dataDir ?? plan.dataDir);
  const outDir = path.resolve(args.out ?? plan.out ?? path.join(root, "reports", "backtest"));
  const say = createReporter(args.quiet);

  say(`data root: ${root}`);
  say(`plan "${plan.name}": ${plan.runs.length} run(s)`);

  const { outcomes, failures } = await runSpecs(plan.runs, {
    dataRoot: root,
    onProgress: (p) => {
      const done = p.total > 0 ? ((p.index + 1) / p.total) * 100 : 0;
      say(
        `${p.spec.name}${p.stress ? " [stress]" : ""}: bar ${p.index + 1}/${p.total} (${done.toFixed(1)}%) ` +
          `equity ${p.equity.toFixed(2)} trades ${p.trades}`,
        true,
      );
    },
  });

  for (const f of failures) process.stderr.write(`run "${f.spec.name}" failed: ${f.error}\n`);

  const written: string[] = [];
  for (const outcome of outcomes) {
    printRun(outcome, say);
    if (args.write) {
      const files = writeReportFiles(outDir, safeName(outcome.report.run.name), outcome.report, formatReportText(outcome.report));
      written.push(files.json, files.txt);
    }
  }

  if (outcomes.length > 1) {
    say("");
    say("Summary");
    say(formatSummaryTable(outcomes.map((o) => o.report)));
    if (args.write) {
      const summary = {
        version: 1,
        plan: plan.name,
        generatedAt: new Date().toISOString(),
        runs: outcomes.map((o) => summaryRow(o.report)),
        failures: failures.map((f) => ({ name: f.spec.name, error: f.error })),
      };
      const files = writeReportFiles(outDir, `${safeName(plan.name)}-summary`, summary, formatSummaryTable(outcomes.map((o) => o.report)));
      written.push(files.json, files.txt);
    }
  }

  if (written.length > 0) {
    say("");
    for (const file of written) say(`report: ${file}`);
  }

  if (failures.length > 0) process.exit(1);
  if (args.strict && outcomes.some((o) => !o.report.criteria.passed)) process.exit(1);
}

function printRun(outcome: CliRunOutcome, say: (line: string) => void): void {
  const { report, coverage } = outcome;
  say("");
  if (coverage.ratio < 0.99) {
    say(
      `warning: ${report.run.name} covers ${(coverage.ratio * 100).toFixed(2)}% of the requested range ` +
        `(${coverage.bars}/${coverage.expectedBars} bars) — gaps are traded through as if they never happened`,
    );
  }
  say(formatReportText(report));
}

main().catch((err) => {
  process.stderr.write(`\n${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
