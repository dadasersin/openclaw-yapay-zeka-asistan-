import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureAuthProfileStore, saveAuthProfileStore } from "../agents/auth-profiles.js";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import { formatCliCommand } from "../cli/command-format.js";
import { isValidProfileName } from "../cli/profile-utils.js";
import { applyCliProfileEnv } from "../cli/profile.js";
import type { OpenClawConfig } from "../config/config.js";
import { createConfigIO } from "../config/io.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions.js";
import type { ToolProfileId } from "../config/types.tools.js";
import { resolveGatewayService } from "../daemon/service.js";
import { callGateway } from "../gateway/call.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { buildGatewayInstallPlan, gatewayInstallErrorHint } from "./daemon-install-helpers.js";
import { DEFAULT_GATEWAY_DAEMON_RUNTIME, type GatewayDaemonRuntime } from "./daemon-runtime.js";
import { resolveGatewayInstallToken } from "./gateway-install-token.js";
import { randomToken, waitForGatewayReachable } from "./onboard-helpers.js";

const RESCUE_JOB_NAME_PREFIX = "Rescue watchdog";
const RESCUE_PROFILE_SUFFIX = "-rescue";
const PROFILE_NAME_MAX_LENGTH = 64;
const TRUNCATED_RESCUE_HASH_LENGTH = 8;
const DEFAULT_RESCUE_INTERVAL_MS = 5 * 60_000;
const RESCUE_AGENT_TIMEOUT_SECONDS = 120;
const RESCUE_ENV_ALLOWLIST = [
  "APPDATA",
  "ASDF_DATA_DIR",
  "BUN_INSTALL",
  "COMSPEC",
  "FNM_DIR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "NPM_CONFIG_PREFIX",
  "OPENCLAW_HOME",
  "PATH",
  "PATHEXT",
  "PNPM_HOME",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "VOLTA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
] as const;

type RescueCronListResponse = {
  jobs?: Array<{ id?: string; name?: string }>;
};

export type RescueWatchdogSetupResult = {
  enabled: boolean;
  monitoredProfile: string;
  rescueProfile: string;
  rescuePort: number;
  rescueWorkspace: string;
  cronJobId?: string;
  cronAction?: "created" | "updated";
};

export function resolveMonitoredProfileName(raw = process.env.OPENCLAW_PROFILE): string {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed.toLowerCase() === "default") {
    return "default";
  }
  return trimmed;
}

function assertValidMonitoredProfileName(raw?: string): string {
  const monitoredProfile = resolveMonitoredProfileName(raw);
  if (monitoredProfile !== "default" && !isValidProfileName(monitoredProfile)) {
    throw new Error(
      `Invalid monitored profile "${monitoredProfile}" (use letters, numbers, "_" or "-" only).`,
    );
  }
  return monitoredProfile;
}

export function canEnableRescueWatchdog(monitoredProfile: string): boolean {
  const normalized = resolveMonitoredProfileName(monitoredProfile).toLowerCase();
  return normalized !== "rescue" && !normalized.endsWith(RESCUE_PROFILE_SUFFIX);
}

export function resolveRescueProfileName(monitoredProfile: string): string {
  const normalized = assertValidMonitoredProfileName(monitoredProfile);
  if (normalized === "default") {
    return "rescue";
  }
  const maxBaseLength = PROFILE_NAME_MAX_LENGTH - RESCUE_PROFILE_SUFFIX.length;
  if (normalized.length <= maxBaseLength) {
    return `${normalized}${RESCUE_PROFILE_SUFFIX}`;
  }
  // Long monitored profiles need a stable disambiguator so rescue state does not
  // collide when multiple valid profile names share the same truncated prefix.
  const hashSuffix = `-${createHash("sha256").update(normalized).digest("hex").slice(0, TRUNCATED_RESCUE_HASH_LENGTH)}`;
  const hashedBaseLength =
    PROFILE_NAME_MAX_LENGTH - RESCUE_PROFILE_SUFFIX.length - hashSuffix.length;
  const base = normalized.slice(0, Math.max(1, hashedBaseLength));
  return `${base}${hashSuffix}${RESCUE_PROFILE_SUFFIX}`;
}

export function resolveRescueGatewayPort(mainPort: number): number {
  const preferred = mainPort + 1000;
  if (preferred <= 65_535) {
    return preferred;
  }
  const fallback = mainPort + 20;
  if (fallback <= 65_535) {
    return fallback;
  }
  return Math.max(1024, mainPort - 1000);
}

function resolveRescueWorkspace(mainWorkspace: string): string {
  return `${resolveUserPath(mainWorkspace)}${RESCUE_PROFILE_SUFFIX}`;
}

function resolveRescueGatewayToken(existingConfig: OpenClawConfig | undefined): string {
  const existing = existingConfig?.gateway?.auth?.token;
  if (typeof existing === "string" && existing.trim()) {
    return existing.trim();
  }
  return `rescue-${randomToken()}`;
}

function resolveRescueToolProfile(sourceProfile: unknown, existingProfile: unknown): ToolProfileId {
  const candidate =
    typeof sourceProfile === "string" && sourceProfile.trim()
      ? sourceProfile.trim()
      : typeof existingProfile === "string" && existingProfile.trim()
        ? existingProfile.trim()
        : "";
  if (candidate === "full" || candidate === "coding") {
    return candidate;
  }
  return "coding";
}

function normalizeServiceEnvironment(environment?: Record<string, string | undefined>) {
  return Object.entries(environment ?? {})
    .filter(([, value]) => value !== undefined)
    .toSorted(([left], [right]) => left.localeCompare(right));
}

function serviceCommandMatchesPlan(params: {
  current: {
    programArguments: string[];
    workingDirectory?: string;
    environment?: Record<string, string>;
  } | null;
  expected: {
    programArguments: string[];
    workingDirectory?: string;
    environment?: Record<string, string | undefined>;
  };
}) {
  if (!params.current) {
    return false;
  }
  const expectedEnvironment = Object.fromEntries(
    Object.entries(params.expected.environment ?? {}).filter(([, value]) => value !== undefined),
  );
  return (
    JSON.stringify(params.current.programArguments) ===
      JSON.stringify(params.expected.programArguments) &&
    (params.current.workingDirectory ?? "") === (params.expected.workingDirectory ?? "") &&
    JSON.stringify(normalizeServiceEnvironment(params.current.environment)) ===
      JSON.stringify(normalizeServiceEnvironment(expectedEnvironment))
  );
}

export function buildRescueWatchdogPrompt(monitoredProfile: string): string {
  const profileFlag = `--profile ${resolveMonitoredProfileName(monitoredProfile)}`;
  const statusCommand = `openclaw ${profileFlag} gateway status --json`;
  const probeCommand = `openclaw ${profileFlag} gateway probe --json`;
  const restartCommand = `openclaw ${profileFlag} gateway restart`;
  const doctorCommand = `openclaw ${profileFlag} doctor --repair --non-interactive`;
  return [
    `Monitor the OpenClaw profile "${resolveMonitoredProfileName(monitoredProfile)}" and repair it when needed.`,
    `Run \`${statusCommand}\` first.`,
    `Run \`${probeCommand}\` next.`,
    `If status/probe shows the gateway is down, unhealthy, or unreachable, run \`${restartCommand}\`.`,
    `If restart fails or service/config drift blocks recovery, run \`${doctorCommand}\` once and then probe again.`,
    "Never modify or restart the rescue profile itself.",
    "If nothing needed repair, reply exactly RESCUE_OK.",
    "If you took action, reply with one short sentence describing what you changed and whether the final probe succeeded.",
  ].join(" ");
}

export function buildRescueWatchdogConfig(params: {
  sourceConfig: OpenClawConfig;
  existingRescueConfig?: OpenClawConfig;
  rescueWorkspace: string;
  rescuePort: number;
  rescueToken: string;
}): OpenClawConfig {
  const { sourceConfig, existingRescueConfig, rescueWorkspace, rescuePort, rescueToken } = params;
  const existing = existingRescueConfig ?? {};
  return {
    ...existing,
    agents: {
      ...existing.agents,
      defaults: {
        ...sourceConfig.agents?.defaults,
        ...existing.agents?.defaults,
        workspace: rescueWorkspace,
        heartbeat: {
          ...sourceConfig.agents?.defaults?.heartbeat,
          ...existing.agents?.defaults?.heartbeat,
          every: "0m",
        },
      },
    },
    auth: sourceConfig.auth ?? existing.auth,
    // Keep rescue scheduler settings if they already exist, but do not copy the
    // primary profile's cron settings or stored jobs into a fresh rescue profile.
    cron: existing.cron,
    models: sourceConfig.models ?? existing.models,
    secrets: sourceConfig.secrets ?? existing.secrets,
    skills: sourceConfig.skills ?? existing.skills,
    tools: {
      ...sourceConfig.tools,
      ...existing.tools,
      profile: resolveRescueToolProfile(sourceConfig.tools?.profile, existing.tools?.profile),
    },
    gateway: {
      ...existing.gateway,
      mode: "local",
      port: rescuePort,
      bind: "loopback",
      remote: undefined,
      tailscale: {
        mode: "off",
        resetOnExit: false,
      },
      tls: undefined,
      auth: {
        mode: "token",
        token: rescueToken,
      },
    },
    wizard: existing.wizard,
  };
}

async function loadExistingRescueConfig(
  env: NodeJS.ProcessEnv,
): Promise<OpenClawConfig | undefined> {
  const io = createConfigIO({ env });
  try {
    return io.loadConfig();
  } catch {
    return undefined;
  }
}

function buildRescueEnv(profile: string): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const key of RESCUE_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
  applyCliProfileEnv({ profile, env });
  return env as NodeJS.ProcessEnv;
}

async function syncRescueAuthProfiles(params: { rescueEnv: NodeJS.ProcessEnv }) {
  const rescueStateDir = params.rescueEnv.OPENCLAW_STATE_DIR?.trim();
  if (!rescueStateDir) {
    throw new Error("Rescue watchdog setup failed: rescue profile state dir was not resolved.");
  }
  const rescueAgentDir = path.join(rescueStateDir, "agents", DEFAULT_AGENT_ID, "agent");
  await fs.mkdir(rescueAgentDir, { recursive: true });
  // Load from the rescue agent dir so existing rescue-only credentials survive,
  // while the main profile store is still inherited/merged in by auth-profile loading.
  const store = ensureAuthProfileStore(rescueAgentDir, { allowKeychainPrompt: false });
  saveAuthProfileStore(store, rescueAgentDir);
}

async function ensureRescueWorkspace(params: {
  rescueWorkspace: string;
  rescueEnv: NodeJS.ProcessEnv;
  note?: (message: string, title?: string) => Promise<void>;
}) {
  const workspace = await ensureAgentWorkspace({
    dir: params.rescueWorkspace,
    ensureBootstrapFiles: true,
  });
  const sessionsDir = resolveSessionTranscriptsDirForAgent(DEFAULT_AGENT_ID, params.rescueEnv);
  await fs.mkdir(sessionsDir, { recursive: true });
  await params.note?.(
    [`Workspace: ${workspace.dir}`, `Sessions: ${sessionsDir}`].join("\n"),
    "Rescue watchdog",
  );
}

async function ensureRescueCronJob(params: {
  rescuePort: number;
  rescueToken: string;
  monitoredProfile: string;
}): Promise<{ cronJobId?: string; cronAction?: "created" | "updated" }> {
  const wsUrl = `ws://127.0.0.1:${params.rescuePort}`;
  const name = `${RESCUE_JOB_NAME_PREFIX} (${resolveMonitoredProfileName(params.monitoredProfile)})`;
  const prompt = buildRescueWatchdogPrompt(params.monitoredProfile);
  const page = await callGateway<RescueCronListResponse>({
    url: wsUrl,
    token: params.rescueToken,
    method: "cron.list",
    params: {
      includeDisabled: true,
      limit: 100,
      query: name,
    },
  });
  const existing = page.jobs?.find((job) => job.name === name);
  const payload = {
    name,
    description:
      "Auto-restarts the primary OpenClaw profile when the main gateway becomes unhealthy.",
    enabled: true,
    schedule: {
      kind: "every",
      everyMs: DEFAULT_RESCUE_INTERVAL_MS,
    },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "agentTurn",
      message: prompt,
      timeoutSeconds: RESCUE_AGENT_TIMEOUT_SECONDS,
      deliver: false,
      lightContext: true,
    },
    delivery: {
      mode: "none",
    },
  };

  if (existing?.id) {
    await callGateway({
      url: wsUrl,
      token: params.rescueToken,
      method: "cron.update",
      params: {
        id: existing.id,
        patch: payload,
      },
    });
    return { cronJobId: existing.id, cronAction: "updated" };
  }

  const created = await callGateway<{ id?: string }>({
    url: wsUrl,
    token: params.rescueToken,
    method: "cron.add",
    params: payload,
  });
  return { cronJobId: created.id, cronAction: "created" };
}

export async function setupRescueWatchdog(params: {
  sourceConfig: OpenClawConfig;
  workspaceDir: string;
  mainPort: number;
  monitoredProfile?: string;
  runtime: GatewayDaemonRuntime;
  output: {
    log: (message: string) => void;
    note?: (message: string, title?: string) => Promise<void>;
  };
}): Promise<RescueWatchdogSetupResult> {
  const monitoredProfile = assertValidMonitoredProfileName(params.monitoredProfile);
  if (!canEnableRescueWatchdog(monitoredProfile)) {
    throw new Error(
      `Rescue watchdog is not supported while onboarding the "${monitoredProfile}" profile.`,
    );
  }

  const rescueProfile = resolveRescueProfileName(monitoredProfile);
  const rescueEnv = buildRescueEnv(rescueProfile);
  const rescuePort = resolveRescueGatewayPort(params.mainPort);
  const rescueWorkspace = resolveRescueWorkspace(params.workspaceDir);
  const existingRescueConfig = await loadExistingRescueConfig(rescueEnv);
  const rescueToken = resolveRescueGatewayToken(existingRescueConfig);
  const rescueConfig = buildRescueWatchdogConfig({
    sourceConfig: params.sourceConfig,
    existingRescueConfig,
    rescueWorkspace,
    rescuePort,
    rescueToken,
  });

  const rescueIo = createConfigIO({ env: rescueEnv });
  await rescueIo.writeConfigFile(rescueConfig);
  await ensureRescueWorkspace({
    rescueWorkspace,
    rescueEnv,
    note: params.output.note,
  });
  await syncRescueAuthProfiles({ rescueEnv });

  const tokenResolution = await resolveGatewayInstallToken({
    config: rescueConfig,
    env: rescueEnv,
  });
  for (const warning of tokenResolution.warnings) {
    params.output.log(warning);
  }
  if (tokenResolution.unavailableReason) {
    throw new Error(tokenResolution.unavailableReason);
  }

  const expectedInstallPlan = await buildGatewayInstallPlan({
    env: rescueEnv,
    port: rescuePort,
    runtime: params.runtime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME,
    warn: (message) => params.output.log(message),
    config: rescueConfig,
  });

  const service = resolveGatewayService();
  const loaded = await service.isLoaded({ env: rescueEnv });
  if (!loaded) {
    try {
      await service.install({
        env: rescueEnv,
        stdout: process.stdout,
        programArguments: expectedInstallPlan.programArguments,
        workingDirectory: expectedInstallPlan.workingDirectory,
        environment: expectedInstallPlan.environment,
      });
    } catch (error) {
      throw new Error(
        `Rescue gateway install failed: ${error instanceof Error ? error.message : String(error)}\n${gatewayInstallErrorHint()}`,
        { cause: error },
      );
    }
  } else {
    const currentCommand = await service.readCommand(rescueEnv).catch(() => null);
    const needsReinstall = !serviceCommandMatchesPlan({
      current: currentCommand,
      expected: expectedInstallPlan,
    });
    if (needsReinstall) {
      try {
        await service.install({
          env: rescueEnv,
          stdout: process.stdout,
          programArguments: expectedInstallPlan.programArguments,
          workingDirectory: expectedInstallPlan.workingDirectory,
          environment: expectedInstallPlan.environment,
        });
      } catch (error) {
        throw new Error(
          `Rescue gateway update failed: ${error instanceof Error ? error.message : String(error)}\n${gatewayInstallErrorHint()}`,
          { cause: error },
        );
      }
    } else {
      await service.restart({
        env: rescueEnv,
        stdout: process.stdout,
      });
    }
  }

  await waitForGatewayReachable({
    url: `ws://127.0.0.1:${rescuePort}`,
    token: rescueToken,
    deadlineMs: 15_000,
  });
  const cron = await ensureRescueCronJob({
    rescuePort,
    rescueToken,
    monitoredProfile,
  });

  await params.output.note?.(
    [
      `Primary profile: ${monitoredProfile}`,
      `Rescue profile: ${rescueProfile}`,
      `Gateway port: ${rescuePort}`,
      `Inspect: ${formatCliCommand(`openclaw --profile ${rescueProfile} gateway status`)}`,
      `Cron runs: ${formatCliCommand(`openclaw --profile ${rescueProfile} cron runs --id ${cron.cronJobId ?? "<jobId>"}`)}`,
    ].join("\n"),
    "Rescue watchdog",
  );

  return {
    enabled: true,
    monitoredProfile,
    rescueProfile,
    rescuePort,
    rescueWorkspace,
    ...cron,
  };
}
