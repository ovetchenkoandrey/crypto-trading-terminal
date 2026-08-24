import { describe, it, expect, afterEach } from "vitest";
import { runBacktest } from "./runner";
import { BOT_FACTORIES } from "../../bots/registry";
import type { Bot, BotContext, BotFactory } from "../../bots/base";
import type { BotConfig } from "../../store";
import type { Candle } from "../../types";
import type { SlippageSettings } from "../../settings";

const MIN = 60;
const HOUR = 3600;

const NO_SLIP: SlippageSettings = {
  kind: "none", bps: 0, spreadPct: 0, impactK: 0, impactRefQty: 1,
};

const CFG: BotConfig = {
  id: "bot-tf", kind: "tf-probe", symbol: "TESTUSDT", params: {}, status: "stopped",
};

interface Seen { index: number; bar: Candle; historyLength: number }

function registerProbe(onBar: (ctx: BotContext, bar: Candle, index: number) => void): Seen[] {
  const seen: Seen[] = [];
  const factory: BotFactory = {
    kind: CFG.kind, name: "tf probe", defaultParams: {}, paramSpec: [],
    create: (config): Bot => ({
      config,
      start: () => {},
      stop: () => {},
      onOrderFilled: () => {},
      onBar: (ctx, bar, index) => {
        seen.push({ index, bar, historyLength: ctx.history.length });
        onBar(ctx, bar, index);
      },
    }),
  };
  BOT_FACTORIES[CFG.kind] = factory;
  return seen;
}

function run(candles: Candle[], signalIntervalSec?: number) {
  return runBacktest({
    symbol: CFG.symbol,
    candles,
    bot: CFG,
    initialBalance: 10_000,
    feeRate: 0,
    slippageCfg: NO_SLIP,
    costs: {},
    signalIntervalSec,
  });
}

afterEach(() => { delete BOT_FACTORIES[CFG.kind]; });

/** Flat minute bars at `price`, starting at `startSec`. */
function flat(count: number, price: number, startSec: number): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    time: startSec + i * MIN,
    open: price, high: price, low: price, close: price, volume: 1,
  }));
}

describe("signal timeframe", () => {
  it("wakes the strategy once per signal bar, not per execution bar", async () => {
    const seen = registerProbe(() => {});

    await run(flat(150, 100, 0), HOUR);

    // 150 minutes cover two closed hours; the third is still forming.
    expect(seen.map((s) => s.index)).toEqual([0, 1]);
    expect(seen.map((s) => s.bar.time)).toEqual([0, HOUR]);
  });

  it("hands the strategy an aggregated bar", async () => {
    const bars: Candle[] = [
      { time: 0,        open: 100, high: 105, low:  95, close: 101, volume: 1 },
      { time: MIN,      open: 101, high: 130, low: 100, close: 102, volume: 2 },
      { time: 2 * MIN,  open: 102, high: 103, low:  70, close:  99, volume: 3 },
      ...flat(1, 99, HOUR),
    ];
    const seen = registerProbe(() => {});

    await run(bars, HOUR);

    expect(seen[0].bar).toMatchObject({
      time: 0, open: 100, high: 130, low: 70, close: 99, volume: 6,
    });
  });

  it("works on a 20 minute grid", async () => {
    const seen = registerProbe(() => {});

    await run(flat(45, 100, 0), 20 * MIN);

    expect(seen.map((s) => s.bar.time)).toEqual([0, 20 * MIN]);
  });

  it("keeps history to closed signal bars only", async () => {
    const seen = registerProbe(() => {});

    await run(flat(150, 100, 0), HOUR);

    expect(seen.map((s) => s.historyLength)).toEqual([1, 2]);
  });

  it("still runs bar by bar when no signal interval is given", async () => {
    const seen = registerProbe(() => {});

    await run(flat(5, 100, 0));

    expect(seen).toHaveLength(4);   // every bar after the first
  });
});

describe("intrabar ordering", () => {
  // The strategy wakes on the first minute of hour 1, so its orders reach the
  // book on the minute after that. From there price goes UP to the target at
  // 105 first, and only then DOWN through the stop at 95.
  //
  // Aggregated into hourly OHLC the same path is just high 110 / low 90, and
  // which came first is unknowable.
  const minutes: Candle[] = [
    ...flat(60, 100, 0),
    ...flat(1, 100, HOUR),                                                   // wakes the strategy
    { time: HOUR + 1 * MIN, open: 100, high: 106, low: 100, close: 106, volume: 1 },  // target hit
    { time: HOUR + 2 * MIN, open: 106, high: 110, low:  90, close:  92, volume: 1 },  // stop level, later
    ...flat(57, 92, HOUR + 3 * MIN),
    ...flat(1, 92, 2 * HOUR),
  ];

  /** Places the bracket the first time the strategy is called. */
  function bracket(): (ctx: BotContext, bar: Candle, index: number) => void {
    let placed = false;
    return (ctx) => {
      if (placed) return;
      placed = true;
      ctx.placeOrder({ symbol: CFG.symbol, side: "buy",  type: "market", price: 0, qty: 1 });
      ctx.placeOrder({ symbol: CFG.symbol, side: "sell", type: "limit", price: 105, qty: 1, reduceOnly: true });
      ctx.placeOrder({ symbol: CFG.symbol, side: "sell", type: "stop",  price:  95, qty: 1, reduceOnly: true });
    };
  }

  it("takes the target when minutes show it came first", async () => {
    registerProbe(bracket());

    const result = await run(minutes, HOUR);

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitPrice).toBe(105);
    expect(result.trades[0].pnl).toBeGreaterThan(0);
  });

  it("assumes the stop when execution runs on the signal bars themselves", async () => {
    // Same price path seen only as hourly OHLC: the engine cannot know the
    // target came first, so it takes the loss. Correct, and needlessly harsh.
    const hourly: Candle[] = [
      { time: 0,        open: 100, high: 100, low: 100, close: 100, volume: 60 },
      { time: HOUR,     open: 100, high: 100, low: 100, close: 100, volume: 60 },
      { time: 2 * HOUR, open: 100, high: 110, low:  90, close:  92, volume: 60 },
      { time: 3 * HOUR, open:  92, high:  92, low:  92, close:  92, volume: 60 },
    ];
    registerProbe(bracket());

    const result = await run(hourly);

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitPrice).toBe(95);
    expect(result.trades[0].pnl).toBeLessThan(0);
  });
});
