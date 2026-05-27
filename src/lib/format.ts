export function defaultPricePrecision(price: number): number {
  if (price >= 1000) return 2;
  if (price >= 1) return 4;
  if (price >= 0.01) return 5;
  return 6;
}

export function fmtPrice(p: number, precision?: number): string {
  const d = precision ?? defaultPricePrecision(p);
  return p.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtPercent(p: number, withSign = true): string {
  const sign = withSign && p >= 0 ? "+" : "";
  return `${sign}${p.toFixed(2)}%`;
}

export function fmtTime(utcMs: number): string {
  const d = new Date(utcMs);
  return d.toLocaleTimeString("ru-RU", { hour12: false });
}

export function fmtUsdt(v: number): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtVolume(v: number): string {
  if (v >= 1_000_000_000) return (v / 1_000_000_000).toFixed(2) + "B";
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(1) + "k";
  return v.toFixed(2);
}
