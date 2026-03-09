import { applyCliProfileEnv } from "../cli/profile.js";

export const RESCUE_WATCHDOG_AGENT_ID = "rescue-watchdog";
export const DEFAULT_RESCUE_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_RESCUE_TIMEOUT_SECONDS = 120;
const RESCUE_PROFILE_SUFFIX = "-rescue";

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
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
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

export function resolveMonitoredProfileName(raw = process.env.OPENCLAW_PROFILE): string {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed.toLowerCase() === "default") {
    return "default";
  }
  return trimmed;
}

export function canEnableRescueWatchdog(monitoredProfile: string): boolean {
  const normalized = resolveMonitoredProfileName(monitoredProfile).toLowerCase();
  return normalized !== "rescue" && !normalized.endsWith(RESCUE_PROFILE_SUFFIX);
}

export function buildRescueProfileEnv(
  profile: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const key of RESCUE_ENV_ALLOWLIST) {
    const value = baseEnv[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
  applyCliProfileEnv({ profile, env });
  return env as NodeJS.ProcessEnv;
}
