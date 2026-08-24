import { gridBotFactory } from "./gridBot";
import { dcaBotFactory  } from "./dcaBot";
import { nightMeanReversionFactory } from "./nightMeanReversion";
import type { BotFactory } from "./base";

export const BOT_FACTORIES: Record<string, BotFactory> = {
  grid: gridBotFactory,
  dca:  dcaBotFactory,
  "night-mr": nightMeanReversionFactory,
};

export function getBotFactory(kind: string): BotFactory | undefined {
  return BOT_FACTORIES[kind];
}
