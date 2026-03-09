import { describe, expect, it } from "vitest";
import { buildRescueProfileEnv, canEnableRescueWatchdog } from "./watchdog-shared.js";

describe("buildRescueProfileEnv", () => {
  it("preserves explicit state/config path overrides from the monitored profile env", () => {
    const env = buildRescueProfileEnv("work", {
      OPENCLAW_STATE_DIR: "/data/openclaw",
      OPENCLAW_CONFIG_PATH: "/data/openclaw/custom.json",
      OPENCLAW_HOME: "/srv/openclaw-home",
      HOME: "/home/tester",
    });

    expect(env.OPENCLAW_PROFILE).toBe("work");
    expect(env.OPENCLAW_STATE_DIR).toBe("/data/openclaw");
    expect(env.OPENCLAW_CONFIG_PATH).toBe("/data/openclaw/custom.json");
  });
});

describe("canEnableRescueWatchdog", () => {
  it("rejects rescue profile shapes", () => {
    expect(canEnableRescueWatchdog("rescue")).toBe(false);
    expect(canEnableRescueWatchdog("work-rescue")).toBe(false);
  });
});
