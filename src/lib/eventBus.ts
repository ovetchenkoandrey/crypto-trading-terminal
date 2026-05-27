import mitt from "mitt";
import { useStore } from "./store";

export type LogLevel = "info" | "ok" | "warn" | "error";

export type BotEventType =
  | "started"
  | "stopped"
  | "order_placed"
  | "order_filled"
  | "order_cancelled"
  | "error";

export interface BotEvent {
  ts: number;
  botId: string;
  type: BotEventType;
  data: Record<string, unknown>;
}

type Events = {
  bot: BotEvent;
};

export const bus = mitt<Events>();

export function log(level: LogLevel, source: string, msg: string): void {
  useStore.getState().pushJournal({ ts: Date.now(), level, source, msg });
}

export const logInfo  = (src: string, msg: string) => log("info",  src, msg);
export const logOk    = (src: string, msg: string) => log("ok",    src, msg);
export const logWarn  = (src: string, msg: string) => log("warn",  src, msg);
export const logError = (src: string, msg: string) => log("error", src, msg);

export function emitBot(ev: BotEvent): void {
  bus.emit("bot", ev);
  log(ev.type === "error" ? "error" : "info", `bot:${ev.botId}`,
    `${ev.type}${Object.keys(ev.data).length ? " " + JSON.stringify(ev.data) : ""}`);
}
