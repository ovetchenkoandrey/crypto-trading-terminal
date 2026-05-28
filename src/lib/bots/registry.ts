import { gridBotFactory } from "./gridBot";
import { dcaBotFactory  } from "./dcaBot";
import type { BotFactory } from "./base";

export const BOT_FACTORIES: Record<string, BotFactory> = {
  grid: gridBotFactory,
  dca:  dcaBotFactory,
};

export function getBotFactory(kind: string): BotFactory | undefined {
  return BOT_FACTORIES[kind];
}
