import { useStore } from "./store";
import { logInfo, logOk, logWarn } from "./eventBus";
import type { Category, SymbolMeta } from "./symbols";

const REST_BASE = "https://api.bybit.com";

interface BybitInstrument {
  symbol: string;
  status?: string;
  baseCoin: string;
  quoteCoin: string;
  priceFilter?: { tickSize?: string };
  lotSizeFilter?: { basePrecision?: string; qtyStep?: string };
}

interface BybitResp {
  retCode: number;
  retMsg: string;
  result?: { list?: BybitInstrument[] };
}

function precisionFromStep(step: string | undefined): number {
  if (!step) return 2;
  const n = parseFloat(step);
  if (!isFinite(n) || n <= 0) return 2;
  if (n >= 1) return 0;
  return Math.max(0, Math.min(10, -Math.floor(Math.log10(n))));
}

async function fetchCategory(category: Category): Promise<SymbolMeta[]> {
  const url = `${REST_BASE}/v5/market/instruments-info?category=${category}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as BybitResp;
  if (json.retCode !== 0 || !json.result?.list) {
    throw new Error(`retCode=${json.retCode} msg=${json.retMsg}`);
  }
  return json.result.list
    .filter((i) => (i.status ?? "Trading") === "Trading")
    .map<SymbolMeta>((i) => ({
      symbol: i.symbol,
      category,
      base: i.baseCoin,
      quote: i.quoteCoin,
      pricePrecision: precisionFromStep(i.priceFilter?.tickSize),
      qtyPrecision: precisionFromStep(
        i.lotSizeFilter?.basePrecision ?? i.lotSizeFilter?.qtyStep,
      ),
    }));
}

let loadingPromise: Promise<void> | null = null;

export function loadInstruments(): Promise<void> {
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    logInfo("instruments", "loading Bybit spot + linear lists…");
    try {
      const [spot, linear] = await Promise.all([
        fetchCategory("spot").catch((e: unknown) => {
          logWarn("instruments", `spot failed: ${e instanceof Error ? e.message : String(e)}`);
          return [];
        }),
        fetchCategory("linear").catch((e: unknown) => {
          logWarn("instruments", `linear failed: ${e instanceof Error ? e.message : String(e)}`);
          return [];
        }),
      ]);
      // Linear: keep only USDT-quoted perpetuals to limit noise (BTCUSDT, ETHUSDT…). Filter out crypto-quoted (BTCUSDC, BTCEUR etc).
      const linearFiltered = linear.filter((s) => s.quote === "USDT");
      const all = [...spot, ...linearFiltered];
      useStore.getState().setAllSymbols(all);
      logOk("instruments", `loaded ${spot.length} spot + ${linearFiltered.length} linear`);
    } catch (err) {
      logWarn("instruments", `load failed entirely: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
  return loadingPromise;
}
