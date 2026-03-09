import type { Api, Model } from "@mariozechner/pi-ai";

function isOpenAiCompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}

/**
 * Returns true only for endpoints that are confirmed to be native OpenAI
 * infrastructure and therefore accept the `developer` message role.
 * Azure OpenAI uses the Chat Completions API and does NOT accept `developer`.
 * All other openai-completions backends (proxies, Qwen, GLM, DeepSeek, etc.)
 * only support the standard `system` role.
 */
function isOpenAINativeEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "api.openai.com";
  } catch {
    return false;
  }
}

/**
 * Returns true for OpenAI-compatible local inference servers that are known to
 * support the `stream_options: { include_usage: true }` parameter and return
 * a valid usage chunk at the end of the stream.
 *
 * These servers emit a final SSE chunk containing `usage` even while streaming,
 * so `supportsUsageInStreaming` should NOT be forced to false for them.
 *
 * Covered backends (non-exhaustive):
 *   - llama.cpp HTTP server  (http://*/v1, http://*/v1/chat/completions)
 *   - Ollama OpenAI-compat   (http://localhost:11434/v1)
 *   - vLLM                   (http://*/v1, supports include_usage per-chunk)
 *   - LMStudio               (http://localhost:1234/v1)
 *   - llamafile              (http://127.0.0.1:*/v1)
 *
 * Detection heuristic: private / loopback / link-local IPv4 or hostname-based
 * local addresses.  This is intentionally broad — false positives (a valid
 * remote proxy that happens to be on a private subnet) are acceptable: those
 * endpoints either support streaming usage or will silently ignore the flag.
 */
function isLocalInferenceEndpoint(baseUrl: string): boolean {
  if (!baseUrl) return false;
  try {
    const { hostname } = new URL(baseUrl);
    const h = hostname.toLowerCase();
    // loopback
    if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
    // RFC-1918 private ranges (covers typical home/lab NAS, DGX Spark, etc.)
    if (/^10\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    // link-local
    if (/^169\.254\./.test(h)) return true;
    // .local mDNS names (e.g. spark-38f8.local)
    if (h.endsWith(".local")) return true;
    return false;
  } catch {
    return false;
  }
}

function isAnthropicMessagesModel(model: Model<Api>): model is Model<"anthropic-messages"> {
  return model.api === "anthropic-messages";
}

/**
 * pi-ai constructs the Anthropic API endpoint as `${baseUrl}/v1/messages`.
 * If a user configures `baseUrl` with a trailing `/v1` (e.g. the previously
 * recommended format "https://api.anthropic.com/v1"), the resulting URL
 * becomes "…/v1/v1/messages" which the Anthropic API rejects with a 404.
 *
 * Strip a single trailing `/v1` (with optional trailing slash) from the
 * baseUrl for anthropic-messages models so users with either format work.
 */
function normalizeAnthropicBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}
export function normalizeModelCompat(model: Model<Api>): Model<Api> {
  const baseUrl = model.baseUrl ?? "";

  // Normalise anthropic-messages baseUrl: strip trailing /v1 that users may
  // have included in their config. pi-ai appends /v1/messages itself.
  if (isAnthropicMessagesModel(model) && baseUrl) {
    const normalised = normalizeAnthropicBaseUrl(baseUrl);
    if (normalised !== baseUrl) {
      return { ...model, baseUrl: normalised } as Model<"anthropic-messages">;
    }
  }

  if (!isOpenAiCompletionsModel(model)) {
    return model;
  }

  // The `developer` role and stream usage chunks are OpenAI-native behaviors.
  // Many OpenAI-compatible backends reject `developer` and/or emit usage-only
  // chunks that break strict parsers expecting choices[0]. For non-native
  // openai-completions endpoints, force both compat flags off.
  //
  // Exception: local inference servers (llama.cpp, Ollama, vLLM, LMStudio,
  // etc.) that run on private/loopback addresses DO support
  // `stream_options: { include_usage: true }` and return a valid usage chunk.
  // For those we only disable `supportsDeveloperRole` (they do not accept the
  // OpenAI `developer` system-message role) but leave `supportsUsageInStreaming`
  // at its configured value (default: true) so token counts are recorded.
  const compat = model.compat ?? undefined;
  // When baseUrl is empty the pi-ai library defaults to api.openai.com, so
  // leave compat unchanged and let default native behavior apply.
  const needsForce = baseUrl ? !isOpenAINativeEndpoint(baseUrl) : false;
  if (!needsForce) {
    return model;
  }

  // For local inference endpoints: only disable developer role, keep streaming usage.
  if (isLocalInferenceEndpoint(baseUrl)) {
    // Already has the right compat flags — nothing to do.
    if (compat?.supportsDeveloperRole === false) return model;
    return {
      ...model,
      compat: compat
        ? { ...compat, supportsDeveloperRole: false }
        : { supportsDeveloperRole: false },
    } as typeof model;
  }

  if (compat?.supportsDeveloperRole === false && compat?.supportsUsageInStreaming === false) {
    return model;
  }

  // Return a new object — do not mutate the caller's model reference.
  return {
    ...model,
    compat: compat
      ? { ...compat, supportsDeveloperRole: false, supportsUsageInStreaming: false }
      : { supportsDeveloperRole: false, supportsUsageInStreaming: false },
  } as typeof model;
}
