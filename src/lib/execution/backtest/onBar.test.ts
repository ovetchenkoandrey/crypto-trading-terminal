import { describe, it, expect, afterEach } from "vitest";
import { runBacktest } from "./runner";
import { BOT_FACTORIES } from "../../bots/registry";
import type { Bot, BotContext, BotFactory } from "../../bots/base";
import type { BotConfig } from "../../store";
import type { Candle } from "../../types";
import type { SlippageSettings } from "../../settings";

const NO_SLIP: SlippageSettings = {
  kind: "none", bps: 0, spreadPct: 0, impactK: 0, impactRefQty: 1,
};

// Opens and closes differ on every bar so a fill price identifies which bar and
// which field it came from.
const bars: Candle[] = [
  { time: 100, open: 100, high: 105, low:  95, close: 101, volume: 1 },
  { time: 160, open: 102, high: 107, low:  97, close: 103, volume: 1 },
  { time: 220, open: 110, high: 115, low: 105, close: 111, volume: 1 },
  { time: 280, open: 120, high: 125, low: 115, close: 121, volume: 1 },
  { time: 340, open: 130, high: 135, low: 125, close: 131, volume: 1 },
];

const CFG: BotConfig = {
  id: "bot-test", kind: "onbar-probe", symbol: "TESTUSDT", params: {}, status: "stopped",
};

interface Probe {
  bars: { index: number; historyLength: number; futureVisible: boolean; close: number }[];
}

/** Registers a bot driven by the supplied onBar callback; returns what it saw. */
function registerProbe(onBar: (ctx: BotContext, bar: Candle, index: number) => void): Probe {
  const probe: Probe = { bars: [] };
  const factory: BotFactory = {
    kind: CFG.kind,
    name: "onbar probe",
    defaultParams: {},
    paramSpec: [],
    create: (config): Bot => ({
      config,
      start: () => {},
      stop: () => {},
      onOrderFilled: () => {},
      onBar: (ctx, bar, index) => {
        probe.bars.push({
          index,
          historyLength: ctx.history.length,
          futureVisible: ctx.history.at(index + 1) !== undefined,
          close: bar.close,
        });
        onBar(ctx, bar, index);
      },
    }),
  };
  BOT_FACTORIES[CFG.kind] = factory;
  return probe;
}

function run(candles = bars) {
  return runBacktest({
    symbol: CFG.symbol,
    candles,
    bot: CFG,
    initialBalance: 10000,
    feeRate: 0,
    slippageCfg: NO_SLIP,
    costs: {},
  });
}

afterEach(() => {
  delete BOT_FACTORIES[CFG.kind];
});

describe("onBar hook", () => {
  it("is called once per bar after the first", async () => {
    const probe = registerProbe(() => {});

    await run();

    expect(probe.bars.map((b) => b.index)).toEqual([1, 2, 3, 4]);
    expect(probe.bars.map((b) => b.close)).toEqual([103, 111, 121, 131]);
  });

  it("never exposes bars beyond the current one", async () => {
    const probe = registerProbe(() => {});

    await run();

    for (const seen of probe.bars) {
      expect(seen.historyLength).toBe(seen.index + 1);
      expect(seen.futureVisible).toBe(false);
    }
  });

  it("fills a market order at the next bar's open, not this bar's close", async () => {
    registerProbe((ctx, _bar, index) => {
      if (index === 1) {
        ctx.placeOrder({ symbol: CFG.symbol, side: "buy", type: "market", price: 0, qty: 1 });
      }
    });

    const result = await run();

    // Decision taken on bar 1 (close 103); earliest reachable price is bar 2 open = 110.
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].entryPrice).toBe(110);
    expect(result.positions[0].entryPrice).not.toBe(103);
  });

  it("realises pnl against the following open on a round trip", async () => {
    registerProbe((ctx, _bar, index) => {
      if (index === 1) ctx.placeOrder({ symbol: CFG.symbol, side: "buy",  type: "market", price: 0, qty: 2 });
      if (index === 2) ctx.placeOrder({ symbol: CFG.symbol, side: "sell", type: "market", price: 0, qty: 2 });
    });

    const result = await run();

    // Buy fills at bar 2 open (110), sell fills at bar 3 open (120): +10 x 2.
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].entryPrice).toBe(110);
    expect(result.trades[0].exitPrice).toBe(120);
    expect(result.trades[0].pnl).toBeCloseTo(20, 6);
  });

  it("exposes balance and positions to the strategy", async () => {
    const seen: { positions: number; equity: number }[] = [];
    registerProbe((ctx, _bar, index) => {
      if (index === 1) ctx.placeOrder({ symbol: CFG.symbol, side: "buy", type: "market", price: 0, qty: 1 });
      seen.push({ positions: ctx.getPositions().length, equity: ctx.getBalance().equity });
    });

    await run();

    expect(seen[0].positions).toBe(0);          // order queued, not yet filled
    expect(seen[1].positions).toBe(1);          // filled at bar 2 open
    expect(seen[1].equity).toBeGreaterThan(0);
  });

  it("reports bar time, not wall clock, as now()", async () => {
    const stamps: number[] = [];
    registerProbe((ctx) => { stamps.push(ctx.now()); });

    await run();

    expect(stamps).toEqual([160_000, 220_000, 280_000, 340_000]);
  });

  it("leaves a market order unfilled when no bar follows", async () => {
    registerProbe((ctx, _bar, index) => {
      if (index === 4) {
        ctx.placeOrder({ symbol: CFG.symbol, side: "buy", type: "market", price: 0, qty: 1 });
      }
    });

    const result = await run();

    expect(result.positions).toHaveLength(0);
    expect(result.orders.filter((o) => o.status === "pending")).toHaveLength(1);
  });
});
