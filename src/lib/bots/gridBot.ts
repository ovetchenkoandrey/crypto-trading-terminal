import type { BotConfig, PaperOrder } from "../store";
import type { Bot, BotContext, BotFactory } from "./base";
import { logInfo, logWarn } from "../eventBus";

interface GridParams {
  lowPrice: number;
  highPrice: number;
  levels: number;
  qtyPerLevel: number;
}

function parseParams(p: Record<string, number | string>): GridParams {
  return {
    lowPrice:    Number(p.lowPrice),
    highPrice:   Number(p.highPrice),
    levels:      Math.max(2, Math.min(50, Math.floor(Number(p.levels) || 10))),
    qtyPerLevel: Number(p.qtyPerLevel),
  };
}

class GridBot implements Bot {
  config: BotConfig;

  constructor(config: BotConfig) {
    this.config = config;
  }

  start(ctx: BotContext): void {
    const p = parseParams(this.config.params);
    if (!(p.highPrice > p.lowPrice && p.levels >= 2 && p.qtyPerLevel > 0)) {
      logWarn(`bot:${this.config.id}`, "invalid grid params");
      return;
    }
    const ticker = ctx.getTicker(this.config.symbol);
    if (!ticker) {
      logWarn(`bot:${this.config.id}`, `no ticker for ${this.config.symbol} yet — skipping initial grid (will retry on next tick)`);
      return;
    }
    const mid = ticker.lastPrice;
    const step = (p.highPrice - p.lowPrice) / (p.levels - 1);
    let placed = 0;
    for (let i = 0; i < p.levels; i++) {
      const price = p.lowPrice + step * i;
      if (price < mid) {
        ctx.placeOrder({ symbol: this.config.symbol, side: "buy",  type: "limit", price, qty: p.qtyPerLevel });
        placed++;
      } else if (price > mid) {
        ctx.placeOrder({ symbol: this.config.symbol, side: "sell", type: "limit", price, qty: p.qtyPerLevel });
        placed++;
      }
      // exactly at mid → skip
    }
    logInfo(`bot:${this.config.id}`, `grid placed ${placed} orders around mid ${mid.toFixed(2)} (step ${step.toFixed(2)})`);
  }

  stop(ctx: BotContext): void {
    const count = ctx.cancelAllOrders();
    logInfo(`bot:${this.config.id}`, `stopped, cancelled ${count} orders`);
  }

  onOrderFilled(ctx: BotContext, order: PaperOrder, fillPrice: number): void {
    const p = parseParams(this.config.params);
    const step = (p.highPrice - p.lowPrice) / (p.levels - 1);
    // Mirror order on opposite side one step away
    if (order.side === "buy") {
      const sellPrice = fillPrice + step;
      if (sellPrice <= p.highPrice + 1e-9) {
        ctx.placeOrder({ symbol: order.symbol, side: "sell", type: "limit", price: sellPrice, qty: order.qty });
      }
    } else {
      const buyPrice = fillPrice - step;
      if (buyPrice >= p.lowPrice - 1e-9) {
        ctx.placeOrder({ symbol: order.symbol, side: "buy", type: "limit", price: buyPrice, qty: order.qty });
      }
    }
  }
}

export const gridBotFactory: BotFactory = {
  kind: "grid",
  name: "Grid Bot",
  defaultParams: {
    lowPrice: 60000,
    highPrice: 80000,
    levels: 10,
    qtyPerLevel: 0.001,
  },
  paramSpec: [
    { key: "lowPrice",    label: "Нижняя цена",    type: "number", min: 0 },
    { key: "highPrice",   label: "Верхняя цена",   type: "number", min: 0 },
    { key: "levels",      label: "Уровней сетки",  type: "number", min: 2, max: 50, step: 1 },
    { key: "qtyPerLevel", label: "Объём на уровень", type: "number", min: 0, step: 0.0001 },
  ],
  create(config) {
    return new GridBot(config);
  },
};
