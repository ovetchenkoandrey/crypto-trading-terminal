import { describe, expect, it, vi } from "vitest";
import {
  HttpError,
  backoffDelay,
  createRateLimiter,
  fetchBuffer,
  fetchJson,
  fetchWithRetry,
  isNotFound,
  isRetryableStatus,
  parseRetryAfter,
} from "./http.ts";

function res(status: number, body = "", headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
    arrayBuffer: async () => Uint8Array.from(Buffer.from(body, "utf8")).buffer,
  } as unknown as Response;
}

const noTimeout = { timeoutMs: 0, baseDelayMs: 10, jitter: () => 1 };

describe("http retry", () => {
  it("returns the first successful response without sleeping", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => res(200, "ok"));
    const out = await fetchWithRetry("https://x/a", { ...noTimeout, fetchImpl, sleep });
    expect(await out.text()).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a 429 and honours Retry-After", async () => {
    const sleep = vi.fn(async () => undefined);
    const onRetry = vi.fn();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return calls === 1 ? res(429, "slow down", { "retry-after": "3" }) : res(200, "fine");
    });
    const out = await fetchWithRetry("https://x/a", { ...noTimeout, fetchImpl, sleep, onRetry });
    expect(await out.text()).toBe("fine");
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0].status).toBe(429);
  });

  it("retries 5xx with growing backoff and gives up after the budget", async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });
    const fetchImpl = vi.fn(async () => res(503, "down"));
    await expect(
      fetchWithRetry("https://x/a", { ...noTimeout, fetchImpl, sleep, retries: 3 }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([10, 20, 40]);
  });

  it("does not retry a 404 and marks it as not-found", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => res(404, "nope"));
    const err = await fetchWithRetry("https://x/a", { ...noTimeout, fetchImpl, sleep }).catch((e) => e);
    expect(isNotFound(err)).toBe(true);
    expect((err as HttpError).status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries network errors, not just HTTP statuses", async () => {
    const sleep = vi.fn(async () => undefined);
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error("ECONNRESET");
      return res(200, "recovered");
    });
    const out = await fetchWithRetry("https://x/a", { ...noTimeout, fetchImpl, sleep });
    expect(await out.text()).toBe("recovered");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("gives up on a network error once the budget is spent", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    });
    await expect(
      fetchWithRetry("https://x/a", { ...noTimeout, fetchImpl, sleep: async () => undefined, retries: 2 }),
    ).rejects.toThrow(/ENOTFOUND/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("decodes buffers and json through the same retry path", async () => {
    const fetchImpl = vi.fn(async (url: string) => (url.endsWith("json") ? res(200, '{"a":1}') : res(200, "bytes")));
    expect((await fetchBuffer("https://x/bin", { ...noTimeout, fetchImpl })).toString("utf8")).toBe("bytes");
    expect(await fetchJson<{ a: number }>("https://x/json", { ...noTimeout, fetchImpl })).toEqual({ a: 1 });
  });
});

describe("http helpers", () => {
  it("classifies retryable statuses", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(400)).toBe(false);
  });

  it("parses Retry-After as seconds or as a date", () => {
    expect(parseRetryAfter("5", 0)).toBe(5000);
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter("garbage", 0)).toBeNull();
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:10 GMT", now)).toBe(10000);
  });

  it("caps exponential backoff", () => {
    expect(backoffDelay(0, 500, 20000, 1)).toBe(500);
    expect(backoffDelay(3, 500, 20000, 1)).toBe(4000);
    expect(backoffDelay(10, 500, 20000, 1)).toBe(20000);
    expect(backoffDelay(0, 500, 20000, 0)).toBe(250);
  });
});

describe("rate limiter", () => {
  it("spaces calls to the configured rate", async () => {
    let clock = 0;
    const waits: number[] = [];
    const acquire = createRateLimiter(4, {
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    await acquire();
    await acquire();
    await acquire();
    expect(waits).toEqual([250, 250]);
  });

  it("does not sleep when calls are already far apart", async () => {
    let clock = 0;
    const waits: number[] = [];
    const acquire = createRateLimiter(4, {
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await acquire();
    clock += 5000;
    await acquire();
    expect(waits).toEqual([]);
  });
});
