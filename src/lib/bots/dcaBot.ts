import type { BotConfig, PaperOrder } from "../store";
import type { Bot, BotContext, BotFactory } from "./base";
import { logInfo, logWarn } from "../eventBus";

interface DcaParams {
  intervalMin: number;
  amountUsdt:  number;
  side:        "buy" | "sell";
}

function parse(p: Record<string, number | string>): DcaParams {
  return {
    intervalMin: Math.max(0.1, Number(p.intervalMin) || 60),
    amountUsdt:  Math.max(0.1, Number(p.amountUsdt)  || 10),
    side:        (p.side === "sell" ? "sell" : "buy"),
  };
}

class DcaBot implements Bot {
  config: BotConfig;
  private timer: number | null = null;

  constructor(config: BotConfig) {
    this.config = config;
  }

  start(ctx: BotContext): void {
    const p = parse(this.config.params);
    const intervalMs = p.intervalMin * 60_000;
    logInfo(`bot:${this.config.id}`, `DCA started — ${p.side} ${p.amountUsdt} USDT каждые ${p.intervalMin} мин`);

    const placeOne = () => {
      const ticker = ctx.getTicker(this.config.symbol);
      if (!ticker || ticker.lastPrice <= 0) {
        logWarn(`bot:${this.config.id}`, `нет цены для ${this.config.symbol}, пропуск тика`);
        return;
      }
      const qty = +(p.amountUsdt / ticker.lastPrice).toFixed(8);
      if (qty <= 0) return;
      ctx.placeOrder({ symbol: this.config.symbol, side: p.side, type: "market", price: ticker.lastPrice, qty });
    };

    // First order immediately, then on interval
    placeOne();
    this.timer = window.setInterval(placeOne, intervalMs);
  }

  stop(_ctx: BotContext): void {
    void _ctx;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    logInfo(`bot:${this.config.id}`, "DCA stopped");
  }

  onOrderFilled(_ctx: BotContext, _order: PaperOrder, _fillPrice: number): void {
    // DCA doesn't react to fills — just keeps buying on schedule
    void _ctx; void _order; void _fillPrice;
  }
}

export const dcaBotFactory: BotFactory = {
  kind: "dca",
  name: "DCA Strategy",
  defaultParams: {
    intervalMin: 60,
    amountUsdt:  10,
    side:        "buy",
  },
  paramSpec: [
    { key: "intervalMin", label: "Интервал (мин)",    type: "number", min: 0.1, step: 1 },
    { key: "amountUsdt",  label: "Сумма за ордер (USDT)", type: "number", min: 0.01, step: 1 },
    { key: "side",        label: "Сторона (buy/sell)", type: "string" },
  ],
  create(config) {
    return new DcaBot(config);
  },
};
