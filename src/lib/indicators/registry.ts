import { def as smaDef } from "./sma";
import { def as emaDef } from "./ema";
import { def as rsiDef } from "./rsi";
import { def as macdDef } from "./macd";
import { def as bollDef } from "./bollinger";
import { def as stochDef } from "./stochastic";
import { def as atrDef } from "./atr";
import type { IndicatorDef, IndicatorKind } from "./base";

export const INDICATORS: Record<IndicatorKind, IndicatorDef> = {
  sma:        smaDef,
  ema:        emaDef,
  rsi:        rsiDef,
  macd:       macdDef,
  bollinger:  bollDef,
  stochastic: stochDef,
  atr:        atrDef,
};

export function getIndicatorDef(kind: string): IndicatorDef | undefined {
  return INDICATORS[kind as IndicatorKind];
}
