// Plateau analysis: is the winner a region or a spike?
//
// A single best combination proves nothing. If bbPeriod 20 makes money and
// bbPeriod 19 and 21 both lose it, the grid found a hole in the noise, not a
// property of the market. So the report never shows a peak without showing
// what is standing next to it.
//
// Three views, cheapest first:
//   - neighbourhood: the combinations one grid step away along exactly one axis;
//   - axis profiles: for each parameter, the median score over every other
//     parameter, which answers "does this value hold up in general" rather than
//     "does this value hold up next to the other winners";
//   - a two-axis ASCII map, sliced through the winner.

import { neighbourIndices, strideTable, type GridAxis, type ParamGrid, type GridValue } from "./paramGrid.ts";

export type PlateauVerdict = "plateau" | "slope" | "isolated-peak" | "n/a";

export interface NeighbourStats {
  total: number;
  /** Neighbours that were scored at all (a combination can be unscored: too few trades). */
  scored: number;
  better: number;
  /** Neighbours holding at least `keepFraction` of the winner's score. */
  holding: number;
  median: number | null;
  min: number | null;
  max: number | null;
}

export interface AxisProfilePoint {
  value: GridValue;
  /** Score of the combination that differs from the winner only in this axis. */
  slice: number | null;
  /** Median score over every combination with this value on this axis. */
  median: number | null;
  isBest: boolean;
}

export interface AxisProfile {
  key: string;
  points: AxisProfilePoint[];
}

export interface PlateauReport {
  bestIndex: number;
  bestScore: number;
  /** Median score of every scored combination — the "what a random pick would give" line. */
  gridMedian: number | null;
  neighbours: NeighbourStats;
  /** holding / scored, 0..1. */
  robustness: number;
  verdict: PlateauVerdict;
  axisProfiles: AxisProfile[];
}

export interface PlateauOptions {
  /** A neighbour "holds" when its score is at least this fraction of the winner's. Default 0.5. */
  keepFraction?: number;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function analysePlateau(grid: ParamGrid, scores: readonly (number | null)[], bestIndex: number, opts: PlateauOptions = {}): PlateauReport {
  const keepFraction = opts.keepFraction ?? 0.5;
  const bestScore = scores[bestIndex] ?? Number.NaN;
  const scored = scores.filter((s): s is number => s !== null && Number.isFinite(s));

  const neighbourIdx = neighbourIndices(grid, bestIndex);
  const neighbourScores = neighbourIdx.map((i) => scores[i]).filter((s): s is number => s !== null && Number.isFinite(s));

  // The bar a neighbour has to clear. For a positive winner it is a fraction of
  // the peak; for a negative or zero winner the notion of "half as good" is
  // meaningless, so the analysis declines to answer rather than invent a number.
  const usable = Number.isFinite(bestScore) && bestScore > 0;
  const bar = usable ? bestScore * keepFraction : Number.NaN;
  const holding = usable ? neighbourScores.filter((s) => s >= bar).length : 0;
  const robustness = usable && neighbourScores.length > 0 ? holding / neighbourScores.length : 0;

  let verdict: PlateauVerdict = "n/a";
  if (usable && neighbourScores.length > 0) {
    verdict = robustness >= 0.7 ? "plateau" : robustness >= 0.35 ? "slope" : "isolated-peak";
  }

  return {
    bestIndex,
    bestScore,
    gridMedian: median(scored),
    neighbours: {
      total: neighbourIdx.length,
      scored: neighbourScores.length,
      better: neighbourScores.filter((s) => s > bestScore).length,
      holding,
      median: median(neighbourScores),
      min: neighbourScores.length ? Math.min(...neighbourScores) : null,
      max: neighbourScores.length ? Math.max(...neighbourScores) : null,
    },
    robustness,
    verdict,
    axisProfiles: buildAxisProfiles(grid, scores, bestIndex),
  };
}

function buildAxisProfiles(grid: ParamGrid, scores: readonly (number | null)[], bestIndex: number): AxisProfile[] {
  const best = grid.combos[bestIndex];
  const strides = strideTable(grid.axes);
  return grid.axes.map((axis, a) => ({
    key: axis.key,
    points: axis.values.map((value, v) => {
      const sliceIndex = bestIndex + (v - best.coords[a]) * strides[a];
      const bucket: number[] = [];
      for (const combo of grid.combos) {
        if (combo.coords[a] !== v) continue;
        const s = scores[combo.index];
        if (s !== null && Number.isFinite(s)) bucket.push(s);
      }
      const slice = scores[sliceIndex];
      return {
        value,
        slice: slice !== null && slice !== undefined && Number.isFinite(slice) ? slice : null,
        median: median(bucket),
        isBest: v === best.coords[a],
      };
    }),
  }));
}

/* ── ASCII map ────────────────────────────────────────────────────────────── */

/** Picks the two axes with the most levels — the ones a map can actually show. */
export function pickMapAxes(grid: ParamGrid, preferred?: readonly string[]): [string, string] | null {
  if (preferred && preferred.length >= 2) {
    const keys = preferred.slice(0, 2);
    if (keys.every((k) => grid.axes.some((a) => a.key === k))) return [keys[0], keys[1]];
  }
  const ranked = [...grid.axes].filter((a) => a.values.length > 1).sort((x, y) => y.values.length - x.values.length);
  if (ranked.length < 2) return null;
  return [ranked[0].key, ranked[1].key];
}

const SHADES = " .:-=+*#@";

function shadeOf(value: number | null, lo: number, hi: number): string {
  if (value === null || !Number.isFinite(value)) return "?";
  if (hi <= lo) return SHADES[SHADES.length - 1];
  const t = (value - lo) / (hi - lo);
  const i = Math.min(SHADES.length - 1, Math.max(0, Math.round(t * (SHADES.length - 1))));
  return SHADES[i];
}

function fmt(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

export interface HeatmapOptions {
  /** Cell values come from the slice through this combination. */
  bestIndex: number;
  xAxis: string;
  yAxis: string;
  /** Label above the map. */
  title?: string;
}

/**
 * Two-dimensional slice through the winner: every other parameter is pinned to
 * the winner's value, so the map shows the ridge the winner sits on. Numbers
 * for narrow grids, shading characters once the numbers stop fitting.
 */
export function formatHeatmap(grid: ParamGrid, scores: readonly (number | null)[], opts: HeatmapOptions): string {
  const ax = grid.axes.findIndex((a) => a.key === opts.xAxis);
  const ay = grid.axes.findIndex((a) => a.key === opts.yAxis);
  if (ax < 0 || ay < 0) return `(no map: axes ${opts.xAxis}/${opts.yAxis} are not in the grid)`;
  if (ax === ay) return "(no map: need two different axes)";

  const best = grid.combos[opts.bestIndex];
  const strides = strideTable(grid.axes);
  const xs = grid.axes[ax].values;
  const ys = grid.axes[ay].values;

  const cell = (xi: number, yi: number): number | null => {
    const idx = opts.bestIndex + (xi - best.coords[ax]) * strides[ax] + (yi - best.coords[ay]) * strides[ay];
    const s = scores[idx];
    return s !== null && s !== undefined && Number.isFinite(s) ? s : null;
  };

  const values: (number | null)[][] = ys.map((_, yi) => xs.map((__, xi) => cell(xi, yi)));
  const flat = values.flat().filter((v): v is number => v !== null);
  const lo = flat.length ? Math.min(...flat) : 0;
  const hi = flat.length ? Math.max(...flat) : 0;

  const numeric = xs.length <= 10;
  const rowLabelWidth = Math.max(String(opts.yAxis).length, ...ys.map((v) => String(v).length));
  const colWidth = numeric
    ? Math.max(6, ...xs.map((v) => String(v).length + 2), ...flat.map((v) => fmt(v).length + 2))
    : Math.max(2, ...xs.map((v) => String(v).length));

  const lines: string[] = [];
  if (opts.title) lines.push(opts.title);
  lines.push(`${" ".repeat(rowLabelWidth)}  ${opts.xAxis} ->`);
  lines.push(`${" ".repeat(rowLabelWidth)}  ${xs.map((v) => String(v).padStart(colWidth)).join("")}`);

  for (let yi = 0; yi < ys.length; yi++) {
    const cells = xs.map((_, xi) => {
      const v = values[yi][xi];
      const isBest = xi === best.coords[ax] && yi === best.coords[ay];
      const body = numeric ? fmt(v) : shadeOf(v, lo, hi);
      return (isBest ? `[${body}]` : body).padStart(colWidth);
    });
    lines.push(`${String(ys[yi]).padStart(rowLabelWidth)}  ${cells.join("")}`);
  }
  lines.push(`${" ".repeat(rowLabelWidth)}  ^ ${opts.yAxis}`);
  if (!numeric) lines.push(`  shading "${SHADES.trim()}" spans ${fmt(lo)} .. ${fmt(hi)}; "?" = not scored; [x] = selected`);
  else lines.push(`  [x] = selected combination; other parameters pinned to its values`);
  return lines.join("\n");
}

/** Renders the per-axis medians as a plain table. */
export function formatAxisProfiles(profiles: readonly AxisProfile[], axes: readonly GridAxis[]): string {
  const lines: string[] = [];
  const nameWidth = Math.max(9, ...axes.map((a) => a.key.length));
  lines.push(`${"parameter".padEnd(nameWidth)}  value       slice     median over rest`);
  for (const profile of profiles) {
    for (let i = 0; i < profile.points.length; i++) {
      const p = profile.points[i];
      lines.push(
        `${(i === 0 ? profile.key : "").padEnd(nameWidth)}  ${(`${p.value}${p.isBest ? " *" : ""}`).padEnd(10)}  ` +
          `${fmt(p.slice).padStart(8)}  ${fmt(p.median).padStart(16)}`,
      );
    }
  }
  lines.push("  * = value of the selected combination");
  return lines.join("\n");
}
