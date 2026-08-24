// Glues a bot to a BacktestVenue + clock. Steps the clock bar-by-bar, lets the
// bot react to fills via its standard onOrderFilled hook, samples equity every
// bar, and returns a Promise<BacktestResult> on completion.

import type { Candle } from "../../types";
import type { BotConfig } from "../../store";
import type { Bot, BotContext } from "../../bots/base";
import { getBotFactory } from "../../bots/registry";
import { BacktestClock } from "./clock";
import { CursorBarHistory } from "../../bots/history";
import { BacktestVenueImpl } from "./BacktestVenue";
import { computeStats, type BacktestStats, type EquitySample } from "./stats";
import type { SlippageSettings } from "../../settings";
import type { SlippageContextSettings } from "../slippage";
import type { FeeSettings } from "../fees";
import type { RejectionSettings } from "../rejection";
import type { InstrumentRules } from "../instrumentRules";
import type { FundingRateEvent } from "../funding";
import type { PaperTrade, PaperPosition, PaperOrder } from "../../store";

/**
 * Cost models for a run. Required — pass `{}` to state explicitly that a run
 * carries no cost modelling. Making it optional is how the models silently
 * stopped reaching real runs once already: the venue supported them, the
 * runner never passed them, and every backtest quietly used flat spot fees
 * with no funding and no rejections.
 */
export interface BacktestCosts {
  fees?:            FeeSettings;
  slippageContext?: SlippageContextSettings;
  rejection?:       RejectionSettings;
  rules?:           InstrumentRules;
  funding?:         { events: FundingRateEvent[] };
}

export interface BacktestParams {
  symbol:         string;
  candles:        Candle[];
  bot:            BotConfig;
  initialBalance: number;
  feeRate:        number;
  slippageCfg:    SlippageSettings;
  costs:          BacktestCosts;
}

/** Names of the cost models a run actually applied, for the report. */
export function describeCosts(costs: BacktestCosts): string[] {
  const on: string[] = [];
  if (costs.fees)            on.push("maker/taker fees");
  if (costs.slippageContext) on.push("time-of-day slippage");
  if (costs.rejection)       on.push("order rejection");
  if (costs.rules)           on.push("instrument rules");
  if (costs.funding)         on.push("funding");
  return on;
}

export interface BacktestProgress {
  index:   number;      // current bar index
  total:   number;
  equity:  number;
  balance: number;
  trades:  number;
}

export interface BacktestResult {
  params:  BacktestParams;
  /** Cost models applied to this run — empty means none were configured. */
  costsApplied: string[];
  /** Funding paid (negative) or received over the run. */
  funding: number;
  /** Orders dropped before filling: rejection model or instrument rules. */
  rejected: number;
  stats:   BacktestStats;
  trades:  PaperTrade[];
  positions: PaperPosition[];   // any still open at the end
  orders:    PaperOrder[];      // includes cancelled / pending
  equity:    EquitySample[];
}

/**
 * Run the backtest. Calls `onProgress` between bars so callers can throttle UI
 * updates / decide pacing. `shouldStop` is checked between bars and lets the
 * caller cancel.
 */
export async function runBacktest(
  params: BacktestParams,
  hooks: {
    onProgress?: (p: BacktestProgress) => void;
    onBarComplete?: () => Promise<void> | void;   // yield point for visual pacing
    shouldStop?:  () => boolean;
  } = {},
): Promise<BacktestResult> {
  const factory = getBotFactory(params.bot.kind);
  if (!factory) throw new Error(`unknown bot kind: ${params.bot.kind}`);

  const clock = new BacktestClock(params.candles);
  const venue = new BacktestVenueImpl({
    symbol:        params.symbol,
    initialBalance: params.initialBalance,
    feeRate:        params.feeRate,
    slippageCfg:    params.slippageCfg,
    clock,
    ...params.costs,
  });

  const equity: EquitySample[] = [];

  // Build a bot context that proxies to this isolated venue. History is bounded
  // by the clock cursor, so the bot cannot read bars ahead of the current one.
  const bot: Bot = factory.create({ ...params.bot, symbol: params.symbol });
  const ctx: BotContext = {
    placeOrder: (req) => venue.placeOrder({ ...req, botId: params.bot.id }),
    cancelOrder: (id, reason) => venue.cancelOrder(id, reason),
    cancelAllOrders: () => venue.cancelOrdersByBot(params.bot.id),
    getPendingOrders: () => venue.getOpenOrders().filter((o) => o.botId === params.bot.id),
    getTicker: (s) => venue.getTicker(s),
    history: new CursorBarHistory(params.candles, () => clock.index),
    getPositions: () => venue.getOpenPositions(),
    getBalance: () => venue.getBalance(),
    getTrades: () => venue.getHistory(),
    now: () => (clock.current?.time ?? 0) * 1000,
  };

  venue.setListeners({
    onOrderFilled: (order, fillPrice) => {
      bot.onOrderFilled(ctx, order, fillPrice);
    },
  });
  venue.init();

  // Advance to bar 0 so the bot has a price when it starts.
  clock.step();
  bot.start(ctx);

  while (!clock.done) {
    if (hooks.shouldStop?.()) break;
    clock.step();   // matches pending orders against the new bar

    // The bar has closed and its orders are matched — only now may the strategy
    // react. Anything it places from here fills on a later bar.
    const bar = clock.current;
    if (bar) bot.onBar?.(ctx, bar, clock.index);

    const { available: balance, equity: equityVal } = venue.getBalance();
    if (bar) equity.push({ time: bar.time, equity: equityVal });

    hooks.onProgress?.({
      index:   clock.index,
      total:   clock.total,
      equity:  equityVal,
      balance,
      trades:  venue.getHistory().length,
    });

    if (hooks.onBarComplete) await hooks.onBarComplete();
  }

  bot.stop(ctx);
  venue.shutdown();

  const stats = computeStats(params.initialBalance, venue.getHistory(), equity);

  return {
    params,
    costsApplied: describeCosts(params.costs),
    funding:      venue.fundingTotal,
    rejected:     venue.rejectedCount,
    stats,
    trades:    venue.getHistory(),
    positions: venue.getOpenPositions(),
    orders:    venue.orders,
    equity,
  };
}
