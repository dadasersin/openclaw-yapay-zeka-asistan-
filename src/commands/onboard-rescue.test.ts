import { describe, expect, it } from "vitest";
import {
  buildRescueWatchdogConfig,
  buildRescueWatchdogPrompt,
  canEnableRescueWatchdog,
  resolveMonitoredProfileName,
  resolveRescueGatewayPort,
  resolveRescueProfileName,
} from "./onboard-rescue.js";

describe("onboard rescue helpers", () => {
  it("normalizes monitored profile names", () => {
    expect(resolveMonitoredProfileName(undefined)).toBe("default");
    expect(resolveMonitoredProfileName("")).toBe("default");
    expect(resolveMonitoredProfileName("default")).toBe("default");
    expect(resolveMonitoredProfileName("work")).toBe("work");
  });

  it("rejects nested rescue profiles", () => {
    expect(canEnableRescueWatchdog("default")).toBe(true);
    expect(canEnableRescueWatchdog("work")).toBe(true);
    expect(canEnableRescueWatchdog("rescue")).toBe(false);
    expect(canEnableRescueWatchdog("work-rescue")).toBe(false);
  });

  it("derives stable rescue profile names and ports", () => {
    expect(resolveRescueProfileName("default")).toBe("rescue");
    expect(resolveRescueProfileName("work")).toBe("work-rescue");
    expect(resolveRescueGatewayPort(18_789)).toBe(19_789);
  });

  it("adds a stable hash suffix when long monitored profiles must be truncated", () => {
    const sharedPrefix = "a".repeat(57);
    const first = `${sharedPrefix}left`;
    const second = `${sharedPrefix}right`;

    const firstRescue = resolveRescueProfileName(first);
    const secondRescue = resolveRescueProfileName(second);

    expect(firstRescue).not.toBe(secondRescue);
    expect(firstRescue).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(secondRescue).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(firstRescue.endsWith("-rescue")).toBe(true);
    expect(secondRescue.endsWith("-rescue")).toBe(true);
  });

  it("rejects invalid monitored profile names before deriving rescue paths", () => {
    expect(() => resolveRescueProfileName("../work")).toThrow(
      'Invalid monitored profile "../work" (use letters, numbers, "_" or "-" only).',
    );
  });

  it("builds a rescue prompt that targets the monitored profile", () => {
    const prompt = buildRescueWatchdogPrompt("default");
    expect(prompt).toContain("openclaw --profile default gateway status --json");
    expect(prompt).toContain("openclaw --profile default gateway restart");
    expect(prompt).toContain("RESCUE_OK");
  });

  it("builds rescue config from source core settings without copying main channels", () => {
    const config = buildRescueWatchdogConfig({
      sourceConfig: {
        tools: { profile: "minimal" },
        env: {
          shellEnv: { enabled: true },
          vars: {
            OPENAI_API_KEY: "main-key",
          },
          OPENROUTER_BASE_URL: "https://router.example.test",
        },
        cron: { enabled: false },
        channels: {
          telegram: { botToken: "nope" },
        },
        web: {
          enabled: true,
        },
      },
      rescueWorkspace: "/tmp/workspace-rescue",
      rescuePort: 19_789,
      rescueToken: "rescue-token",
    });

    expect(config.gateway).toMatchObject({
      mode: "local",
      port: 19_789,
      bind: "loopback",
      auth: {
        mode: "token",
        token: "rescue-token",
      },
    });
    expect(config.tools?.profile).toBe("coding");
    expect(config.env).toEqual({
      shellEnv: { enabled: true },
      vars: {
        OPENAI_API_KEY: "main-key",
      },
      OPENROUTER_BASE_URL: "https://router.example.test",
    });
    expect(config.agents?.defaults?.workspace).toBe("/tmp/workspace-rescue");
    expect(config.agents?.defaults?.heartbeat?.every).toBe("0m");
    expect(config.cron).toBeUndefined();
    expect(config.channels).toBeUndefined();
    expect(config.web).toBeUndefined();
  });

  it("preserves existing rescue config when re-running onboarding", () => {
    const config = buildRescueWatchdogConfig({
      sourceConfig: {
        tools: { profile: "coding" },
        env: {
          shellEnv: { enabled: false, timeoutMs: 5_000 },
          vars: {
            OPENAI_API_KEY: "rotated-main-key",
          },
          OPENROUTER_BASE_URL: "https://router.example.test",
        },
      },
      existingRescueConfig: {
        cron: { enabled: false },
        channels: {
          telegram: { botToken: "keep-me" },
        },
        env: {
          shellEnv: { enabled: true, timeoutMs: 30_000 },
          vars: {
            OPENAI_API_KEY: "stale-rescue-key",
            RESCUE_ONLY_KEY: "keep-me",
          },
          RESCUE_ENDPOINT: "https://rescue.example.test",
        },
      },
      rescueWorkspace: "/tmp/workspace-rescue",
      rescuePort: 19_789,
      rescueToken: "rescue-token",
    });

    expect(config.channels).toEqual({
      telegram: { botToken: "keep-me" },
    });
    expect(config.env).toEqual({
      shellEnv: { enabled: false, timeoutMs: 5_000 },
      vars: {
        OPENAI_API_KEY: "rotated-main-key",
        RESCUE_ONLY_KEY: "keep-me",
      },
      OPENROUTER_BASE_URL: "https://router.example.test",
      RESCUE_ENDPOINT: "https://rescue.example.test",
    });
    expect(config.cron).toEqual({ enabled: false });
  });
});
