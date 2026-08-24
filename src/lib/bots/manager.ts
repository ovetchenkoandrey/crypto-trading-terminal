import { useStore } from "../store";
import type { BotConfig } from "../store";
import { venue } from "../execution/router";
import type { VenueOrder } from "../execution/types";
import { getBotFactory } from "./registry";
import type { Bot, BotContext } from "./base";
import { CursorBarHistory } from "./history";
import { logOk, logWarn, bus, emitBot } from "../eventBus";

class BotManager {
  private instances = new Map<string, Bot>();
  private busListenerInstalled = false;

  init(): void {
    if (this.busListenerInstalled) return;
    bus.on("bot", (ev) => {
      if (ev.type === "order_filled" && ev.botId) {
        const bot = this.instances.get(ev.botId);
        if (!bot) return;
        // Look up the actual filled order through the active venue. Each venue is responsible
        // for emitting "order_filled" with an orderId that resolves via getOpenOrders/getHistory
        // — but easier: we keep paper's behaviour of finding it in store paperOrders for now.
        // TODO: when demo/live land, route this through venue.findOrder(id).
        const order = useStore.getState().paperOrders.find((o) => o.id === (ev.data.orderId as string));
        if (!order || order.status !== "filled" || order.filledPrice === undefined) return;
        bot.onOrderFilled(this.contextFor(ev.botId), order, order.filledPrice);
      }
    });
    this.busListenerInstalled = true;
  }

  start(botId: string): boolean {
    const cfg = useStore.getState().botConfigs.find((b) => b.id === botId);
    if (!cfg) return false;
    if (this.instances.has(botId)) return false;
    const factory = getBotFactory(cfg.kind);
    if (!factory) {
      logWarn(`bot:${botId}`, `unknown kind ${cfg.kind}`);
      return false;
    }
    const bot = factory.create(cfg);
    this.instances.set(botId, bot);
    useStore.getState().upsertBot({ ...cfg, status: "running" });
    emitBot({ ts: Date.now(), botId, type: "started", data: { kind: cfg.kind, symbol: cfg.symbol } });
    try {
      bot.start(this.contextFor(botId));
      logOk(`bot:${botId}`, "started");
    } catch (err) {
      logWarn(`bot:${botId}`, `start failed: ${String(err)}`);
      this.stop(botId);
      return false;
    }
    return true;
  }

  stop(botId: string): boolean {
    const bot = this.instances.get(botId);
    if (!bot) return false;
    try { bot.stop(this.contextFor(botId)); } catch (err) {
      logWarn(`bot:${botId}`, `stop error: ${String(err)}`);
    }
    this.instances.delete(botId);
    const cfg = useStore.getState().botConfigs.find((b) => b.id === botId);
    if (cfg) useStore.getState().upsertBot({ ...cfg, status: "stopped" });
    emitBot({ ts: Date.now(), botId, type: "stopped", data: {} });
    return true;
  }

  isRunning(botId: string): boolean {
    return this.instances.has(botId);
  }

  private contextFor(botId: string): BotContext {
    const cfg = useStore.getState().botConfigs.find((b) => b.id === botId);
    const symbol = cfg?.symbol ?? "";
    return {
      placeOrder: (req) => venue.placeOrder({ ...req, botId }),
      cancelOrder: (id, reason) => venue.cancelOrder(id, reason ?? `bot:${botId}`),
      cancelAllOrders: () => venue.cancelOrdersByBot(botId),
      getPendingOrders: (): VenueOrder[] => venue.getOpenOrders().filter((o) => o.botId === botId),
      getTicker: (symbol) => venue.getTicker(symbol),
      // Live bars come from the store, keyed by the timeframe the chart is on.
      // No cursor: everything already stored is in the past.
      history: new CursorBarHistory(() => {
        const st = useStore.getState();
        return st.candles[`${symbol}.${st.timeframe}`] ?? [];
      }),
      getPositions: () => venue.getOpenPositions().filter((p) => p.botId === botId),
      getBalance: () => venue.getBalance(),
      getTrades: () => venue.getHistory().filter((t) => t.botId === botId),
      now: () => Date.now(),
    };
  }
}

export const botManager = new BotManager();
