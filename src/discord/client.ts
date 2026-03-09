import { RequestClient } from "@buape/carbon";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { loadConfig } from "../config/config.js";
import { danger } from "../globals.js";
import { createDiscordRetryRunner, type RetryRunner } from "../infra/retry-policy.js";
import type { RetryConfig } from "../infra/retry.js";
import { resolveDiscordAccount } from "./accounts.js";
import { normalizeDiscordToken } from "./token.js";

export type DiscordClientOpts = {
  token?: string;
  accountId?: string;
  rest?: RequestClient;
  retry?: RetryConfig;
  verbose?: boolean;
};

function resolveToken(params: { explicit?: string; accountId: string; fallbackToken?: string }) {
  const explicit = normalizeDiscordToken(params.explicit, "channels.discord.token");
  if (explicit) {
    return explicit;
  }
  const fallback = normalizeDiscordToken(params.fallbackToken, "channels.discord.token");
  if (!fallback) {
    throw new Error(
      `Discord bot token missing for account "${params.accountId}" (set discord.accounts.${params.accountId}.token or DISCORD_BOT_TOKEN for default).`,
    );
  }
  return fallback;
}

/**
 * Install a proxied globalThis.fetch so that RequestClient (which uses
 * globalThis.fetch internally) routes all HTTP through the proxy.
 *
 * Carbon's RequestClient calls bare `fetch()` with no way to inject a
 * custom implementation, so overriding globalThis.fetch is the only
 * viable approach. The override is installed **once** (idempotent) for
 * the lifetime of the process. If a later call specifies a different
 * proxy URL, a warning is logged — mixing per-account proxies is not
 * supported with this strategy.
 */
let _installedProxy: string | undefined;

function installProxyFetch(proxyUrl?: string): void {
  const proxy = proxyUrl?.trim();
  if (!proxy) {
    return;
  }
  if (_installedProxy) {
    if (_installedProxy !== proxy) {
      console.warn(
        danger(
          `discord: proxy already installed (${_installedProxy}); ignoring different proxy ${proxy}. ` +
            "Carbon RequestClient does not support per-instance fetch — only one process-wide proxy is possible.",
        ),
      );
    }
    return;
  }
  try {
    const agent = new ProxyAgent(proxy);
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      undiciFetch(input as string | URL, {
        ...(init as Record<string, unknown>),
        dispatcher: agent,
      }) as unknown as Promise<Response>) as typeof fetch;
    _installedProxy = proxy;
  } catch (err) {
    console.warn(danger(`discord: failed to create rest proxy agent: ${String(err)}`));
  }
}

function resolveRest(token: string, proxy?: string, rest?: RequestClient) {
  if (rest) {
    return rest;
  }
  installProxyFetch(proxy);
  return new RequestClient(token);
}

export function createDiscordRestClient(opts: DiscordClientOpts, cfg = loadConfig()) {
  const account = resolveDiscordAccount({ cfg, accountId: opts.accountId });
  const token = resolveToken({
    explicit: opts.token,
    accountId: account.accountId,
    fallbackToken: account.token,
  });
  const rest = resolveRest(token, account.config.proxy, opts.rest);
  return { token, rest, account };
}

export function createDiscordClient(
  opts: DiscordClientOpts,
  cfg = loadConfig(),
): { token: string; rest: RequestClient; request: RetryRunner } {
  const { token, rest, account } = createDiscordRestClient(opts, cfg);
  const request = createDiscordRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
  });
  return { token, rest, request };
}

export function resolveDiscordRest(opts: DiscordClientOpts) {
  return createDiscordRestClient(opts).rest;
}
