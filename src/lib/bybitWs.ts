import { useStore } from "./store";
import { logOk, logWarn, logError, logInfo } from "./eventBus";
import type { Category } from "./symbols";

const PING_INTERVAL = 20_000;
const RECONNECT_DELAY = 3_000;

const URL_BY_CATEGORY: Record<Category, string> = {
  spot:   "wss://stream.bybit.com/v5/public/spot",
  linear: "wss://stream.bybit.com/v5/public/linear",
};

class BybitWsConn {
  private url: string;
  private label: string;
  private ws: WebSocket | null = null;
  private subs = new Set<string>();
  private pingTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private lastPingTs = 0;
  private explicitlyClosed = false;

  constructor(category: Category) {
    this.url = URL_BY_CATEGORY[category];
    this.label = `bybit-ws.${category}`;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }
    this.explicitlyClosed = false;
    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      logError(this.label, `connect failed: ${String(err)}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      logOk(this.label, "connected");
      useStore.getState().setConnected(true);
      if (this.subs.size > 0) {
        const all = [...this.subs];
        for (let i = 0; i < all.length; i += 10) {
          this.sendRaw({ op: "subscribe", args: all.slice(i, i + 10) });
        }
      }
      this.pingTimer = window.setInterval(() => {
        this.lastPingTs = performance.now();
        this.sendRaw({ op: "ping" });
      }, PING_INTERVAL);
    };

    this.ws.onclose = () => {
      this.stopPing();
      if (!this.explicitlyClosed) {
        logWarn(this.label, `disconnected, retry in ${RECONNECT_DELAY}ms`);
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      logError(this.label, "websocket error");
    };

    this.ws.onmessage = (e) => {
      let msg: unknown;
      try { msg = JSON.parse(e.data); } catch (err) {
        logError(this.label, `parse error: ${String(err)}`); return;
      }
      this.handleMessage(msg);
    };
  }

  disconnect(): void {
    this.explicitlyClosed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    this.ws?.close();
    this.ws = null;
  }

  subscribe(topic: string): void {
    if (this.subs.has(topic)) return;
    this.subs.add(topic);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendRaw({ op: "subscribe", args: [topic] });
    }
  }

  subscribeMany(topics: string[]): void {
    const fresh: string[] = [];
    for (const t of topics) {
      if (!this.subs.has(t)) {
        this.subs.add(t);
        fresh.push(t);
      }
    }
    if (fresh.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      for (let i = 0; i < fresh.length; i += 10) {
        this.sendRaw({ op: "subscribe", args: fresh.slice(i, i + 10) });
      }
    }
  }

  unsubscribe(topic: string): void {
    if (!this.subs.has(topic)) return;
    this.subs.delete(topic);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendRaw({ op: "unsubscribe", args: [topic] });
    }
  }

  private sendRaw(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY);
  }

  private handleMessage(msg: unknown): void {
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;

    if (m.op === "pong" || m.ret_msg === "pong") {
      const dt = Math.round(performance.now() - this.lastPingTs);
      useStore.getState().setLatency(dt);
      return;
    }
    if (m.success !== undefined && (m.op === "subscribe" || m.op === "unsubscribe")) {
      if (m.success === false) logWarn(this.label, `subscribe failed: ${String(m.ret_msg)}`);
      return;
    }
    if (typeof m.topic === "string") {
      dispatchTopic(m.topic, m.data, (m.ts as number) ?? Date.now(), (m.type as string) ?? "snapshot");
    }
  }
}

function dispatchTopic(topic: string, data: unknown, ts: number, type: string): void {
  const store = useStore.getState();

  if (topic.startsWith("tickers.")) {
    const t = data as Record<string, string>;
    if (!t || !t.symbol) return;
    const prev = store.tickers[t.symbol];
    store.updateTicker({
      symbol: t.symbol,
      lastPrice: parseFloat(t.lastPrice ?? "") || prev?.lastPrice || 0,
      bid1:      parseFloat(t.bid1Price ?? "") || prev?.bid1      || 0,
      ask1:      parseFloat(t.ask1Price ?? "") || prev?.ask1      || 0,
      change24h: (t.price24hPcnt !== undefined ? parseFloat(t.price24hPcnt) * 100 : prev?.change24h) ?? 0,
      high24h:   parseFloat(t.highPrice24h ?? "") || prev?.high24h || 0,
      low24h:    parseFloat(t.lowPrice24h ?? "")  || prev?.low24h  || 0,
      volume24h: parseFloat(t.volume24h ?? "")    || prev?.volume24h || 0,
      updatedAt: ts,
    });
    return;
  }

  if (topic.startsWith("kline.")) {
    const parts = topic.split(".");
    const interval = parts[1];
    const symbol = parts[2];
    const key = `${symbol}.${interval}`;
    const arr = Array.isArray(data) ? data : [];
    for (const k of arr) {
      store.updateLastCandle(key, {
        time: Math.floor(parseInt(k.start, 10) / 1000),
        open: parseFloat(k.open),
        high: parseFloat(k.high),
        low: parseFloat(k.low),
        close: parseFloat(k.close),
        volume: parseFloat(k.volume),
      });
    }
    return;
  }

  if (topic.startsWith("orderbook.")) {
    const parts = topic.split(".");
    const symbol = parts[2];
    const d = data as { a: [string, string][]; b: [string, string][]; s: string };
    if (!d) return;
    if (type === "snapshot") {
      const asks = (d.a || []).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }))
        .filter((l) => l.qty > 0).sort((a, b) => a.price - b.price);
      const bids = (d.b || []).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }))
        .filter((l) => l.qty > 0).sort((a, b) => b.price - a.price);
      store.setOrderbook({ symbol, asks, bids, updatedAt: ts });
    } else {
      store.applyOrderbookDelta(symbol, d.a || [], d.b || [], ts);
    }
    return;
  }
}

class BybitWsManager {
  private spot = new BybitWsConn("spot");
  private linear = new BybitWsConn("linear");

  connect(): void {
    this.spot.connect();
    this.linear.connect();
    useStore.getState().setConnected(true);
  }

  disconnect(): void {
    this.spot.disconnect();
    this.linear.disconnect();
  }

  subscribe(topic: string, symbolOrCategory: string): void {
    (this.resolveCat(symbolOrCategory) === "linear" ? this.linear : this.spot).subscribe(topic);
  }

  unsubscribe(topic: string, symbolOrCategory: string): void {
    (this.resolveCat(symbolOrCategory) === "linear" ? this.linear : this.spot).unsubscribe(topic);
  }

  subscribeMany(topics: string[], symbolOrCategory: string): void {
    (this.resolveCat(symbolOrCategory) === "linear" ? this.linear : this.spot).subscribeMany(topics);
  }

  private resolveCat(symOrCat: string): Category {
    if (symOrCat === "spot" || symOrCat === "linear") return symOrCat;
    const meta = useStore.getState().allSymbols.find((s) => s.symbol === symOrCat);
    return meta?.category ?? "spot";
  }
}

export const ws = new BybitWsManager();

export function init(): void {
  logInfo("bybit-ws", "initialising spot + linear");
  ws.connect();
}
