import { RequestClient } from "@buape/carbon";
import { loadConfig } from "../config/config.js";
import { createDiscordRetryRunner, type RetryRunner } from "../infra/retry-policy.js";
import type { RetryConfig } from "../infra/retry.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { mergeDiscordAccountConfig, type ResolvedDiscordAccount } from "./accounts.js";
import { normalizeDiscordToken, resolveDiscordToken } from "./token.js";

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

function resolveRest(token: string, rest?: RequestClient) {
  return rest ?? new RequestClient(token);
}

function resolveDiscordClientAccountContext(
  cfg: ReturnType<typeof loadConfig>,
  accountIdInput?: string,
): Omit<ResolvedDiscordAccount, "token" | "tokenSource"> {
  const accountId = normalizeAccountId(accountIdInput);
  const config = mergeDiscordAccountConfig(cfg, accountId);
  const enabled = cfg.channels?.discord?.enabled !== false && config.enabled !== false;
  return {
    accountId,
    enabled,
    name: config.name?.trim() || undefined,
    config,
  };
}

export function createDiscordRestClient(opts: DiscordClientOpts, cfg = loadConfig()) {
  const account = resolveDiscordClientAccountContext(cfg, opts.accountId);
  const explicit = normalizeDiscordToken(opts.token, "channels.discord.token");
  const fallbackToken = explicit
    ? undefined
    : resolveDiscordToken(cfg, { accountId: account.accountId }).token;
  const token = resolveToken({
    explicit,
    accountId: account.accountId,
    fallbackToken,
  });
  const rest = resolveRest(token, opts.rest);
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
