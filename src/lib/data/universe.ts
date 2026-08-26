// The cross-section universe: Binance USDT perpetuals with enough history and
// enough liquidity to test whether a per-symbol effect survives breadth.
//
// Selection rules, applied once against `fapi/v1/exchangeInfo` and the 24h
// ticker, then frozen here so a run is reproducible without the network:
//
//  - PERPETUAL, quote USDT, TRADING;
//  - onboarded before 2022-01-01, so every symbol covers the whole study window
//    rather than contributing only its late years;
//  - ranked by 24h quote volume, top of the list taken;
//  - BNBUSDT dropped — its price is a function of the exchange's own policy
//    (burns, launchpad), which is not the market we are measuring;
//  - BTCDOMUSDT dropped — a synthetic dominance index, not an asset with a book;
//  - tokenized equities and metals dropped — all listed after 2024 anyway, and
//    they inherit an equity session, not a crypto one.
//
// `tier` is assigned from the same volume ranking and exists so the study can
// ask whether the effect depends on liquidity rather than assuming it does not.
// `minQty`/`qtyStep` are the exchange LOT_SIZE values; `minNotionalUsdt` is the
// MIN_NOTIONAL filter, which is what actually binds a 1000 USDT account.

export interface UniverseSymbol {
  symbol: string;
  /** First day the perpetual traded on Binance, UTC. */
  onboard: string;
  /** 24h quote volume in USDT at selection time — the liquidity ranking input. */
  volumeUsdt: number;
  tier: "mega" | "large" | "mid";
  minQty: number;
  qtyStep: number;
  tickSize: number;
  minNotionalUsdt: number;
}

export const UNIVERSE_START_MONTH = "2022-01";

/** Ordered by liquidity at selection time; the first four are the original set. */
export const CASCADE_UNIVERSE: UniverseSymbol[] = [
  { symbol: "BTCUSDT",      onboard: "2019-09-08", volumeUsdt: 11_739_800_000, tier: "mega",  minQty: 0.001, qtyStep: 0.001, tickSize: 0.1,        minNotionalUsdt: 50 },
  { symbol: "ETHUSDT",      onboard: "2019-11-27", volumeUsdt:  7_952_400_000, tier: "mega",  minQty: 0.001, qtyStep: 0.001, tickSize: 0.01,       minNotionalUsdt: 20 },
  { symbol: "SOLUSDT",      onboard: "2020-09-14", volumeUsdt:  1_774_700_000, tier: "mega",  minQty: 0.01,  qtyStep: 0.01,  tickSize: 0.01,       minNotionalUsdt: 5 },
  { symbol: "XRPUSDT",      onboard: "2020-01-06", volumeUsdt:  1_699_600_000, tier: "mega",  minQty: 0.1,   qtyStep: 0.1,   tickSize: 0.0001,     minNotionalUsdt: 5 },
  { symbol: "ZECUSDT",      onboard: "2020-02-05", volumeUsdt:  1_390_900_000, tier: "mega",  minQty: 0.001, qtyStep: 0.001, tickSize: 0.01,       minNotionalUsdt: 5 },
  { symbol: "DOGEUSDT",     onboard: "2020-07-10", volumeUsdt:    449_600_000, tier: "mega",  minQty: 1,     qtyStep: 1,     tickSize: 0.00001,    minNotionalUsdt: 5 },
  { symbol: "ADAUSDT",      onboard: "2020-01-31", volumeUsdt:    144_000_000, tier: "large", minQty: 1,     qtyStep: 1,     tickSize: 0.0001,     minNotionalUsdt: 5 },
  { symbol: "LINKUSDT",     onboard: "2020-01-17", volumeUsdt:    124_700_000, tier: "large", minQty: 0.01,  qtyStep: 0.01,  tickSize: 0.001,      minNotionalUsdt: 20 },
  { symbol: "NEARUSDT",     onboard: "2020-10-15", volumeUsdt:    102_700_000, tier: "large", minQty: 1,     qtyStep: 1,     tickSize: 0.001,      minNotionalUsdt: 5 },
  { symbol: "AAVEUSDT",     onboard: "2020-10-16", volumeUsdt:     99_900_000, tier: "large", minQty: 0.1,   qtyStep: 0.1,   tickSize: 0.01,       minNotionalUsdt: 5 },
  { symbol: "UNIUSDT",      onboard: "2020-09-18", volumeUsdt:     81_400_000, tier: "large", minQty: 1,     qtyStep: 1,     tickSize: 0.001,      minNotionalUsdt: 5 },
  { symbol: "AVAXUSDT",     onboard: "2020-09-23", volumeUsdt:     75_400_000, tier: "large", minQty: 1,     qtyStep: 1,     tickSize: 0.001,      minNotionalUsdt: 5 },
  { symbol: "LTCUSDT",      onboard: "2020-01-09", volumeUsdt:     73_300_000, tier: "large", minQty: 0.001, qtyStep: 0.001, tickSize: 0.01,       minNotionalUsdt: 20 },
  { symbol: "TRXUSDT",      onboard: "2020-01-15", volumeUsdt:     69_300_000, tier: "large", minQty: 1,     qtyStep: 1,     tickSize: 0.00001,    minNotionalUsdt: 5 },
  { symbol: "FILUSDT",      onboard: "2020-10-16", volumeUsdt:     64_500_000, tier: "large", minQty: 0.1,   qtyStep: 0.1,   tickSize: 0.0001,     minNotionalUsdt: 5 },
  { symbol: "BCHUSDT",      onboard: "2019-12-19", volumeUsdt:     57_800_000, tier: "large", minQty: 0.001, qtyStep: 0.001, tickSize: 0.01,       minNotionalUsdt: 20 },
  { symbol: "XLMUSDT",      onboard: "2020-01-20", volumeUsdt:     57_200_000, tier: "large", minQty: 1,     qtyStep: 1,     tickSize: 0.00001,    minNotionalUsdt: 5 },
  { symbol: "1000SHIBUSDT", onboard: "2021-05-10", volumeUsdt:     44_100_000, tier: "large", minQty: 1,     qtyStep: 1,     tickSize: 0.000001,   minNotionalUsdt: 5 },
  { symbol: "XMRUSDT",      onboard: "2020-02-03", volumeUsdt:     38_400_000, tier: "large", minQty: 0.001, qtyStep: 0.001, tickSize: 0.01,       minNotionalUsdt: 5 },
  { symbol: "DOTUSDT",      onboard: "2020-08-22", volumeUsdt:     37_200_000, tier: "large", minQty: 0.1,   qtyStep: 0.1,   tickSize: 0.0001,     minNotionalUsdt: 5 },
  { symbol: "DASHUSDT",     onboard: "2020-02-04", volumeUsdt:     32_300_000, tier: "mid",   minQty: 0.001, qtyStep: 0.001, tickSize: 0.01,       minNotionalUsdt: 5 },
  { symbol: "HBARUSDT",     onboard: "2021-03-17", volumeUsdt:     30_200_000, tier: "mid",   minQty: 1,     qtyStep: 1,     tickSize: 0.00001,    minNotionalUsdt: 5 },
  { symbol: "ETCUSDT",      onboard: "2020-01-16", volumeUsdt:     29_500_000, tier: "mid",   minQty: 0.01,  qtyStep: 0.01,  tickSize: 0.001,      minNotionalUsdt: 20 },
  { symbol: "ONTUSDT",      onboard: "2020-02-11", volumeUsdt:     29_400_000, tier: "mid",   minQty: 0.1,   qtyStep: 0.1,   tickSize: 0.00001,    minNotionalUsdt: 5 },
  { symbol: "PEOPLEUSDT",   onboard: "2021-12-23", volumeUsdt:     28_500_000, tier: "mid",   minQty: 1,     qtyStep: 1,     tickSize: 0.000001,   minNotionalUsdt: 5 },
  { symbol: "ATOMUSDT",     onboard: "2020-02-07", volumeUsdt:     21_100_000, tier: "mid",   minQty: 0.01,  qtyStep: 0.01,  tickSize: 0.001,      minNotionalUsdt: 5 },
  { symbol: "ICPUSDT",      onboard: "2021-07-30", volumeUsdt:     20_300_000, tier: "mid",   minQty: 1,     qtyStep: 1,     tickSize: 0.001,      minNotionalUsdt: 5 },
  { symbol: "CRVUSDT",      onboard: "2020-09-01", volumeUsdt:     18_900_000, tier: "mid",   minQty: 0.1,   qtyStep: 0.1,   tickSize: 0.0001,     minNotionalUsdt: 5 },
  { symbol: "COTIUSDT",     onboard: "2021-03-09", volumeUsdt:     15_400_000, tier: "mid",   minQty: 1,     qtyStep: 1,     tickSize: 0.000001,   minNotionalUsdt: 5 },
  { symbol: "GALAUSDT",     onboard: "2021-09-17", volumeUsdt:     11_300_000, tier: "mid",   minQty: 1,     qtyStep: 1,     tickSize: 0.000001,   minNotionalUsdt: 5 },
  { symbol: "ENSUSDT",      onboard: "2021-11-29", volumeUsdt:     10_300_000, tier: "mid",   minQty: 0.1,   qtyStep: 0.1,   tickSize: 0.001,      minNotionalUsdt: 5 },
  { symbol: "SANDUSDT",     onboard: "2021-01-18", volumeUsdt:     10_200_000, tier: "mid",   minQty: 1,     qtyStep: 1,     tickSize: 0.00001,    minNotionalUsdt: 5 },
  { symbol: "ALGOUSDT",     onboard: "2020-06-16", volumeUsdt:      9_400_000, tier: "mid",   minQty: 0.1,   qtyStep: 0.1,   tickSize: 0.00001,    minNotionalUsdt: 5 },
  { symbol: "TRBUSDT",      onboard: "2020-09-03", volumeUsdt:      8_100_000, tier: "mid",   minQty: 0.1,   qtyStep: 0.1,   tickSize: 0.001,      minNotionalUsdt: 5 },
  { symbol: "ZENUSDT",      onboard: "2020-11-24", volumeUsdt:      6_300_000, tier: "mid",   minQty: 0.1,   qtyStep: 0.1,   tickSize: 0.001,      minNotionalUsdt: 5 },
  { symbol: "ARUSDT",       onboard: "2021-09-28", volumeUsdt:      6_000_000, tier: "mid",   minQty: 0.1,   qtyStep: 0.1,   tickSize: 0.001,      minNotionalUsdt: 5 },
  { symbol: "VETUSDT",      onboard: "2020-02-14", volumeUsdt:      5_900_000, tier: "mid",   minQty: 1,     qtyStep: 1,     tickSize: 0.000001,   minNotionalUsdt: 5 },
  { symbol: "AXSUSDT",      onboard: "2020-11-20", volumeUsdt:      5_300_000, tier: "mid",   minQty: 1,     qtyStep: 1,     tickSize: 0.0001,     minNotionalUsdt: 5 },
  { symbol: "CHZUSDT",      onboard: "2021-01-21", volumeUsdt:      5_000_000, tier: "mid",   minQty: 1,     qtyStep: 1,     tickSize: 0.00001,    minNotionalUsdt: 5 },
  { symbol: "ALICEUSDT",    onboard: "2021-03-15", volumeUsdt:      4_900_000, tier: "mid",   minQty: 0.1,   qtyStep: 0.1,   tickSize: 0.0001,     minNotionalUsdt: 5 },
  { symbol: "DYDXUSDT",     onboard: "2021-09-09", volumeUsdt:      4_900_000, tier: "mid",   minQty: 0.1,   qtyStep: 0.1,   tickSize: 0.0001,     minNotionalUsdt: 5 },
  { symbol: "MASKUSDT",     onboard: "2021-07-16", volumeUsdt:      4_600_000, tier: "mid",   minQty: 1,     qtyStep: 1,     tickSize: 0.0001,     minNotionalUsdt: 5 },
  { symbol: "GRTUSDT",      onboard: "2020-12-18", volumeUsdt:      4_500_000, tier: "mid",   minQty: 1,     qtyStep: 1,     tickSize: 0.00001,    minNotionalUsdt: 5 },
  { symbol: "RUNEUSDT",     onboard: "2020-09-04", volumeUsdt:      3_800_000, tier: "mid",   minQty: 1,     qtyStep: 1,     tickSize: 0.0001,     minNotionalUsdt: 5 },
];

export const UNIVERSE_SYMBOLS: string[] = CASCADE_UNIVERSE.map((s) => s.symbol);

export function universeSymbol(symbol: string): UniverseSymbol | undefined {
  return CASCADE_UNIVERSE.find((s) => s.symbol === symbol);
}

export function universeByTier(tier: UniverseSymbol["tier"]): UniverseSymbol[] {
  return CASCADE_UNIVERSE.filter((s) => s.tier === tier);
}
