import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
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

  it("does not retry non-429 errors", async () => {
    const error = Object.assign(new Error("Internal Server Error"), { status: 500 });
    const inner = makeStreamFn([() => Promise.reject(error) as unknown as ReturnType<StreamFn>]);
    const wrapped = createMoonshotRateLimitRetryWrapper(inner);
    await expect(wrapped(model, context, {})).rejects.toBe(error);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("honors Retry-After header over backoff", async () => {
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
});
