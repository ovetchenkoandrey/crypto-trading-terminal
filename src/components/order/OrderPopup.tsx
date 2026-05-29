// Floating, anchored order entry popup.
// Single instance app-wide. Open/close via store (useStore.openOrderPopup / closeOrderPopup).
// Submits through the active venue, so the same UI works for paper / demo / live / backtest.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../../lib/store";
import type { Side, OrderType } from "../../lib/store";
import { venue } from "../../lib/execution/router";
import { applySlippage } from "../../lib/execution/slippage";
import { fmtPrice, fmtUsdt } from "../../lib/format";
import { getPricePrecision } from "../../lib/symbols";
import { logWarn } from "../../lib/eventBus";

const POPUP_WIDTH      = 240;
const POPUP_MARGIN     = 8;
const AUTO_CLOSE_MS    = 30_000;

type QtyCcy = "base" | "quote";   // base = BTC, quote = USDT

export function OrderPopup() {
  const popup        = useStore((s) => s.orderPopup);
  const close        = useStore((s) => s.closeOrderPopup);
  const setLastQty   = useStore((s) => s.setLastUsedQty);
  const tickers      = useStore((s) => s.tickers);
  const paperBalance = useStore((s) => s.paperBalance);
  const settings     = useStore((s) => s.settings);

  // Local form state — reset on every (re)open. Keying the component handles that.
  if (!popup.open) return null;
  return <PopupBody key={popup.defaults.symbol + ":" + (popup.anchor?.x ?? "c") + ":" + (popup.anchor?.y ?? "c")}
                    popup={popup}
                    close={close}
                    setLastQty={setLastQty}
                    tickers={tickers}
                    paperBalance={paperBalance}
                    feeRate={settings.paperTrading.feeRate}
                    slippageCfg={settings.paperTrading.slippage} />;
}

interface BodyProps {
  popup: ReturnType<typeof useStore.getState>["orderPopup"];
  close: () => void;
  setLastQty: (qty: number) => void;
  tickers: ReturnType<typeof useStore.getState>["tickers"];
  paperBalance: number;
  feeRate: number;
  slippageCfg: ReturnType<typeof useStore.getState>["settings"]["paperTrading"]["slippage"];
}

function PopupBody({ popup, close, setLastQty, tickers, paperBalance, feeRate, slippageCfg }: BodyProps) {
  const { symbol, side: defaultSide, type: defaultType, price: defaultPrice, qty: defaultQty,
          advanced: defaultAdvanced, focusQty } = popup.defaults;

  const [side,       setSide]      = useState<Side | undefined>(defaultSide);
  const [type,       setType]      = useState<OrderType>(defaultType);
  const [price,      setPrice]     = useState<string>(defaultPrice !== undefined ? String(defaultPrice) : "");
  const [stopPrice,  setStopPrice] = useState<string>("");
  const [qty,        setQty]       = useState<string>(defaultQty !== undefined ? String(defaultQty) : "");
  const [ccy,        setCcy]       = useState<QtyCcy>("base");
  const [tp,         setTp]        = useState<string>("");
  const [sl,         setSl]        = useState<string>("");
  const [advanced,   setAdvanced]  = useState<boolean>(!!defaultAdvanced);

  const ticker = tickers[symbol];
  const lastPrice  = ticker?.lastPrice ?? defaultPrice ?? 0;
  const precision  = getPricePrecision(symbol, lastPrice);

  const ref      = useRef<HTMLDivElement>(null);
  const qtyRef   = useRef<HTMLInputElement>(null);

  // ─── parse numeric inputs ──────────────────────────────────────────
  const qtyNum   = useMemo(() => parseFloat(qty.replace(/,/g, "")) || 0, [qty]);
  const priceNum = useMemo(() => parseFloat(price.replace(/,/g, "")) || 0, [price]);
  // qty entered as quote → convert to base for placement
  const qtyBase = ccy === "base" ? qtyNum : (lastPrice > 0 ? qtyNum / lastPrice : 0);
  const refPrice = type === "market" ? lastPrice : priceNum;

  // estimated total & fees (informational, not authoritative)
  const grossUsdt = qtyBase * (refPrice || lastPrice);
  const feeUsdt   = grossUsdt * feeRate;
  const expectedFill = applySlippage(refPrice || lastPrice, side ?? "buy", qtyBase, ticker, slippageCfg);
  const slipUsdt  = Math.abs(expectedFill - (refPrice || lastPrice)) * qtyBase;

  // ─── position & anchor on screen ───────────────────────────────────
  const [pos, setPos] = useState<{ left: number; top: number; arrowTop: number | null }>({
    left: -9999, top: -9999, arrowTop: null,
  });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ww = window.innerWidth;
    const wh = window.innerHeight;
    const rect = el.getBoundingClientRect();
    const h = rect.height;
    let left: number;
    let top: number;
    let arrowTop: number | null = null;
    if (popup.anchor) {
      // anchored: place to the right of the anchor; if not enough room — to the left
      left = popup.anchor.x + 14;
      if (left + POPUP_WIDTH + POPUP_MARGIN > ww) {
        left = popup.anchor.x - POPUP_WIDTH - 14;
      }
      // Try to keep arrow tip near anchor.y. Shift popup vertically to fit.
      top = popup.anchor.y - 18;
      if (top + h + POPUP_MARGIN > wh) top = wh - h - POPUP_MARGIN;
      if (top < POPUP_MARGIN) top = POPUP_MARGIN;
      arrowTop = Math.max(8, Math.min(h - 16, popup.anchor.y - top));
    } else {
      // centred
      left = Math.max(POPUP_MARGIN, (ww - POPUP_WIDTH) / 2);
      top  = Math.max(POPUP_MARGIN, (wh - h) / 2);
    }
    setPos({ left, top, arrowTop });
  }, [popup.anchor, advanced]);

  // ─── focus + autoclose timer ────────────────────────────────────────
  useEffect(() => {
    if (focusQty && qtyRef.current) {
      qtyRef.current.focus();
      qtyRef.current.select();
    }
  }, [focusQty]);

  useEffect(() => {
    let timer: number | null = null;
    const reset = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(close, AUTO_CLOSE_MS);
    };
    const el = ref.current;
    el?.addEventListener("mousemove", reset);
    el?.addEventListener("keydown", reset);
    reset();
    return () => {
      el?.removeEventListener("mousemove", reset);
      el?.removeEventListener("keydown", reset);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [close]);

  // ─── Esc + outside click ────────────────────────────────────────────
  // Use closest('[data-order-popup]') instead of ref.contains — more robust
  // when the root element is repositioned by useLayoutEffect between mount and
  // first paint. Defer the listener attach to the next animation frame so the
  // very click that opened the popup doesn't immediately close it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest('[data-order-popup]')) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    const raf = window.requestAnimationFrame(() => {
      window.addEventListener("mousedown", onDown);
    });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
      window.cancelAnimationFrame(raf);
    };
  }, [close]);

  // ─── submit ─────────────────────────────────────────────────────────
  const canSubmit = side !== undefined
    && qtyBase > 0
    && (type === "market" || priceNum > 0)
    && (type !== "stop"   || priceNum > 0);

  function submit() {
    if (!canSubmit || side === undefined) return;
    try {
      venue.placeOrder({
        symbol,
        side,
        type,
        price: type === "market" ? (lastPrice || refPrice) : priceNum,
        qty:   qtyBase,
      });
      setLastQty(qtyBase);
      close();
    } catch (err) {
      logWarn("order", `не удалось разместить: ${String(err)}`);
    }
  }

  // Submit on Enter when the form is valid
  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" && canSubmit) { e.preventDefault(); submit(); }
  }

  // Quick % buttons compute qty for a target USDT fraction of free balance.
  function applyPct(pct: number) {
    const targetUsdt = paperBalance * pct;
    if (lastPrice <= 0) return;
    if (ccy === "base") {
      const q = targetUsdt / lastPrice;
      setQty(q.toFixed(8).replace(/\.?0+$/, ""));
    } else {
      setQty(targetUsdt.toFixed(2));
    }
  }

  const submitColor = side === "sell" ? "var(--red)" : "var(--green)";
  const sideLabel   = side ? (side === "buy" ? "Buy" : "Sell") : "";

  return (
    <div
      ref={ref}
      className={"order-popup" + (popup.anchor ? " anchored" : " centered")}
      style={{ left: pos.left, top: pos.top, width: POPUP_WIDTH }}
      onKeyDown={onKey}
      data-order-popup
      data-testid="order-popup"
    >
      {popup.anchor && pos.arrowTop !== null && (
        <div className="order-popup-arrow" style={{ top: pos.arrowTop }} />
      )}
      <div className="op-head">
        <div className="op-sym">{symbol} <span className="dim">· {venue.mode}</span></div>
        <div className="op-px">{ticker ? fmtPrice(lastPrice, precision) : "—"}</div>
        <div className="op-close" onClick={close} title="Esc">✕</div>
      </div>

      <div className="op-body">
        <div className="op-side-strip">
          <button data-testid="op-side-buy"
                  className={"buy" + (side === "buy" ? " active" : "")}
                  onClick={() => setSide("buy")}>Buy</button>
          <button data-testid="op-side-sell"
                  className={"sell" + (side === "sell" ? " active" : "")}
                  onClick={() => setSide("sell")}>Sell</button>
        </div>

        <div className="op-type-seg" data-testid="op-type">
          {(["market", "limit", "stop"] as OrderType[]).map((t) => (
            <button key={t} className={type === t ? "active" : ""} onClick={() => setType(t)}>
              {t === "market" ? "Market" : t === "limit" ? "Limit" : "Stop"}
            </button>
          ))}
        </div>

        {type !== "market" && (
          <div className="op-field">
            <div className="op-row-label"><span>Цена</span></div>
            <input data-testid="op-price"
                   value={price}
                   onChange={(e) => setPrice(e.target.value)}
                   placeholder={fmtPrice(lastPrice, precision)} />
          </div>
        )}

        <div className="op-field">
          <div className="op-row-label">
            <span>Объём</span>
            <span className="ccy"
                  onClick={() => setCcy(ccy === "base" ? "quote" : "base")}
                  title="Переключить между BTC и USDT">
              {ccy === "base" ? quoteToBaseLabel(symbol) : "USDT"} ▾
            </span>
          </div>
          <input data-testid="op-qty"
                 ref={qtyRef}
                 className={focusQty ? "qty-active" : ""}
                 value={qty}
                 onChange={(e) => setQty(e.target.value)}
                 placeholder={ccy === "base" ? "0.00" : "0.00"} />
          <div className="op-qty-quick">
            {[0.25, 0.5, 0.75, 1].map((p) => (
              <button key={p} onClick={() => applyPct(p)}>{Math.round(p * 100)}%</button>
            ))}
          </div>
        </div>

        {advanced && (
          <div className="op-advanced">
            <div className="op-field">
              <div className="op-row-label"><span>Take Profit</span></div>
              <input value={tp} onChange={(e) => setTp(e.target.value)} placeholder="—" />
            </div>
            <div className="op-field">
              <div className="op-row-label"><span>Stop Loss</span></div>
              <input value={sl} onChange={(e) => setSl(e.target.value)} placeholder="—" />
            </div>
            <div className="op-tp-sl-note">
              TP / SL появятся как отдельные ордера после исполнения основного.
              <br/><span className="dim">Скоро: на этом этапе только основной ордер.</span>
            </div>
          </div>
        )}

        <div className="op-est">
          Сумма: <b>{grossUsdt > 0 ? fmtUsdt(grossUsdt) : "—"} USDT</b><br/>
          Комиссия: <b>{feeUsdt > 0 ? fmtUsdt(feeUsdt) : "—"}</b>
          {type !== "limit" && slipUsdt > 0 && <> · Slip: <b>{fmtUsdt(slipUsdt)}</b></>}
          <br/>
          Свободно: <b>{fmtUsdt(paperBalance)} USDT</b>
        </div>

        <button data-testid="op-submit"
                className="op-submit"
                disabled={!canSubmit}
                style={{ background: canSubmit ? submitColor : "var(--bg-input)",
                         color: canSubmit ? "#fff" : "var(--fg-mute)",
                         cursor: canSubmit ? "pointer" : "not-allowed" }}
                onClick={submit}>
          {side
            ? `${sideLabel} ${qtyBase > 0 ? qtyBase.toString() : ""} ${quoteToBaseLabel(symbol)}`.trim()
            : "Выберите Buy / Sell"}
        </button>

        <button className="op-advanced-toggle" onClick={() => setAdvanced(!advanced)}>
          <span className="chev">{advanced ? "▴" : "▾"}</span>{advanced ? "Свернуть" : "Расширенно"}
        </button>
      </div>

      <div className="op-foot">
        <kbd>Enter</kbd> отправить · <kbd>Esc</kbd> отмена
      </div>
    </div>
  );
}

// Spot symbols on Bybit are <base><USDT>. For derivatives (PERP) the suffix is also USDT
// for linear contracts. Strip the USDT to get the base label for the qty toggle.
function quoteToBaseLabel(symbol: string): string {
  if (symbol.endsWith("USDT")) return symbol.slice(0, -4);
  if (symbol.endsWith("USDC")) return symbol.slice(0, -4);
  if (symbol.endsWith("USD"))  return symbol.slice(0, -3);
  return symbol;
}
