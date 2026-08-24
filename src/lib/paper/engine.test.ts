import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../store";
import { paperEngine } from "./engine";

const SYM = "BTCUSDT";

function setTicker(price: number): void {
  useStore.getState().updateTicker({
    symbol: SYM,
    lastPrice: price,
    bid1: price,
    ask1: price,
    change24h: 0,
    high24h: price,
    low24h: price,
    volume24h: 0,
    updatedAt: 0,
  });
}

function reset(balance = 10000, feeRate = 0): void {
  const st = useStore.getState();
  st.setPaperBalance(balance);
  st.setPaperOrders([]);
  st.setPaperPositions([]);
  st.setPaperHistory([]);
  st.updateSettings({ paperTrading: { feeRate, slippage: { kind: "none" } } });
}

const balance = () => useStore.getState().paperBalance;
const positions = () => useStore.getState().paperPositions;
const history = () => useStore.getState().paperHistory;

function market(side: "buy" | "sell", qty: number, price: number): void {
  setTicker(price);
  paperEngine.placeOrder({ symbol: SYM, side, type: "market", price, qty });
}

describe("PaperTradingEngine", () => {
  beforeEach(() => reset());

  describe("realised P&L reaches the balance", () => {
    it("credits profit when a long is closed higher", () => {
      market("buy", 1, 100);
      market("sell", 1, 110);

      expect(balance()).toBeCloseTo(10010, 6);
      expect(positions()).toHaveLength(0);
    });

    it("debits loss when a long is closed lower", () => {
      market("buy", 1, 100);
      market("sell", 1, 90);

      expect(balance()).toBeCloseTo(9990, 6);
    });

    it("credits profit when a short is closed lower", () => {
      market("sell", 2, 100);
      market("buy", 2, 95);

      expect(balance()).toBeCloseTo(10010, 6);
    });

    it("nets to zero over a round trip at the same price", () => {
      market("buy", 3, 100);
      market("sell", 3, 100);

      expect(balance()).toBeCloseTo(10000, 6);
    });

    it("subtracts fees from realised profit", () => {
      reset(10000, 0.001);
      market("buy", 1, 100);      // fee 0.1 on open
      market("sell", 1, 110);     // fee 0.11 on close, gross pnl +10

      expect(balance()).toBeCloseTo(10000 - 0.1 + 10 - 0.11, 6);
    });
  });

  describe("positions", () => {
    it("opens a position and charges only the fee", () => {
      reset(10000, 0.001);
      market("buy", 2, 100);

      expect(positions()).toHaveLength(1);
      expect(positions()[0]).toMatchObject({ side: "buy", qty: 2, entryPrice: 100 });
      expect(balance()).toBeCloseTo(10000 - 0.2, 6);
    });

    it("averages the entry price when adding to a position", () => {
      market("buy", 1, 100);
      market("buy", 1, 120);

      expect(positions()).toHaveLength(1);
      expect(positions()[0].qty).toBe(2);
      expect(positions()[0].entryPrice).toBeCloseTo(110, 6);
    });

    it("keeps the remainder when closing only part of a position", () => {
      market("buy", 5, 100);
      market("sell", 2, 110);

      expect(positions()).toHaveLength(1);
      expect(positions()[0]).toMatchObject({ side: "buy", qty: 3, entryPrice: 100 });
      expect(balance()).toBeCloseTo(10020, 6);
    });

    it("reverses into the opposite side when the order exceeds the position", () => {
      market("buy", 1, 100);
      market("sell", 3, 110);

      expect(positions()).toHaveLength(1);
      expect(positions()[0]).toMatchObject({ side: "sell", qty: 2, entryPrice: 110 });
      expect(balance()).toBeCloseTo(10010, 6);
    });
  });

  describe("trade history", () => {
    it("records one closed trade with its realised pnl", () => {
      market("buy", 2, 100);
      market("sell", 2, 105);

      expect(history()).toHaveLength(1);
      expect(history()[0]).toMatchObject({
        symbol: SYM,
        side: "buy",
        entryPrice: 100,
        exitPrice: 105,
        qty: 2,
      });
      expect(history()[0].pnl).toBeCloseTo(10, 6);
    });

    it("records nothing while only opening positions", () => {
      market("buy", 1, 100);
      market("buy", 1, 101);

      expect(history()).toHaveLength(0);
    });
  });
});
