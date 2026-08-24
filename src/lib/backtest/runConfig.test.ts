import { describe, expect, it } from "vitest";
import { monthStartSec } from "../data/months.ts";
import {
  DEFAULT_MARGIN,
  parseRunPlan,
  parseRunTime,
  resolveCosts,
  resolveFees,
  resolveRunSpec,
  resolveSlippage,
  type CostsDecl,
  type RunDecl,
} from "./runConfig.ts";

const COSTS: CostsDecl = { fees: "bybit-linear", slippage: { kind: "fixed_bps", bps: 5 } };

function decl(over: Partial<RunDecl> = {}): RunDecl {
  return {
    symbol: "BTCUSDT",
    from: "2026-04",
    to: "2026-04",
    bot: { kind: "grid", params: { lowPrice: 60000, highPrice: 70000 } },
    costs: COSTS,
    ...over,
  };
}

describe("parseRunTime", () => {
  it("expands a bare month to its first and last second", () => {
    expect(parseRunTime("2026-04", "start", "from")).toBe(monthStartSec("2026-04"));
    expect(parseRunTime("2026-04", "end", "to")).toBe(monthStartSec("2026-05") - 1);
  });

  it("expands a bare day the same way", () => {
    const start = Date.UTC(2026, 3, 5) / 1000;
    expect(parseRunTime("2026-04-05", "start", "from")).toBe(start);
    expect(parseRunTime("2026-04-05", "end", "to")).toBe(start + 86_399);
  });

  it("reads an ISO timestamp as UTC even without a zone suffix", () => {
    expect(parseRunTime("2026-04-05T12:00:00", "start", "from")).toBe(Date.UTC(2026, 3, 5, 12) / 1000);
    expect(parseRunTime("2026-04-05T12:00:00Z", "start", "from")).toBe(Date.UTC(2026, 3, 5, 12) / 1000);
  });

  it("accepts epoch seconds and milliseconds", () => {
    expect(parseRunTime(1_700_000_000, "start", "from")).toBe(1_700_000_000);
    expect(parseRunTime(1_700_000_000_000, "start", "from")).toBe(1_700_000_000);
  });

  it("refuses garbage instead of defaulting", () => {
    expect(() => parseRunTime("last tuesday", "start", "from")).toThrow(/cannot parse/);
    expect(() => parseRunTime(undefined, "start", "from")).toThrow(/required/);
  });
});

describe("resolveRunSpec", () => {
  it("fills bot params over the factory defaults and keeps the declared ones", () => {
    const spec = resolveRunSpec(decl());
    expect(spec.bot.kind).toBe("grid");
    expect(spec.bot.params.lowPrice).toBe(60000);
    expect(spec.bot.params.qtyPerLevel).toBe(0.001); // from gridBotFactory.defaultParams
    expect(spec.bot.symbol).toBe("BTCUSDT");
  });

  it("defaults to linear 1m and a 1000 USDT balance", () => {
    const spec = resolveRunSpec(decl());
    expect(spec.market).toBe("linear");
    expect(spec.interval).toBe("1m");
    expect(spec.initialBalance).toBe(1000);
    expect(spec.window).toEqual({ days: 30, stepDays: 7 });
  });

  it("rejects a run that does not declare its costs", () => {
    const { costs: _drop, ...rest } = decl();
    expect(() => resolveRunSpec(rest)).toThrow(/costs must be declared explicitly/);
  });

  it("rejects a costs block that skips fees or slippage", () => {
    expect(() => resolveRunSpec(decl({ costs: { slippage: false } as unknown as CostsDecl })))
      .toThrow(/costs\.fees must be stated explicitly/);
    expect(() => resolveRunSpec(decl({ costs: { fees: false } as unknown as CostsDecl })))
      .toThrow(/costs\.slippage must be stated explicitly/);
  });

  it("accepts an explicit no-cost declaration and zeroes the flat fee", () => {
    const spec = resolveRunSpec(decl({ costs: { fees: false, slippage: false } }));
    expect(spec.feeRate).toBe(0);
    expect(resolveCosts(spec).costs).toEqual({});
  });

  it("keeps a declared flat fee rate as the venue fallback", () => {
    const spec = resolveRunSpec(decl({ costs: { fees: { flatRate: 0.001 }, slippage: false } }));
    expect(spec.feeRate).toBe(0.001);
    expect(resolveCosts(spec).costs.fees).toBeUndefined();
  });

  it("refuses an unknown bot kind and an inverted range", () => {
    expect(() => resolveRunSpec(decl({ bot: { kind: "nope" } }))).toThrow(/unknown bot kind/);
    expect(() => resolveRunSpec(decl({ from: "2026-05", to: "2026-04" }))).toThrow(/to must be after from/);
  });
});

describe("parseRunPlan", () => {
  it("treats a bare object as a single run", () => {
    const plan = parseRunPlan(decl({ name: "solo" }));
    expect(plan.runs).toHaveLength(1);
    expect(plan.runs[0].name).toBe("solo");
  });

  it("merges defaults into every run and lets a run override them", () => {
    const plan = parseRunPlan({
      name: "sweep",
      defaults: decl(),
      runs: [
        { name: "a", bot: { params: { levels: 10 } } },
        { name: "b", bot: { params: { levels: 20 } }, initialBalance: 5000 },
      ],
    });
    expect(plan.runs.map((r) => r.name)).toEqual(["a", "b"]);
    expect(plan.runs[0].bot.params.levels).toBe(10);
    expect(plan.runs[0].bot.params.lowPrice).toBe(60000);
    expect(plan.runs[0].initialBalance).toBe(1000);
    expect(plan.runs[1].bot.params.levels).toBe(20);
    expect(plan.runs[1].initialBalance).toBe(5000);
  });

  it("makes duplicate run names unique so reports do not overwrite each other", () => {
    const plan = parseRunPlan({ defaults: decl({ name: "same" }), runs: [{}, {}, {}] });
    expect(plan.runs.map((r) => r.name)).toEqual(["same", "same-2", "same-3"]);
  });

  it("requires costs even when only defaults are given", () => {
    const { costs: _drop, ...bare } = decl();
    expect(() => parseRunPlan({ defaults: bare, runs: [{}] })).toThrow(/costs must be declared/);
  });
});

describe("resolveFees / resolveSlippage", () => {
  it("maps the exchange presets", () => {
    expect(resolveFees("bybit-linear")).toEqual({ makerRate: 0.0002, takerRate: 0.00055 });
    expect(resolveFees("bybit-spot")).toEqual({ makerRate: 0.001, takerRate: 0.001 });
    expect(resolveFees(false)).toBeUndefined();
  });

  it("multiplies only the slippage magnitude under stress", () => {
    expect(resolveSlippage({ kind: "fixed_bps", bps: 5 }, 2).bps).toBe(10);
    expect(resolveSlippage({ kind: "volume_impact", impactK: 4, impactRefQty: 2 }, 2)).toMatchObject({
      impactK: 8,
      impactRefQty: 2,
    });
  });

  it("caps a stressed spread fraction at the whole spread", () => {
    expect(resolveSlippage({ kind: "spread_pct", spreadPct: 0.7 }, 2).spreadPct).toBe(1);
  });

  it("turns an absent model off rather than defaulting it on", () => {
    expect(resolveSlippage(false).kind).toBe("none");
  });
});

describe("resolveCosts", () => {
  it("only includes the models that were declared", () => {
    const spec = resolveRunSpec(decl());
    const resolved = resolveCosts(spec);
    expect(resolved.costs.fees).toBeDefined();
    expect(resolved.costs.rejection).toBeUndefined();
    expect(resolved.costs.rules).toBeUndefined();
    expect(resolved.costs.funding).toBeUndefined();
    expect(resolved.costs.margin).toBeUndefined();
  });

  it("expands the boolean toggles to their documented defaults", () => {
    const spec = resolveRunSpec(decl({
      costs: { ...COSTS, slippageContext: true, rejection: true, rules: true, margin: true },
    }));
    const resolved = resolveCosts(spec);
    expect(resolved.costs.slippageContext?.enabled).toBe(true);
    expect(resolved.costs.rejection?.enabled).toBe(true);
    expect(resolved.costs.rules?.symbol).toBe("BTCUSDT");
    expect(resolved.costs.margin).toEqual(DEFAULT_MARGIN);
  });

  it("merges a partial override onto the defaults", () => {
    const spec = resolveRunSpec(decl({ costs: { ...COSTS, rejection: { limitFillProbability: 0.2 } } }));
    const rejection = resolveCosts(spec).costs.rejection!;
    expect(rejection.limitFillProbability).toBe(0.2);
    expect(rejection.slippageToleranceBps).toBe(50);
  });

  it("passes funding events through only when funding was declared", () => {
    const events = [{ timestamp: 1, rate: 0.0001 }];
    const off = resolveCosts(resolveRunSpec(decl()), events);
    expect(off.costs.funding).toBeUndefined();
    const on = resolveCosts(resolveRunSpec(decl({ costs: { ...COSTS, funding: true } })), events);
    expect(on.costs.funding?.events).toHaveLength(1);
  });

  it("describes every model, including the ones that are off", () => {
    const resolved = resolveCosts(resolveRunSpec(decl()));
    expect(resolved.description.join("\n")).toMatch(/fees: maker 0\.02% \/ taker 0\.055%/);
    expect(resolved.description.join("\n")).toMatch(/rejection: off/);
    expect(resolved.description.join("\n")).toMatch(/margin: off/);
  });
});
