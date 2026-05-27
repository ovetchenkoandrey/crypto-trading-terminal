export interface SymbolMeta {
  symbol: string;
  base: string;
  quote: string;
  pricePrecision: number;
  qtyPrecision: number;
}

export const DEFAULT_SYMBOLS: SymbolMeta[] = [
  { symbol: "BTCUSDT",   base: "BTC",   quote: "USDT", pricePrecision: 2, qtyPrecision: 6 },
  { symbol: "ETHUSDT",   base: "ETH",   quote: "USDT", pricePrecision: 2, qtyPrecision: 5 },
  { symbol: "SOLUSDT",   base: "SOL",   quote: "USDT", pricePrecision: 3, qtyPrecision: 2 },
  { symbol: "BNBUSDT",   base: "BNB",   quote: "USDT", pricePrecision: 2, qtyPrecision: 3 },
  { symbol: "XRPUSDT",   base: "XRP",   quote: "USDT", pricePrecision: 4, qtyPrecision: 1 },
  { symbol: "DOGEUSDT",  base: "DOGE",  quote: "USDT", pricePrecision: 5, qtyPrecision: 0 },
  { symbol: "ADAUSDT",   base: "ADA",   quote: "USDT", pricePrecision: 4, qtyPrecision: 1 },
  { symbol: "AVAXUSDT",  base: "AVAX",  quote: "USDT", pricePrecision: 3, qtyPrecision: 2 },
  { symbol: "DOTUSDT",   base: "DOT",   quote: "USDT", pricePrecision: 3, qtyPrecision: 2 },
  { symbol: "LINKUSDT",  base: "LINK",  quote: "USDT", pricePrecision: 3, qtyPrecision: 2 },
  { symbol: "MATICUSDT", base: "MATIC", quote: "USDT", pricePrecision: 4, qtyPrecision: 1 },
  { symbol: "ATOMUSDT",  base: "ATOM",  quote: "USDT", pricePrecision: 3, qtyPrecision: 2 },
];

const META_BY_SYMBOL = new Map(DEFAULT_SYMBOLS.map((s) => [s.symbol, s]));

export function getSymbolMeta(symbol: string): SymbolMeta | undefined {
  return META_BY_SYMBOL.get(symbol);
}

export function getPricePrecision(symbol: string, fallbackPrice?: number): number {
  const meta = META_BY_SYMBOL.get(symbol);
  if (meta) return meta.pricePrecision;
  if (fallbackPrice !== undefined) {
    if (fallbackPrice >= 1000) return 2;
    if (fallbackPrice >= 1) return 4;
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
