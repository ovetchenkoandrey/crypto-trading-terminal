/**
 * Seeded random numbers.
 *
 * Used by the tests to build series with a known answer, and by the study to
 * generate null distributions — the honest way to say how big a number has to
 * be before it stops being noise is to simulate the noise.
 */

export type Rng = () => number;

/** mulberry32: small, fast, and good enough for Monte Carlo of this size. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal deviates via Box-Muller. */
export function gaussian(rng: Rng): number {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function normalSeries(n: number, sigma: number, rng: Rng): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = gaussian(rng) * sigma;
  return out;
}

/** AR(1) series x_t = phi * x_{t-1} + sigma * e_t, started at its stationary mean. */
export function ar1Series(n: number, phi: number, sigma: number, rng: Rng): Float64Array {
  const out = new Float64Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    prev = phi * prev + sigma * gaussian(rng);
    out[i] = prev;
  }
  return out;
}

/**
 * GARCH(1,1): no serial correlation in the mean, strong clustering in the
 * variance. This is the shape real crypto returns have, and the case where the
 * classical standard errors go wrong — which makes it the right null for
 * checking that the robust ones do not.
 *
 * `sigma` sets the unconditional standard deviation; alpha + beta must stay
 * below one for that to exist.
 */
export function garchSeries(n: number, alpha: number, beta: number, sigma: number, rng: Rng): Float64Array {
  if (alpha + beta >= 1) throw new Error("garch alpha + beta must be < 1 for a stationary variance");
  const omega = sigma * sigma * (1 - alpha - beta);
  const out = new Float64Array(n);
  let varT = sigma * sigma;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    varT = omega + alpha * prev * prev + beta * varT;
    prev = Math.sqrt(varT) * gaussian(rng);
    out[i] = prev;
  }
  return out;
}
