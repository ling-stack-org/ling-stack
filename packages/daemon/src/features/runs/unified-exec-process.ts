import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { UnifiedExecProcessObservation } from "@ling-stack/core";

const TERMINATE_GRACE_MS = 500;
const CLEANUP_DEADLINE_MS = 1500;
const OUTPUT_DRAIN_MS = 1000;
const MAX_TIMER_MS = 2_147_483_647;

export interface CommandProcessResult {
  readonly exitCode?: number;
  readonly signal?: string;
  readonly observation: UnifiedExecProcessObservation;
  readonly error?: Error;
}

/**
 * Owns listeners, timeouts and bounded cleanup for one already-spawned command.
 * Closing local pipes bounds Host waiting; it never proves detached children stopped.
 * All terminal paths detach observers before returning, so late output cannot mutate evidence.
 */
export function observeCommandProcess(input: {
  readonly child: ChildProcessWithoutNullStreams;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly idleTimeoutMs?: number;
  readonly onOutput: (stream: "stdout" | "stderr", chunk: Buffer) => void;
}): Promise<CommandProcessResult> {
  const { child, signal } = input;
  return new Promise(resolve => {
    let settled = false;
    let leaderExited = child.exitCode !== null || child.signalCode !== null;
    let stdioClosed = false;
    let exitCode: number | undefined = child.exitCode ?? undefined;
    let processSignal: string | undefined = child.signalCode ?? undefined;
    let stopReason: UnifiedExecProcessObservation["stopReason"];
    let error: Error | undefined;
    const signalFailures: string[] = [];
    let killTimer: NodeJS.Timeout | undefined;
    let cleanupTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;

    function finish(settledBy: UnifiedExecProcessObservation["settledBy"]): void {
      if (settled) return;
      settled = true;
      for (const timer of [killTimer, cleanupTimer, drainTimer, idleTimer, timeoutTimer]) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout.removeListener("data", onStdout);
      child.stderr.removeListener("data", onStderr);
      child.stdout.removeListener("error", onStreamError);
      child.stderr.removeListener("error", onStreamError);
      const observation: UnifiedExecProcessObservation = Object.freeze({
        scope: process.platform === "win32" ? "leader" : "process_group",
        leaderExited, stdioClosed, descendants: "unverified", stopReason, settledBy,
        signalFailures: Object.freeze([...signalFailures]),
      });
      if (!stdioClosed) {
        // EOF may never arrive from an escaped process. Do not retain its pipe/Host event loop.
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
        child.unref();
      }
      resolve({ exitCode, signal: processSignal, observation, error });
    }

    function sendTermination(requestedSignal: "SIGTERM" | "SIGKILL"): void {
      // Do not target a PID after its leader was reaped and could have been reused.
      if (!child.pid || leaderExited || child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform !== "win32") {
        try { process.kill(-child.pid, requestedSignal); return; }
        catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ESRCH") return;
          signalFailures.push(`${requestedSignal}:group:${errorCode(cause)}`);
        }
      }
      try {
        if (!child.kill(requestedSignal)) signalFailures.push(`${requestedSignal}:leader:not_delivered`);
      } catch (cause) { signalFailures.push(`${requestedSignal}:leader:${errorCode(cause)}`); }
    }

    function stop(reason: NonNullable<UnifiedExecProcessObservation["stopReason"]>): void {
      if (settled) return;
      // User cancellation wins over a racing timeout; never restart the cleanup deadline.
      if (stopReason) { if (reason === "cancelled") stopReason = reason; return; }
      stopReason = reason;
      clearTimeout(idleTimer);
      clearTimeout(drainTimer);
      clearTimeout(timeoutTimer);
      sendTermination("SIGTERM");
      killTimer = setTimeout(() => sendTermination("SIGKILL"), TERMINATE_GRACE_MS);
      cleanupTimer = setTimeout(() => finish("cleanup_deadline"), CLEANUP_DEADLINE_MS);
    }

    function resetIdleTimer(): void {
      if (settled || stopReason || input.idleTimeoutMs === undefined) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop("timeout"), boundedTimeout(input.idleTimeoutMs));
    }
    function ingest(stream: "stdout" | "stderr", chunk: Buffer): void {
      if (settled) return;
      resetIdleTimer();
      try { input.onOutput(stream, chunk); }
      catch (cause) { error ??= asError(cause); stop("observer_error"); }
    }
    function onStdout(chunk: Buffer): void { ingest("stdout", chunk); }
    function onStderr(chunk: Buffer): void { ingest("stderr", chunk); }
    function onStreamError(cause: Error): void { error ??= cause; stop("observer_error"); }
    function onAbort(): void { stop("cancelled"); }
    function onExit(code: number | null, cause: NodeJS.Signals | null): void {
      leaderExited = true;
      exitCode = code ?? undefined;
      processSignal = cause ?? undefined;
      if (!settled && !stopReason) drainTimer = setTimeout(() => stop("output_drain"), OUTPUT_DRAIN_MS);
    }
    function onClose(code: number | null, cause: NodeJS.Signals | null): void {
      stdioClosed = true;
      exitCode ??= code ?? undefined;
      processSignal ??= cause ?? undefined;
      finish("close");
    }
    function onError(cause: Error): void {
      error ??= cause;
      // A failed spawn has no PID to stop. A live-process error still needs bounded cleanup.
      if (!child.pid) finish("spawn_error");
      else stop("observer_error");
    }

    child.on("error", onError);
    child.on("exit", onExit);
    child.on("close", onClose);
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.stdout.on("error", onStreamError);
    child.stderr.on("error", onStreamError);
    signal?.addEventListener("abort", onAbort, { once: true });
    timeoutTimer = setTimeout(() => stop("timeout"), boundedTimeout(input.timeoutMs));
    resetIdleTimer();
    if (leaderExited) drainTimer = setTimeout(() => stop("output_drain"), OUTPUT_DRAIN_MS);
    // The signal may have fired between spawn and listener registration.
    if (signal?.aborted) onAbort();
  });
}

function boundedTimeout(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(MAX_TIMER_MS, Math.max(1, Math.floor(value))) : 1;
}
function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
function errorCode(value: unknown): string {
  const code = (value as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "unknown";
}
