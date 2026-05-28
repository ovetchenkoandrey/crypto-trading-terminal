export type Category = "spot" | "linear";

export interface SymbolMeta {
  symbol: string;
  category: Category;
  base: string;
  quote: string;
  pricePrecision: number;
  qtyPrecision: number;
}

export const DEFAULT_SYMBOLS: SymbolMeta[] = [
  { symbol: "BTCUSDT",   category: "spot", base: "BTC",   quote: "USDT", pricePrecision: 2, qtyPrecision: 6 },
  { symbol: "ETHUSDT",   category: "spot", base: "ETH",   quote: "USDT", pricePrecision: 2, qtyPrecision: 5 },
  { symbol: "SOLUSDT",   category: "spot", base: "SOL",   quote: "USDT", pricePrecision: 3, qtyPrecision: 2 },
  { symbol: "BNBUSDT",   category: "spot", base: "BNB",   quote: "USDT", pricePrecision: 2, qtyPrecision: 3 },
  { symbol: "XRPUSDT",   category: "spot", base: "XRP",   quote: "USDT", pricePrecision: 4, qtyPrecision: 1 },
  { symbol: "DOGEUSDT",  category: "spot", base: "DOGE",  quote: "USDT", pricePrecision: 5, qtyPrecision: 0 },
  { symbol: "ADAUSDT",   category: "spot", base: "ADA",   quote: "USDT", pricePrecision: 4, qtyPrecision: 1 },
  { symbol: "AVAXUSDT",  category: "spot", base: "AVAX",  quote: "USDT", pricePrecision: 3, qtyPrecision: 2 },
  { symbol: "DOTUSDT",   category: "spot", base: "DOT",   quote: "USDT", pricePrecision: 3, qtyPrecision: 2 },
  { symbol: "LINKUSDT",  category: "spot", base: "LINK",  quote: "USDT", pricePrecision: 3, qtyPrecision: 2 },
  { symbol: "MATICUSDT", category: "spot", base: "MATIC", quote: "USDT", pricePrecision: 4, qtyPrecision: 1 },
  { symbol: "ATOMUSDT",  category: "spot", base: "ATOM",  quote: "USDT", pricePrecision: 3, qtyPrecision: 2 },
];

const DEFAULT_META_BY_SYMBOL = new Map(DEFAULT_SYMBOLS.map((s) => [s.symbol, s]));

export function getSymbolMeta(symbol: string): SymbolMeta | undefined {
  return DEFAULT_META_BY_SYMBOL.get(symbol);
}

// For UI use — components that need accurate precision for arbitrary symbols
// should query store.allSymbols. This static fallback handles common pairs + heuristic.
export function getPricePrecision(symbol: string, fallbackPrice?: number): number {
  const meta = DEFAULT_META_BY_SYMBOL.get(symbol);
  if (meta) return meta.pricePrecision;
  if (fallbackPrice !== undefined) {
    if (fallbackPrice >= 1000) return 2;
    if (fallbackPrice >= 1) return 4;
    if (fallbackPrice >= 0.01) return 5;
    return 6;
  }
  return 2;
}

export const TIMEFRAMES: { value: string; label: string; ms: number }[] = [
  { value: "1",   label: "M1",  ms: 60_000 },
  { value: "5",   label: "M5",  ms: 5 * 60_000 },
  { value: "15",  label: "M15", ms: 15 * 60_000 },
  { value: "60",  label: "H1",  ms: 60 * 60_000 },
  { value: "240", label: "H4",  ms: 4 * 60 * 60_000 },
  { value: "D",   label: "D1",  ms: 24 * 60 * 60_000 },
  { value: "W",   label: "W1",  ms: 7 * 24 * 60 * 60_000 },
];

export function tfLabel(value: string): string {
  return TIMEFRAMES.find((t) => t.value === value)?.label ?? value;
}
