import { gridBotFactory } from "./gridBot";
import type { BotFactory } from "./base";

export const BOT_FACTORIES: Record<string, BotFactory> = {
  grid: gridBotFactory,
};

export function getBotFactory(kind: string): BotFactory | undefined {
  return BOT_FACTORIES[kind];
}
