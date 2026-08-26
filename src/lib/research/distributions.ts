/**
 * Tail probabilities for the normal and chi-square distributions.
 *
 * The point of this file is accuracy in the far tail. On a million bars a
 * z-score of 12 is routine, and an approximation with absolute error 1e-7
 * reports p = 0 for everything past z = 5.5 — which destroys the only thing
 * that separates "significant" from "significant and large". The Chebyshev
 * erfc below carries a *fractional* error under 1.2e-7 everywhere, so p-values
 * stay meaningful down to the denormal floor.
 */

/** Complementary error function; fractional error < 1.2e-7 for all x. */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + z / 2);
  const poly =
    -1.26551223 +
    t *
      (1.00002368 +
        t *
          (0.37409196 +
            t *
              (0.09678418 +
                t *
                  (-0.18628806 +
                    t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))));
  const ans = t * Math.exp(-z * z + poly);
  return x >= 0 ? ans : 2 - ans;
}

export function erf(x: number): number {
  return 1 - erfc(x);
}

/** P(Z <= z). */
export function normalCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2);
}

/** P(Z > z). Stays accurate where `1 - normalCdf` would round to zero. */
export function normalSf(z: number): number {
  return 0.5 * erfc(z / Math.SQRT2);
}

/** Two-sided p-value for a standard-normal statistic. */
export function twoSidedP(z: number): number {
  if (!Number.isFinite(z)) return Number.NaN;
  return Math.min(1, 2 * normalSf(Math.abs(z)));
}

/** Inverse of `normalCdf`; Acklam's rational approximation refined by Halley. */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  let x: number;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const e = normalCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

function logGamma(x: number): number {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += cof[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Regularised lower incomplete gamma P(a, x) via its series expansion. */
function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  let ap = a;
  let sum = 1 / a;
  let del = sum;
  for (let n = 0; n < 1000; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

/** Regularised upper incomplete gamma Q(a, x) via the Lentz continued fraction. */
function gammaQ(a: number, x: number): number {
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** P(chi2_df > x). */
export function chiSquareSf(x: number, df: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(df) || df <= 0) return Number.NaN;
  if (x <= 0) return 1;
  const a = df / 2;
  const z = x / 2;
  return z < a + 1 ? 1 - gammaP(a, z) : gammaQ(a, z);
}
