// Named cost bundles for the command line.
//
// The config file always spells its cost models out; a command line cannot, so
// it gets three presets and no default. `--costs` stays mandatory for the same
// reason `costs` is mandatory in a config: a run that does not say what it pays
// is not a result, and the most common way to manufacture a profitable strategy
// is to forget the fees.

import type { CostsDecl } from "./runConfig.ts";

export type CostPreset = "none" | "fees" | "full";

export const COST_PRESETS: CostPreset[] = ["none", "fees", "full"];

export function isCostPreset(value: string): value is CostPreset {
  return (COST_PRESETS as string[]).includes(value);
}

export function costsPreset(preset: CostPreset, market: string, slippageBps: number): CostsDecl {
  switch (preset) {
    case "none":
      return { fees: false, slippage: false };
    case "fees":
      return { fees: market === "spot" ? "bybit-spot" : "bybit-linear", slippage: false };
    case "full":
      return {
        fees: market === "spot" ? "bybit-spot" : "bybit-linear",
        slippage: { kind: "fixed_bps", bps: slippageBps },
        slippageContext: true,
        rejection: true,
        rules: true,
        funding: market !== "spot",
        margin: market !== "spot",
      };
  }
}
