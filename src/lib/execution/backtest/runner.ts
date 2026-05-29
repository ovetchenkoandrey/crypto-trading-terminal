// Glues a bot to a BacktestVenue + clock. Steps the clock bar-by-bar, lets the
// bot react to fills via its standard onOrderFilled hook, samples equity every
// bar, and returns a Promise<BacktestResult> on completion.

import type { Candle } from "../../types";
import type { BotConfig } from "../../store";
import type { Bot, BotContext } from "../../bots/base";
import { getBotFactory } from "../../bots/registry";
import { BacktestClock } from "./clock";
import { BacktestVenueImpl } from "./BacktestVenue";
import { computeStats, type BacktestStats, type EquitySample } from "./stats";
import type { SlippageSettings } from "../../settings";
import type { PaperTrade, PaperPosition, PaperOrder } from "../../store";

export interface BacktestParams {
  symbol:         string;
  candles:        Candle[];
  bot:            BotConfig;
  initialBalance: number;
  feeRate:        number;
  slippageCfg:    SlippageSettings;
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
  });

  const equity: EquitySample[] = [];

  // Build a bot context that proxies to this isolated venue.
  const bot: Bot = factory.create({ ...params.bot, symbol: params.symbol });
  const ctx: BotContext = {
    placeOrder: (req) => venue.placeOrder({ ...req, botId: params.bot.id }),
    cancelOrder: (id, reason) => venue.cancelOrder(id, reason),
    cancelAllOrders: () => venue.cancelOrdersByBot(params.bot.id),
    getPendingOrders: () => venue.getOpenOrders().filter((o) => o.botId === params.bot.id),
    getTicker: (s) => venue.getTicker(s),
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
    clock.step();

    const balance = venue.getBalance().available;
    const equityVal = venue.getBalance().equity;
    const bar = clock.current;
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
    stats,
    trades:    venue.getHistory(),
    positions: venue.getOpenPositions(),
    orders:    venue.orders,
    equity,
  };
}
