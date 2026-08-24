/**
 * HTTP helpers shared by the Binance archive downloader and the Bybit REST
 * client: bounded retries with exponential backoff, `Retry-After` handling and
 * a request spacer for the per-IP rate limit.
 *
 * Everything external is injectable (`fetchImpl`, `sleep`, `now`, `jitter`) so
 * the tests never touch the network or the clock.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type SleepLike = (ms: number) => Promise<void>;

export interface RetryInfo {
  url: string;
  attempt: number;
  delayMs: number;
  status?: number;
  error?: unknown;
}

export interface HttpOptions {
  fetchImpl?: FetchLike;
  sleep?: SleepLike;
  now?: () => number;
  jitter?: () => number;
  /** Retries after the first attempt. 4 means up to 5 requests in total. */
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onRetry?: (info: RetryInfo) => void;
  headers?: Record<string, string>;
}

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;

  constructor(status: number, url: string, body = "") {
    super(`HTTP ${status} for ${url}${body ? `: ${body.slice(0, 200)}` : ""}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export function isNotFound(err: unknown): boolean {
  return err instanceof HttpError && err.status === 404;
}

export const defaultSleep: SleepLike = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  return null;
}

export function backoffDelay(attempt: number, base: number, max: number, jitter: number): number {
  const exp = Math.min(max, base * Math.pow(2, attempt));
  return Math.round(exp * (0.5 + 0.5 * jitter));
}

/**
 * Spaces calls so the caller never exceeds `rps`. Bybit allows 600 requests per
 * 5 seconds per IP; we run an order of magnitude below that because being
 * throttled costs far more than being slow.
 */
export function createRateLimiter(rps: number, opts: { sleep?: SleepLike; now?: () => number } = {}) {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const interval = rps > 0 ? 1000 / rps : 0;
  let nextAt = 0;
  let queue: Promise<void> = Promise.resolve();

  return function acquire(): Promise<void> {
    const task = queue.then(async () => {
      const t = now();
      const wait = Math.max(0, nextAt - t);
      if (wait > 0) await sleep(wait);
      nextAt = Math.max(t, nextAt) + interval;
    });
    queue = task.catch(() => undefined);
    return task;
  };
}

function combineSignals(timeoutMs: number, external?: AbortSignal): AbortSignal | undefined {
  const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  if (timeout && external) return AbortSignal.any([timeout, external]);
  return timeout ?? external;
}

export async function fetchWithRetry(url: string, opts: HttpOptions = {}): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const jitter = opts.jitter ?? Math.random;
  const retries = opts.retries ?? 4;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 20_000;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: opts.headers,
        signal: combineSignals(timeoutMs, opts.signal),
      });
      if (res.ok) return res;

      const body = await safeText(res);
      if (!isRetryableStatus(res.status) || attempt === retries) {
        throw new HttpError(res.status, url, body);
      }
      const retryAfter = parseRetryAfter(res.headers?.get?.("retry-after") ?? null, now());
      const delay = retryAfter ?? backoffDelay(attempt, base, max, jitter());
      opts.onRetry?.({ url, attempt: attempt + 1, delayMs: delay, status: res.status });
      await sleep(delay);
      lastError = new HttpError(res.status, url, body);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (opts.signal?.aborted) throw err;
      if (attempt === retries) throw err;
      const delay = backoffDelay(attempt, base, max, jitter());
      opts.onRetry?.({ url, attempt: attempt + 1, delayMs: delay, error: err });
      await sleep(delay);
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`request failed: ${url}`);
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

export async function fetchBuffer(url: string, opts: HttpOptions = {}): Promise<Buffer> {
  const res = await fetchWithRetry(url, opts);
  return Buffer.from(await res.arrayBuffer());
}

export async function fetchText(url: string, opts: HttpOptions = {}): Promise<string> {
  const res = await fetchWithRetry(url, opts);
  return res.text();
}

export async function fetchJson<T>(url: string, opts: HttpOptions = {}): Promise<T> {
  const res = await fetchWithRetry(url, opts);
  return (await res.json()) as T;
}
