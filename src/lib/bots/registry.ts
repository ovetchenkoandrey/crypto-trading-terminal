import { gridBotFactory } from "./gridBot";
import { dcaBotFactory  } from "./dcaBot";
import { nightMeanReversionFactory } from "./nightMeanReversion";
import { zigzagBreakoutFactory } from "./zigzagBreakout";
import { fractalWaveFactory } from "./fractalWave";
import { vwapReversionFactory } from "./vwapReversion";
import { nightRangeBreakoutFactory } from "./nightRangeBreakout";
import { cascadeReversionFactory } from "./cascadeReversion";
import { fundingExtremeFactory } from "./fundingExtreme";
import { trendFollowFactory } from "./trendFollow";
import type { BotFactory } from "./base";

export const BOT_FACTORIES: Record<string, BotFactory> = {
  grid: gridBotFactory,
  dca:  dcaBotFactory,
  "night-mr": nightMeanReversionFactory,
  "zz-breakout": zigzagBreakoutFactory,
  "fractal-wave": fractalWaveFactory,
  "vwap-mr": vwapReversionFactory,
  "night-range": nightRangeBreakoutFactory,
  "cascade-mr": cascadeReversionFactory,
  "funding-extreme": fundingExtremeFactory,
  "trend-follow": trendFollowFactory,
};

export function getBotFactory(kind: string): BotFactory | undefined {
  return BOT_FACTORIES[kind];
}
