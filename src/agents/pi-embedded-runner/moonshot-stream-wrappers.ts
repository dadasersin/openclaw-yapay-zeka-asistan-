import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import { computeBackoff, sleepWithAbort, type BackoffPolicy } from "../../infra/backoff.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("moonshot-stream-wrappers");

// Moonshot/Kimi rate limit retry: honor Retry-After header when available,
// fall back to exponential backoff. Kimi's free tier has tight RPM limits.
const KIMI_RATE_LIMIT_MAX_RETRIES = 3;
const KIMI_RATE_LIMIT_BACKOFF: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 30_000,
  factor: 2,
  jitter: 0.2,
};

function getMoonshotRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  // Kimi's API does not currently send a Retry-After header on 429 responses.
  // This checks defensively in case they add it in the future, and falls back
  // to exponential backoff (see computeBackoff call in the retry wrapper).
  const headers =
    (err as { headers?: unknown }).headers ??
    (err as { response?: { headers?: unknown } }).response?.headers;
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  // Handle both Headers API (with .get()) and plain object
  const raw =
    typeof (headers as { get?: unknown }).get === "function"
      ? (headers as { get(name: string): string | null }).get("retry-after")
      : ((headers as Record<string, unknown>)["retry-after"] ??
        (headers as Record<string, unknown>)["Retry-After"]);
  if (typeof raw === "string") {
    const seconds = parseFloat(raw);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1_000;
    }
  }
  return undefined;
}

function isMoonshotRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const status =
    (err as { status?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode;
  return status === 429;
}

/**
 * Wraps a StreamFn with automatic retry on HTTP 429 responses from
 * Moonshot/Kimi APIs. Honors the Retry-After header when present; otherwise
 * uses exponential backoff with jitter.
 */
export function createMoonshotRateLimitRetryWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    let attempt = 0;
    const tryOnce = (): ReturnType<StreamFn> => {
      const result = underlying(model, context, options);
      // Attach retry logic if the result is a Promise (standard for pi-ai StreamFn)
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        return (result as Promise<unknown>).catch(async (err: unknown) => {
          if (!isMoonshotRateLimitError(err) || attempt >= KIMI_RATE_LIMIT_MAX_RETRIES) {
            throw err;
          }
          attempt += 1;
          const retryAfterMs =
            getMoonshotRetryAfterMs(err) ?? computeBackoff(KIMI_RATE_LIMIT_BACKOFF, attempt);
          log.warn(
            `moonshot/kimi rate limited (429), retry ${attempt}/${KIMI_RATE_LIMIT_MAX_RETRIES} after ${retryAfterMs}ms`,
          );
          // sleepWithAbort is best-effort here; StreamFn options don't expose
          // an abort signal, so we pass undefined and the outer abort will
          // cancel the awaiting Promise chain naturally.
          await sleepWithAbort(retryAfterMs, undefined);
          return tryOnce();
        }) as ReturnType<StreamFn>;
      }
      return result;
    };
    return tryOnce();
  };
}

type MoonshotThinkingType = "enabled" | "disabled";

function normalizeMoonshotThinkingType(value: unknown): MoonshotThinkingType | undefined {
  if (typeof value === "boolean") {
    return value ? "enabled" : "disabled";
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["enabled", "enable", "on", "true"].includes(normalized)) {
      return "enabled";
    }
    if (["disabled", "disable", "off", "false"].includes(normalized)) {
      return "disabled";
    }
    return undefined;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return normalizeMoonshotThinkingType((value as Record<string, unknown>).type);
  }
  return undefined;
}

function isMoonshotToolChoiceCompatible(toolChoice: unknown): boolean {
  if (toolChoice == null || toolChoice === "auto" || toolChoice === "none") {
    return true;
  }
  if (typeof toolChoice === "object" && !Array.isArray(toolChoice)) {
    const typeValue = (toolChoice as Record<string, unknown>).type;
    return typeValue === "auto" || typeValue === "none";
  }
  return false;
}

export function shouldApplySiliconFlowThinkingOffCompat(params: {
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkLevel;
}): boolean {
  return (
    params.provider === "siliconflow" &&
    params.thinkingLevel === "off" &&
    params.modelId.startsWith("Pro/")
  );
}

export function createSiliconFlowThinkingWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload, payloadModel) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          if (payloadObj.thinking === "off") {
            payloadObj.thinking = null;
          }
        }
        return originalOnPayload?.(payload, payloadModel);
      },
    });
  };
}

export function resolveMoonshotThinkingType(params: {
  configuredThinking: unknown;
  thinkingLevel?: ThinkLevel;
}): MoonshotThinkingType | undefined {
  const configured = normalizeMoonshotThinkingType(params.configuredThinking);
  if (configured) {
    return configured;
  }
  if (!params.thinkingLevel) {
    return undefined;
  }
  return params.thinkingLevel === "off" ? "disabled" : "enabled";
}

export function createMoonshotThinkingWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingType?: MoonshotThinkingType,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload, payloadModel) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          let effectiveThinkingType = normalizeMoonshotThinkingType(payloadObj.thinking);

          if (thinkingType) {
            payloadObj.thinking = { type: thinkingType };
            effectiveThinkingType = thinkingType;
          }

          if (
            effectiveThinkingType === "enabled" &&
            !isMoonshotToolChoiceCompatible(payloadObj.tool_choice)
          ) {
            payloadObj.tool_choice = "auto";
          }
        }
        return originalOnPayload?.(payload, payloadModel);
      },
    });
  };
}
