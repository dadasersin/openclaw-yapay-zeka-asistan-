import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfig = vi.hoisted(() =>
  vi.fn(() => ({
    gateway: {
      port: 18_789,
      auth: {
        mode: "token",
        token: "main-token",
      },
    },
  })),
);
const restartService = vi.hoisted(() => vi.fn(async () => {}));
const probeGateway = vi.hoisted(() => vi.fn());
const resolveGatewayProbeAuthSafe = vi.hoisted(() =>
  vi.fn(() => ({
    auth: { token: "main-token" },
  })),
);
const runCommandWithTimeout = vi.hoisted(() =>
  vi.fn(async () => ({
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit" as const,
    noOutputTimedOut: false,
  })),
);

vi.mock("../config/io.js", () => ({
  createConfigIO: vi.fn(() => ({
    loadConfig,
  })),
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: vi.fn(() => ({
    restart: restartService,
  })),
}));

vi.mock("../gateway/probe.js", () => ({
  probeGateway,
}));

vi.mock("../gateway/probe-auth.js", () => ({
  resolveGatewayProbeAuthSafe,
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout,
}));

import { runRescueWatchdogJob } from "./rescue-watchdog.js";

describe("runRescueWatchdogJob", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T00:00:00.000Z"));
    loadConfig.mockClear();
    restartService.mockClear();
    probeGateway.mockReset();
    resolveGatewayProbeAuthSafe.mockClear();
    runCommandWithTimeout.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns without repair when the monitored gateway is already healthy", async () => {
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      error: null,
    });

    const result = await runRescueWatchdogJob({
      job: {
        id: "job-1",
        name: "rescue",
        payload: {
          kind: "rescueWatchdog",
          monitoredProfile: "default",
          timeoutSeconds: 120,
        },
      } as never,
      monitoredProfile: "default",
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toContain("found it healthy");
    expect(restartService).not.toHaveBeenCalled();
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("rejects rescue-shaped monitored profiles before service actions", async () => {
    const result = await runRescueWatchdogJob({
      job: {
        id: "job-rescue-profile",
        name: "rescue",
        payload: {
          kind: "rescueWatchdog",
          monitoredProfile: "rescue",
          timeoutSeconds: 120,
        },
      } as never,
      monitoredProfile: "rescue",
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("cannot monitor rescue profiles");
    expect(restartService).not.toHaveBeenCalled();
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("restarts the managed service before escalating to doctor", async () => {
    probeGateway
      .mockResolvedValueOnce({
        ok: false,
        close: { code: 1006, reason: "down" },
        error: "down",
      })
      .mockResolvedValueOnce({
        ok: true,
        close: null,
        error: null,
      });

    const result = await runRescueWatchdogJob({
      job: {
        id: "job-2",
        name: "rescue",
        payload: {
          kind: "rescueWatchdog",
          monitoredProfile: "work",
          timeoutSeconds: 120,
        },
      } as never,
      monitoredProfile: "work",
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toContain("restarted managed gateway service");
    expect(restartService).toHaveBeenCalledTimes(1);
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("falls back to doctor with a fixed argv when restart does not recover the gateway", async () => {
    let probeCount = 0;
    probeGateway.mockImplementation(async () => {
      probeCount += 1;
      if (probeCount >= 62) {
        return {
          ok: true,
          close: null,
          error: null,
        };
      }
      return {
        ok: false,
        close: { code: 1006, reason: "down" },
        error: "down",
      };
    });

    const runPromise = runRescueWatchdogJob({
      job: {
        id: "job-3",
        name: "rescue",
        payload: {
          kind: "rescueWatchdog",
          monitoredProfile: "work",
          timeoutSeconds: 120,
        },
      } as never,
      monitoredProfile: "work",
    });

    await vi.advanceTimersByTimeAsync(31_000);
    const result = await runPromise;

    expect(result.status).toBe("ok");
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      ["openclaw", "--profile", "work", "doctor", "--repair", "--non-interactive"],
      expect.objectContaining({
        timeoutMs: expect.any(Number),
      }),
    );
    expect(result.summary).toContain("ran doctor --repair --non-interactive");
  });

  it("skips doctor when the cron timeout budget is already exhausted", async () => {
    probeGateway.mockResolvedValue({
      ok: false,
      close: { code: 1006, reason: "down" },
      error: "down",
    });

    const runPromise = runRescueWatchdogJob({
      job: {
        id: "job-4",
        name: "rescue",
        payload: {
          kind: "rescueWatchdog",
          monitoredProfile: "work",
          timeoutSeconds: 5,
        },
      } as never,
      monitoredProfile: "work",
    });

    await vi.advanceTimersByTimeAsync(31_000);
    const result = await runPromise;

    expect(result.status).toBe("error");
    expect(result.error).toContain("skipped doctor fallback");
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });
});
