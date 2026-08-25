// Parameter grid: declaration -> the exact list of combinations that will be run.
//
// The grid is the thing that decides how much multiple testing we are doing, so
// it is deliberately explicit and deliberately capped. A typo that turns a
// three-value axis into a three-thousand-value one has to fail loudly, not
// quietly spend an hour manufacturing a false positive.
//
// Combination order is an odometer over the axes in declaration order, last axis
// varying fastest. That makes the coordinate vector of a combination stable
// across runs, which is what the plateau map needs to talk about "neighbours".

export type GridValue = number | string;

export type GridAxisDecl =
  | GridValue
  | readonly GridValue[]
  | { values: readonly GridValue[] }
  | { from: number; to: number; step: number }
  | { from: number; to: number; count: number };

export type GridDecl = Record<string, GridAxisDecl>;

export interface GridAxis {
  key: string;
  values: GridValue[];
}

export interface ParamCombo {
  /** Position in the odometer enumeration. */
  index: number;
  /** Index into `axes[i].values` for each axis, same order as `axes`. */
  coords: number[];
  params: Record<string, GridValue>;
}

export interface ParamGrid {
  axes: GridAxis[];
  combos: ParamCombo[];
  /** combos.length, i.e. the number of trials this run will perform. */
  size: number;
}

export const DEFAULT_MAX_COMBOS = 20_000;

/** Float steps accumulate error; 1e-9 rounding keeps 0.1-steps printable. */
function tidy(n: number): number {
  const r = Math.round(n * 1e9) / 1e9;
  return Object.is(r, -0) ? 0 : r;
}

function rangeValues(from: number, to: number, step: number, key: string): number[] {
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error(`grid.${key}: from/to must be finite numbers`);
  if (!Number.isFinite(step) || step <= 0) throw new Error(`grid.${key}: step must be a positive number`);
  if (to < from) throw new Error(`grid.${key}: to (${to}) is below from (${from})`);
  const n = Math.floor(tidy((to - from) / step)) + 1;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(tidy(from + i * step));
  return out;
}

function countValues(from: number, to: number, count: number, key: string): number[] {
  if (!Number.isFinite(count) || count < 1 || Math.floor(count) !== count) {
    throw new Error(`grid.${key}: count must be a positive integer`);
  }
  if (count === 1) return [tidy(from)];
  const step = (to - from) / (count - 1);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(tidy(from + i * step));
  return out;
}

export function parseAxis(key: string, decl: GridAxisDecl): GridAxis {
  if (Array.isArray(decl)) {
    if (decl.length === 0) throw new Error(`grid.${key}: value list is empty`);
    return { key, values: dedupe(decl as GridValue[], key) };
  }
  if (decl !== null && typeof decl === "object") {
    const obj = decl as Record<string, unknown>;
    if (Array.isArray(obj.values)) {
      if (obj.values.length === 0) throw new Error(`grid.${key}: values is empty`);
      return { key, values: dedupe(obj.values as GridValue[], key) };
    }
    if ("from" in obj && "to" in obj) {
      const from = Number(obj.from);
      const to = Number(obj.to);
      if ("count" in obj) return { key, values: countValues(from, to, Number(obj.count), key) };
      if ("step" in obj) return { key, values: rangeValues(from, to, Number(obj.step), key) };
      throw new Error(`grid.${key}: a range needs "step" or "count"`);
    }
    throw new Error(`grid.${key}: unsupported axis shape ${JSON.stringify(decl)}`);
  }
  if (typeof decl === "number" || typeof decl === "string") return { key, values: [decl] };
  throw new Error(`grid.${key}: unsupported axis shape ${JSON.stringify(decl)}`);
}

function dedupe(values: readonly GridValue[], key: string): GridValue[] {
  const seen = new Set<string>();
  const out: GridValue[] = [];
  for (const raw of values) {
    if (typeof raw !== "number" && typeof raw !== "string") {
      throw new Error(`grid.${key}: values must be numbers or strings, got ${JSON.stringify(raw)}`);
    }
    const value = typeof raw === "number" ? tidy(raw) : raw;
    const token = `${typeof value}:${value}`;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(value);
  }
  return out;
}

export interface ExpandGridOptions {
  /** Refuses to build a grid larger than this. Default 20 000. */
  maxCombos?: number;
}

export function expandGrid(decl: GridDecl, opts: ExpandGridOptions = {}): ParamGrid {
  const keys = Object.keys(decl ?? {});
  if (keys.length === 0) throw new Error("grid is empty — declare at least one parameter");

  const axes = keys.map((key) => parseAxis(key, decl[key]));
  const max = opts.maxCombos ?? DEFAULT_MAX_COMBOS;

  let size = 1;
  for (const axis of axes) size *= axis.values.length;
  if (size > max) {
    const shape = axes.map((a) => `${a.key}:${a.values.length}`).join(" x ");
    throw new Error(
      `grid has ${size} combinations (${shape}), over the cap of ${max}. ` +
        `Raise maxCombos deliberately, or cut the grid — every extra combination raises the bar the winner has to clear.`,
    );
  }

  const combos: ParamCombo[] = [];
  const coords = new Array(axes.length).fill(0);
  for (let index = 0; index < size; index++) {
    const params: Record<string, GridValue> = {};
    for (let a = 0; a < axes.length; a++) params[axes[a].key] = axes[a].values[coords[a]];
    combos.push({ index, coords: [...coords], params });
    for (let a = axes.length - 1; a >= 0; a--) {
      coords[a] += 1;
      if (coords[a] < axes[a].values.length) break;
      coords[a] = 0;
    }
  }

  return { axes, combos, size };
}

/** Stable identity of a combination, for logs and report keys. */
export function comboLabel(combo: ParamCombo, axes: readonly GridAxis[]): string {
  return axes.map((a) => `${a.key}=${combo.params[a.key]}`).join(" ");
}

/** Combinations one grid step away along exactly one axis. */
export function neighbourIndices(grid: ParamGrid, index: number): number[] {
  const combo = grid.combos[index];
  if (!combo) return [];
  const strides = strideTable(grid.axes);
  const out: number[] = [];
  for (let a = 0; a < grid.axes.length; a++) {
    for (const delta of [-1, 1]) {
      const at = combo.coords[a] + delta;
      if (at < 0 || at >= grid.axes[a].values.length) continue;
      out.push(index + delta * strides[a]);
    }
  }
  return out;
}

export function strideTable(axes: readonly GridAxis[]): number[] {
  const strides = new Array(axes.length).fill(1);
  for (let a = axes.length - 2; a >= 0; a--) strides[a] = strides[a + 1] * axes[a + 1].values.length;
  return strides;
}

/**
 * CLI shorthand: `bbPeriod=10:40:10;bbMult=1.5,2,2.5;exitMode=market,limit`.
 * Semicolons separate axes because commas already separate values.
 */
export function parseGridSpec(raw: string): GridDecl {
  const decl: GridDecl = {};
  for (const chunk of String(raw ?? "").split(";")) {
    const part = chunk.trim();
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq < 0) throw new Error(`--grid: "${part}" is not key=values`);
    const key = part.slice(0, eq).trim();
    const body = part.slice(eq + 1).trim();
    if (!key) throw new Error(`--grid: empty parameter name in "${part}"`);
    if (!body) throw new Error(`--grid: no values for "${key}"`);

    const colon = body.split(":");
    if (colon.length === 3 && colon.every((p) => p.trim() !== "" && Number.isFinite(Number(p)))) {
      decl[key] = { from: Number(colon[0]), to: Number(colon[1]), step: Number(colon[2]) };
      continue;
    }
    decl[key] = body.split(",").map((v) => {
      const text = v.trim();
      const num = Number(text);
      return text !== "" && Number.isFinite(num) ? num : text;
    });
  }
  if (Object.keys(decl).length === 0) throw new Error("--grid: nothing to expand");
  return decl;
}
