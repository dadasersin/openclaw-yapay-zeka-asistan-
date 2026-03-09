import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { CloudSandboxProvider } from "../infra/cloud-sandbox-provider.js";
import { resolveCloudSandboxProvider } from "../infra/cloud-sandbox-registry.js";
import type { ExecAsk, ExecSecurity } from "../infra/exec-approvals.js";
import {
  addSession,
  appendOutput,
  createSessionSlug,
  markBackgrounded,
  markExited,
} from "./bash-process-registry.js";
import type { ProcessSession } from "./bash-process-registry.js";
import { resolveExecHostApprovalContext } from "./bash-tools.exec-host-shared.js";
import { emitExecSystemEvent } from "./bash-tools.exec-runtime.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";

export type ExecuteCloudHostCommandParams = {
  command: string;
  workdir: string;
  env: Record<string, string>;
  timeoutSec?: number;
  defaultTimeoutSec: number;
  backgroundMs?: number;
  yieldMs?: number;
  scopeKey?: string;
  sessionKey?: string;
  agentId?: string;
  security: ExecSecurity;
  ask: ExecAsk;
  warnings: string[];
  /** Injected provider for testability; defaults to resolveCloudSandboxProvider(). */
  provider?: CloudSandboxProvider | null;
};

export async function executeCloudHostCommand(
  params: ExecuteCloudHostCommandParams,
): Promise<AgentToolResult<ExecToolDetails>> {
  // 1. Resolve provider
  const provider = params.provider ?? resolveCloudSandboxProvider();
  if (!provider) {
    throw new Error(
      [
        "exec host=cloud requires a cloud sandbox plugin (none registered).",
        "Install a cloud sandbox plugin (e.g. satellite-openclaw-plugin) and ensure it registers a cloud-sandbox service.",
      ].join("\n"),
    );
  }

  // 2. Security / approval (reuse the shared approval context).
  // resolveExecHostApprovalContext merges agent-level overrides (minSecurity / maxAsk)
  // and throws on security=deny. Cloud sandboxes provide process-level isolation,
  // so allowlist/approval enforcement is intentionally not applied here — the
  // sandbox itself is the security boundary. The hostSecurity/hostAsk values are
  // preserved for future use if cloud hosts need finer-grained approval.
  // oxlint-disable-next-line no-unused-vars -- intentionally captured; see comment above
  const { hostSecurity, hostAsk } = resolveExecHostApprovalContext({
    agentId: params.agentId,
    security: params.security,
    ask: params.ask,
    host: "cloud",
  });

  // 3. Ensure sandbox is ready
  await provider.ensureReady();

  const warningText = params.warnings.length ? `${params.warnings.join("\n")}\n\n` : "";
  const timeoutMs = (params.timeoutSec ?? params.defaultTimeoutSec) * 1000;

  // 4. Background execution
  if (params.backgroundMs !== undefined || params.yieldMs !== undefined) {
    const cloudSession = await provider.execBackground({
      command: params.command,
      cwd: params.workdir,
      env: params.env,
    });

    // Register a proxy session in the process registry so the `process` tool
    // can poll/kill it via getSession(). The session delegates read/kill to
    // the cloud provider's readSessionLog/killSession methods.
    const sessionId = cloudSession.sessionId || createSessionSlug();
    const proxySession: ProcessSession = {
      id: sessionId,
      command: params.command,
      scopeKey: params.scopeKey,
      sessionKey: params.sessionKey,
      notifyOnExit: false,
      exitNotified: false,
      startedAt: Date.now(),
      cwd: params.workdir,
      maxOutputChars: 200_000,
      pendingMaxOutputChars: 30_000,
      totalOutputChars: 0,
      pendingStdout: [],
      pendingStderr: [],
      pendingStdoutChars: 0,
      pendingStderrChars: 0,
      aggregated: cloudSession.initialOutput ?? "",
      tail: cloudSession.initialOutput ?? "",
      exited: false,
      truncated: false,
      backgrounded: true,
      onKill: async () => {
        await provider.killSession(cloudSession.sessionId);
      },
    };
    addSession(proxySession);
    markBackgrounded(proxySession);

    // Kick off a polling loop to keep the proxy session updated.
    // This runs detached (fire-and-forget) so we don't block the response.
    void pollCloudSession(provider, cloudSession.sessionId, proxySession);

    emitExecSystemEvent(`Exec backgrounded (cloud, session=${sessionId}): ${params.command}`, {
      sessionKey: params.sessionKey,
    });

    const parts = [
      `${warningText}Command running in background (cloud sandbox).`,
      `Session: ${sessionId}`,
    ];
    if (cloudSession.initialOutput) {
      parts.push(`Initial output:\n${cloudSession.initialOutput}`);
    }

    return {
      content: [{ type: "text", text: parts.join("\n") }],
      details: {
        status: "running",
        sessionId,
        startedAt: Date.now(),
        cwd: params.workdir,
      } satisfies ExecToolDetails,
    };
  }

  // 5. Synchronous execution
  const startedAt = Date.now();
  let result;
  try {
    result = await provider.exec({
      command: params.command,
      cwd: params.workdir,
      env: params.env,
      timeoutMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cloud sandbox exec failed (provider=${provider.id}): ${message}`, {
      cause: err,
    });
  }
  const durationMs = Date.now() - startedAt;

  // 6. Emit system event
  emitExecSystemEvent(
    `Exec finished (cloud, exit=${result.exitCode}${result.timedOut ? " timed-out" : ""}): ${params.command}`,
    { sessionKey: params.sessionKey },
  );

  // 7. Format result (matches existing exec output format)
  const outputParts: string[] = [];
  if (warningText) {
    outputParts.push(warningText.trimEnd());
  }
  if (result.stdout) {
    outputParts.push(result.stdout);
  }
  if (result.stderr) {
    outputParts.push(`[stderr]\n${result.stderr}`);
  }
  if (result.timedOut) {
    outputParts.push(`[timed out after ${timeoutMs}ms]`);
  }

  const output = outputParts.join("\n") || "(no output)";
  const success = result.exitCode === 0 && !result.timedOut;

  return {
    content: [{ type: "text", text: output }],
    details: {
      status: success ? "completed" : "failed",
      exitCode: result.exitCode,
      durationMs,
      aggregated: [result.stdout, result.stderr].filter(Boolean).join("\n"),
      cwd: params.workdir,
    } satisfies ExecToolDetails,
  };
}

// ---------------------------------------------------------------------------
// Background session polling
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_FAILURES = 5;

/**
 * Poll the cloud provider for background session output and update the
 * local proxy session in bash-process-registry. Runs detached (fire-and-forget).
 */
async function pollCloudSession(
  provider: CloudSandboxProvider,
  cloudSessionId: string,
  proxySession: ProcessSession,
): Promise<void> {
  let consecutiveFailures = 0;
  // Track how many bytes we've already appended so we only forward the
  // incremental portion — readSessionLog() returns *accumulated* output.
  let appendedLength = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    if (proxySession.exited) {
      return;
    }
    try {
      const log = await provider.readSessionLog(cloudSessionId);
      if (log.output && log.output.length > appendedLength) {
        const incremental = log.output.slice(appendedLength);
        appendOutput(proxySession, "stdout", incremental);
        appendedLength = log.output.length;
      }
      if (log.done) {
        markExited(
          proxySession,
          log.exitCode ?? null,
          null,
          log.exitCode === 0 ? "completed" : "failed",
        );
        return;
      }
      consecutiveFailures = 0;
    } catch {
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_POLL_FAILURES) {
        markExited(proxySession, null, null, "failed");
        return;
      }
    }
  }
}
