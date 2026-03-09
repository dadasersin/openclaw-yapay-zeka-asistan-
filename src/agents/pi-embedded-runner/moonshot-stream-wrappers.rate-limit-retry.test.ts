import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMoonshotRateLimitRetryWrapper } from "./moonshot-stream-wrappers.js";

const model = {
  id: "kimi-k2",
  name: "Kimi K2",
  api: "openai-completions",
  provider: "kimi-coding",
} as Model<"openai-completions">;

const context: Context = { messages: [] };

// Helper to build a 429-like error from Moonshot/Kimi API
function make429Error(retryAfterSeconds?: number): Error & {
  status: number;
  headers?: Record<string, string>;
} {
  return Object.assign(new Error("Too Many Requests"), {
    status: 429,
    headers: retryAfterSeconds != null ? { "retry-after": String(retryAfterSeconds) } : undefined,
  });
}

function makeStreamFn(results: Array<() => ReturnType<StreamFn>>): StreamFn {
  let call = 0;
  return vi.fn(() => results[call++]()) as StreamFn;
}

describe("createMoonshotRateLimitRetryWrapper", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("passes through on success", async () => {
    const inner = makeStreamFn([() => createAssistantMessageEventStream()]);
    const wrapped = createMoonshotRateLimitRetryWrapper(inner);
    await wrapped(model, context, {});
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 and succeeds on second attempt", async () => {
    vi.useFakeTimers();
    const inner = makeStreamFn([
      () => Promise.reject(make429Error()) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createMoonshotRateLimitRetryWrapper(inner);
    const resultPromise = wrapped(model, context, {});
    await vi.runAllTimersAsync();
    await resultPromise;
    expect(inner).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("retries up to KIMI_RATE_LIMIT_MAX_RETRIES (3) times then throws", async () => {
    vi.useFakeTimers();
    const error = make429Error();
    const reject = () => Promise.reject(error) as unknown as ReturnType<StreamFn>;
    const inner = makeStreamFn([reject, reject, reject, reject]);
    const wrapped = createMoonshotRateLimitRetryWrapper(inner);
    const resultPromise = wrapped(model, context, {});
    await vi.runAllTimersAsync();
    await expect(resultPromise).rejects.toBe(error);
    // 1 initial + 3 retries = 4 calls
    expect(inner).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it("retries when 429 is nested at err.response.status", async () => {
    vi.useFakeTimers();
    const err = Object.assign(new Error("Too Many Requests"), {
      response: { status: 429 },
    });
    const inner = makeStreamFn([
      () => Promise.reject(err) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createMoonshotRateLimitRetryWrapper(inner);
    const resultPromise = wrapped(model, context, {});
    await vi.runAllTimersAsync();
    await resultPromise;
    expect(inner).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does not retry non-429 errors", async () => {
    const error = Object.assign(new Error("Internal Server Error"), { status: 500 });
    const inner = makeStreamFn([() => Promise.reject(error) as unknown as ReturnType<StreamFn>]);
    const wrapped = createMoonshotRateLimitRetryWrapper(inner);
    await expect(wrapped(model, context, {})).rejects.toBe(error);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("honors delta-seconds Retry-After header over backoff", async () => {
    vi.useFakeTimers();
    const sleepSpy = vi.spyOn(await import("../../infra/backoff.js"), "sleepWithAbort");
    const inner = makeStreamFn([
      () => Promise.reject(make429Error(5)) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createMoonshotRateLimitRetryWrapper(inner);
    const resultPromise = wrapped(model, context, {});
    await vi.runAllTimersAsync();
    await resultPromise;
    // Should have slept for exactly 5000ms (from Retry-After: 5)
    expect(sleepSpy).toHaveBeenCalledWith(5_000, undefined);
    vi.useRealTimers();
  });

  it("honors HTTP-date Retry-After header over backoff", async () => {
    vi.useFakeTimers();
    const sleepSpy = vi.spyOn(await import("../../infra/backoff.js"), "sleepWithAbort");
    // Set fake system time so we can control Date.now()
    const now = new Date("2026-03-09T15:00:00.000Z");
    vi.setSystemTime(now);
    const retryAt = new Date("2026-03-09T15:00:10.000Z"); // 10s in the future
    const err = Object.assign(new Error("Too Many Requests"), {
      status: 429,
      headers: { "retry-after": retryAt.toUTCString() },
    });
    const inner = makeStreamFn([
      () => Promise.reject(err) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createMoonshotRateLimitRetryWrapper(inner);
    const resultPromise = wrapped(model, context, {});
    await vi.runAllTimersAsync();
    await resultPromise;
    // Should have slept for ~10000ms (time until the HTTP-date)
    expect(sleepSpy).toHaveBeenCalledWith(10_000, undefined);
    vi.useRealTimers();
  });

  it("falls back to backoff when Retry-After is an unparseable string", async () => {
    vi.useFakeTimers();
    const sleepSpy = vi.spyOn(await import("../../infra/backoff.js"), "sleepWithAbort");
    const err = Object.assign(new Error("Too Many Requests"), {
      status: 429,
      headers: { "retry-after": "not-a-valid-value" },
    });
    const inner = makeStreamFn([
      () => Promise.reject(err) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createMoonshotRateLimitRetryWrapper(inner);
    const resultPromise = wrapped(model, context, {});
    await vi.runAllTimersAsync();
    await resultPromise;
    // Should have used backoff (attempt=1 → initialMs=1000), not a parsed header value
    const calledMs = (sleepSpy.mock.calls[0] as [number, undefined])[0];
    expect(calledMs).toBeGreaterThanOrEqual(1_000);
    expect(calledMs).toBeLessThanOrEqual(1_200); // 1000 + up to 20% jitter
    vi.useRealTimers();
  });
});
