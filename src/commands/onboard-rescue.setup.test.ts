import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const buildGatewayInstallPlan = vi.hoisted(() =>
  vi.fn(async () => ({
    programArguments: [],
    workingDirectory: "/tmp",
    environment: {},
  })),
);
const resolveGatewayInstallToken = vi.hoisted(() =>
  vi.fn(async () => ({
    token: undefined,
    tokenRefConfigured: true,
    warnings: [],
  })),
);
const waitForGatewayReachable = vi.hoisted(() => vi.fn(async () => {}));
const callGateway = vi.hoisted(() =>
  vi.fn(async (params: { method: string }) => {
    if (params.method === "cron.list") {
      return { jobs: [] };
    }
    if (params.method === "cron.add") {
      return { id: "job-1" };
    }
    throw new Error(`Unexpected gateway method: ${params.method}`);
  }),
);
const gatewayInstall = vi.hoisted(() => vi.fn(async () => {}));
const gatewayRestart = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../agents/workspace.js", () => ({
  ensureAgentWorkspace: vi.fn(async ({ dir }: { dir: string }) => ({ dir })),
}));

vi.mock("./daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan,
  gatewayInstallErrorHint: vi.fn(() => "hint"),
}));

vi.mock("./gateway-install-token.js", () => ({
  resolveGatewayInstallToken,
}));

vi.mock("./onboard-helpers.js", () => ({
  randomToken: vi.fn(() => "generated-rescue-token"),
  waitForGatewayReachable,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway,
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: vi.fn(() => ({
    isLoaded: vi.fn(async () => false),
    install: gatewayInstall,
    restart: gatewayRestart,
  })),
}));

import { saveAuthProfileStore } from "../agents/auth-profiles.js";
import { setupRescueWatchdog } from "./onboard-rescue.js";

describe("setupRescueWatchdog", () => {
  const previousEnv = {
    HOME: process.env.HOME,
    OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
    OPENCLAW_GATEWAY_PORT: process.env.OPENCLAW_GATEWAY_PORT,
    OPENCLAW_PROFILE: process.env.OPENCLAW_PROFILE,
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    OPENCLAW_TEST_FAST: process.env.OPENCLAW_TEST_FAST,
  };

  let tempHome = "";

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-rescue-"));
    buildGatewayInstallPlan.mockClear();
    resolveGatewayInstallToken.mockClear();
    waitForGatewayReachable.mockClear();
    callGateway.mockClear();
    gatewayInstall.mockClear();
    gatewayRestart.mockClear();
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("uses an isolated rescue state dir and preserves rescue-only auth profiles", async () => {
    const mainStateDir = path.join(tempHome, ".openclaw-work");
    const mainConfigPath = path.join(mainStateDir, "openclaw.json");
    const mainAgentDir = path.join(mainStateDir, "agents", "main", "agent");
    const rescueStateDir = path.join(tempHome, ".openclaw-work-rescue");
    const rescueConfigPath = path.join(rescueStateDir, "openclaw.json");
    const rescueAgentDir = path.join(rescueStateDir, "agents", "main", "agent");
    const mainWorkspace = path.join(tempHome, "workspace-work");

    process.env.HOME = tempHome;
    process.env.OPENCLAW_TEST_FAST = "1";
    process.env.OPENCLAW_PROFILE = "work";
    process.env.OPENCLAW_STATE_DIR = mainStateDir;
    process.env.OPENCLAW_CONFIG_PATH = mainConfigPath;
    process.env.OPENCLAW_GATEWAY_PORT = "18789";

    await fs.mkdir(mainAgentDir, { recursive: true });
    await fs.mkdir(rescueAgentDir, { recursive: true });
    await fs.mkdir(mainStateDir, { recursive: true });
    await fs.writeFile(mainConfigPath, JSON.stringify({ wizard: { marker: "main" } }), "utf8");

    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "main-key": {
            type: "api_key",
            provider: "openai",
            key: "main-secret", // pragma: allowlist secret
          },
        },
      },
      mainAgentDir,
    );
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "rescue-only": {
            type: "api_key",
            provider: "openai",
            key: "rescue-secret", // pragma: allowlist secret
          },
        },
      },
      rescueAgentDir,
    );

    const result = await setupRescueWatchdog({
      sourceConfig: {
        tools: { profile: "coding" },
      },
      workspaceDir: mainWorkspace,
      mainPort: 18_789,
      monitoredProfile: "work",
      runtime: "node",
      output: {
        log: vi.fn(),
      },
    });

    expect(result.rescueProfile).toBe("work-rescue");
    expect(buildGatewayInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          OPENCLAW_PROFILE: "work-rescue",
          OPENCLAW_STATE_DIR: rescueStateDir,
          OPENCLAW_CONFIG_PATH: rescueConfigPath,
        }),
        port: 19_789,
      }),
    );

    const mainConfig = JSON.parse(await fs.readFile(mainConfigPath, "utf8")) as {
      wizard?: { marker?: string };
    };
    expect(mainConfig.wizard?.marker).toBe("main");

    const rescueConfig = JSON.parse(await fs.readFile(rescueConfigPath, "utf8")) as {
      gateway?: { port?: number };
    };
    expect(rescueConfig.gateway?.port).toBe(19_789);

    const rescueStore = JSON.parse(
      await fs.readFile(path.join(rescueAgentDir, "auth-profiles.json"), "utf8"),
    ) as {
      profiles: Record<string, unknown>;
    };
    expect(rescueStore.profiles).toHaveProperty("main-key");
    expect(rescueStore.profiles).toHaveProperty("rescue-only");
  });
});
