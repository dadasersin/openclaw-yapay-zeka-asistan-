import { describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../runtime.js";
import {
  mapQueueOutcomeToDeliveryResult,
  runSubagentAnnounceDispatch,
} from "./subagent-announce-dispatch.js";
import { __testing as subagentAnnounceTesting } from "./subagent-announce.js";

describe("mapQueueOutcomeToDeliveryResult", () => {
  it("maps steered to delivered", () => {
    expect(mapQueueOutcomeToDeliveryResult("steered")).toEqual({
      delivered: true,
      path: "steered",
    });
  });

  it("maps queued to delivered", () => {
    expect(mapQueueOutcomeToDeliveryResult("queued")).toEqual({
      delivered: true,
      path: "queued",
    });
  });

  it("maps none to not-delivered", () => {
    expect(mapQueueOutcomeToDeliveryResult("none")).toEqual({
      delivered: false,
      path: "none",
    });
  });
});

describe("runSubagentAnnounceDispatch", () => {
  async function runNonCompletionDispatch(params: {
    queueOutcome: "none" | "queued" | "steered";
    directDelivered?: boolean;
  }) {
    const queue = vi.fn(async () => params.queueOutcome);
    const direct = vi.fn(async () => ({
      delivered: params.directDelivered ?? true,
      path: "direct" as const,
    }));
    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: false,
      queue,
      direct,
    });
    return { queue, direct, result };
  }

  it("uses queue-first ordering for non-completion mode", async () => {
    const { queue, direct, result } = await runNonCompletionDispatch({ queueOutcome: "none" });

    expect(queue).toHaveBeenCalledTimes(1);
    expect(direct).toHaveBeenCalledTimes(1);
    expect(result.delivered).toBe(true);
    expect(result.path).toBe("direct");
    expect(result.phases).toEqual([
      { phase: "queue-primary", delivered: false, path: "none", error: undefined },
      { phase: "direct-primary", delivered: true, path: "direct", error: undefined },
    ]);
  });

  it("short-circuits direct send when non-completion queue delivers", async () => {
    const { queue, direct, result } = await runNonCompletionDispatch({ queueOutcome: "queued" });

    expect(queue).toHaveBeenCalledTimes(1);
    expect(direct).not.toHaveBeenCalled();
    expect(result.path).toBe("queued");
    expect(result.phases).toEqual([
      { phase: "queue-primary", delivered: true, path: "queued", error: undefined },
    ]);
  });

  it("uses direct-first ordering for completion mode", async () => {
    const queue = vi.fn(async () => "queued" as const);
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      queue,
      direct,
    });

    expect(direct).toHaveBeenCalledTimes(1);
    expect(queue).not.toHaveBeenCalled();
    expect(result.path).toBe("direct");
    expect(result.phases).toEqual([
      { phase: "direct-primary", delivered: true, path: "direct", error: undefined },
    ]);
  });

  it("falls back to queue when completion direct send fails", async () => {
    const queue = vi.fn(async () => "steered" as const);
    const direct = vi.fn(async () => ({
      delivered: false,
      path: "direct" as const,
      error: "network",
    }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      queue,
      direct,
    });

    expect(direct).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledTimes(1);
    expect(result.path).toBe("steered");
    expect(result.phases).toEqual([
      { phase: "direct-primary", delivered: false, path: "direct", error: "network" },
      { phase: "queue-fallback", delivered: true, path: "steered", error: undefined },
    ]);
  });

  it("returns direct failure when completion fallback queue cannot deliver", async () => {
    const queue = vi.fn(async () => "none" as const);
    const direct = vi.fn(async () => ({
      delivered: false,
      path: "direct" as const,
      error: "failed",
    }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      queue,
      direct,
    });

    expect(result).toMatchObject({
      delivered: false,
      path: "direct",
      error: "failed",
    });
    expect(result.phases).toEqual([
      { phase: "direct-primary", delivered: false, path: "direct", error: "failed" },
      { phase: "queue-fallback", delivered: false, path: "none", error: undefined },
    ]);
  });

  it("returns none immediately when signal is already aborted", async () => {
    const queue = vi.fn(async () => "none" as const);
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));
    const controller = new AbortController();
    controller.abort();

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      signal: controller.signal,
      queue,
      direct,
    });

    expect(queue).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
    expect(result).toEqual({
      delivered: false,
      path: "none",
      phases: [],
    });
  });

  it("plans pending non-bound completion delivery as agent_internal_only", async () => {
    const plan = await subagentAnnounceTesting.buildSubagentDirectDeliveryPlan({
      targetRequesterSessionKey: "agent:main:main",
      expectsCompletionMessage: true,
      requesterIsSubagent: false,
      completionDirectOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      completionRouteMode: "fallback",
      currentRunId: "run-child-1",
      countPendingDescendantRuns: vi.fn(() => 9),
      countPendingDescendantRunsExcludingRun: vi.fn(() => 1),
    });

    expect(plan).toEqual({
      kind: "agent_internal_only",
      origin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
    });
  });

  it("keeps bound completion delivery external even when siblings are still pending", async () => {
    const excludeCurrentRun = vi.fn(() => 2);

    const plan = await subagentAnnounceTesting.buildSubagentDirectDeliveryPlan({
      targetRequesterSessionKey: "agent:main:main",
      expectsCompletionMessage: true,
      requesterIsSubagent: false,
      completionDirectOrigin: {
        channel: "discord",
        to: "channel:thread-bound-1",
        accountId: "acct-1",
      },
      completionMessage: "bound final answer",
      completionRouteMode: "bound",
      spawnMode: "session",
      currentRunId: "run-child-2",
      countPendingDescendantRuns: vi.fn(() => 5),
      countPendingDescendantRunsExcludingRun: excludeCurrentRun,
    });

    expect(excludeCurrentRun).toHaveBeenCalledWith("agent:main:main", "run-child-2");
    expect(plan).toEqual({
      kind: "agent_external",
      origin: {
        channel: "discord",
        to: "channel:thread-bound-1",
        accountId: "acct-1",
      },
    });
  });

  it("keeps hook completion delivery external even when siblings are still pending", async () => {
    const excludeCurrentRun = vi.fn(() => 2);

    const plan = await subagentAnnounceTesting.buildSubagentDirectDeliveryPlan({
      targetRequesterSessionKey: "agent:main:main",
      expectsCompletionMessage: true,
      requesterIsSubagent: false,
      completionDirectOrigin: {
        channel: "discord",
        to: "channel:hook-bound-1",
        accountId: "acct-1",
      },
      completionMessage: "hook final answer",
      completionRouteMode: "hook",
      spawnMode: "session",
      currentRunId: "run-hook-1",
      countPendingDescendantRuns: vi.fn(() => 5),
      countPendingDescendantRunsExcludingRun: excludeCurrentRun,
    });

    expect(excludeCurrentRun).toHaveBeenCalledWith("agent:main:main", "run-hook-1");
    expect(plan).toEqual({
      kind: "agent_external",
      origin: {
        channel: "discord",
        to: "channel:hook-bound-1",
        accountId: "acct-1",
      },
    });
  });

  it("keeps hook completion delivery external when descendant counting is unknown", async () => {
    const excludeCurrentRun = vi.fn(() => {
      throw new Error("registry unavailable");
    });

    const plan = await subagentAnnounceTesting.buildSubagentDirectDeliveryPlan({
      targetRequesterSessionKey: "agent:main:main",
      expectsCompletionMessage: true,
      requesterIsSubagent: false,
      completionDirectOrigin: {
        channel: "discord",
        to: "channel:hook-bound-error",
        accountId: "acct-1",
      },
      completionMessage: "hook final answer",
      completionRouteMode: "hook",
      spawnMode: "session",
      currentRunId: "run-hook-error",
      countPendingDescendantRuns: vi.fn(() => 7),
      countPendingDescendantRunsExcludingRun: excludeCurrentRun,
    });

    expect(excludeCurrentRun).toHaveBeenCalledWith("agent:main:main", "run-hook-error");
    expect(plan).toEqual({
      kind: "agent_external",
      origin: {
        channel: "discord",
        to: "channel:hook-bound-error",
        accountId: "acct-1",
      },
    });
  });

  it("does not treat hook completion delivery as bound-like outside session mode", async () => {
    const excludeCurrentRun = vi.fn(() => 2);

    const plan = await subagentAnnounceTesting.buildSubagentDirectDeliveryPlan({
      targetRequesterSessionKey: "agent:main:main",
      expectsCompletionMessage: true,
      requesterIsSubagent: false,
      completionDirectOrigin: {
        channel: "discord",
        to: "channel:hook-run-1",
        accountId: "acct-1",
      },
      completionMessage: "hook run final answer",
      completionRouteMode: "hook",
      spawnMode: "run",
      currentRunId: "run-hook-nonsession",
      countPendingDescendantRuns: vi.fn(() => 5),
      countPendingDescendantRunsExcludingRun: excludeCurrentRun,
    });

    expect(excludeCurrentRun).toHaveBeenCalledWith("agent:main:main", "run-hook-nonsession");
    expect(plan).toEqual({
      kind: "agent_internal_only",
      origin: {
        channel: "discord",
        to: "channel:hook-run-1",
        accountId: "acct-1",
      },
    });
  });

  it("keeps completion direct-send reachable once descendants are settled", async () => {
    const excludeCurrentRun = vi.fn(() => 0);

    const plan = await subagentAnnounceTesting.buildSubagentDirectDeliveryPlan({
      targetRequesterSessionKey: "agent:main:main",
      expectsCompletionMessage: true,
      requesterIsSubagent: false,
      completionDirectOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      completionMessage: "final answer: 2",
      completionRouteMode: "fallback",
      currentRunId: "run-child-3",
      countPendingDescendantRuns: vi.fn(() => 7),
      countPendingDescendantRunsExcludingRun: excludeCurrentRun,
    });

    expect(excludeCurrentRun).toHaveBeenCalledWith("agent:main:main", "run-child-3");
    expect(plan).toEqual({
      kind: "completion_direct_send",
      target: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      message: "final answer: 2",
    });
  });

  it("strips trailing completion control markers before direct send", async () => {
    const excludeCurrentRun = vi.fn(() => 0);

    const noReplyPlan = await subagentAnnounceTesting.buildSubagentDirectDeliveryPlan({
      targetRequesterSessionKey: "agent:main:main",
      expectsCompletionMessage: true,
      requesterIsSubagent: false,
      completionDirectOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      completionMessage: "final answer NO_REPLY",
      completionRouteMode: "fallback",
      currentRunId: "run-child-strip-no-reply",
      countPendingDescendantRuns: vi.fn(() => 7),
      countPendingDescendantRunsExcludingRun: excludeCurrentRun,
    });

    const skipPlan = await subagentAnnounceTesting.buildSubagentDirectDeliveryPlan({
      targetRequesterSessionKey: "agent:main:main",
      expectsCompletionMessage: true,
      requesterIsSubagent: false,
      completionDirectOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      completionMessage: "final answer ANNOUNCE_SKIP",
      completionRouteMode: "fallback",
      currentRunId: "run-child-strip-skip",
      countPendingDescendantRuns: vi.fn(() => 7),
      countPendingDescendantRunsExcludingRun: excludeCurrentRun,
    });

    expect(noReplyPlan).toEqual({
      kind: "completion_direct_send",
      target: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      message: "final answer",
    });
    expect(skipPlan).toEqual({
      kind: "completion_direct_send",
      target: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      message: "final answer",
    });
  });

  it("fails closed when descendant counting throws during completion planning", async () => {
    const excludeCurrentRun = vi.fn(() => {
      throw new Error("registry unavailable");
    });

    const plan = await subagentAnnounceTesting.buildSubagentDirectDeliveryPlan({
      targetRequesterSessionKey: "agent:main:main",
      expectsCompletionMessage: true,
      requesterIsSubagent: false,
      completionDirectOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      completionMessage: "final answer: 2",
      completionRouteMode: "fallback",
      currentRunId: "run-child-error",
      countPendingDescendantRuns: vi.fn(() => 7),
      countPendingDescendantRunsExcludingRun: excludeCurrentRun,
    });

    expect(excludeCurrentRun).toHaveBeenCalledWith("agent:main:main", "run-child-error");
    expect(plan).toEqual({
      kind: "agent_internal_only",
      origin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
    });
  });

  it("fails closed before agent_external fallback when completion direct target is deliverable but message is empty", async () => {
    const excludeCurrentRun = vi.fn(() => {
      throw new Error("registry unavailable");
    });

    const plan = await subagentAnnounceTesting.buildSubagentDirectDeliveryPlan({
      targetRequesterSessionKey: "agent:main:main",
      expectsCompletionMessage: true,
      requesterIsSubagent: false,
      completionDirectOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      completionMessage: "   ",
      completionRouteMode: "fallback",
      currentRunId: "run-child-error-empty-message",
      countPendingDescendantRuns: vi.fn(() => 7),
      countPendingDescendantRunsExcludingRun: excludeCurrentRun,
    });

    expect(excludeCurrentRun).toHaveBeenCalledWith(
      "agent:main:main",
      "run-child-error-empty-message",
    );
    expect(plan).toEqual({
      kind: "agent_internal_only",
      origin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
    });
  });

  it("logs when descendant counting fails closed during completion planning", async () => {
    const excludeCurrentRun = vi.fn(() => {
      throw new Error("registry unavailable");
    });
    const runtimeLog = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});

    try {
      await subagentAnnounceTesting.buildSubagentDirectDeliveryPlan({
        targetRequesterSessionKey: "agent:main:main",
        expectsCompletionMessage: true,
        requesterIsSubagent: false,
        completionDirectOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
        completionMessage: "final answer: 2",
        completionRouteMode: "fallback",
        currentRunId: "run-child-error-log",
        countPendingDescendantRuns: vi.fn(() => 7),
        countPendingDescendantRunsExcludingRun: excludeCurrentRun,
      });

      expect(runtimeLog).toHaveBeenCalledWith(
        expect.stringContaining(
          "Subagent descendant counting failed, failing closed for completion delivery",
        ),
      );
      expect(runtimeLog).toHaveBeenCalledWith(expect.stringContaining("requester=agent:main:main"));
      expect(runtimeLog).toHaveBeenCalledWith(expect.stringContaining("run=run-child-error-log"));
    } finally {
      runtimeLog.mockRestore();
    }
  });

  it("canonicalizes requester key before descendant counting", async () => {
    const excludeCurrentRun = vi.fn(() => 1);

    await subagentAnnounceTesting.buildSubagentDirectDeliveryPlan({
      targetRequesterSessionKey: "main",
      expectsCompletionMessage: true,
      requesterIsSubagent: false,
      completionDirectOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      completionRouteMode: "fallback",
      currentRunId: "run-child-4",
      countPendingDescendantRuns: vi.fn(() => 9),
      countPendingDescendantRunsExcludingRun: excludeCurrentRun,
    });

    expect(excludeCurrentRun).toHaveBeenCalledWith("agent:main:main", "run-child-4");
  });
});
