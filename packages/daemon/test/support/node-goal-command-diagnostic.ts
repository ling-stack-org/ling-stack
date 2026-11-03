import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { UnifiedExecProcessObservation, UnifiedExecResult } from "@ling-stack/contracts";

interface ProcessTiming {
  createdMs: number;
  spawnedMs: number | null;
  firstStdoutMs: number | null;
  firstStderrMs: number | null;
  exitMs: number | null;
  closeMs: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  errorCode: string | null;
}

export interface NodeGoalCommandDiagnostic {
  kind: "node_goal_command_diagnostic_v1";
  sequence: number;
  timeoutMs: number;
  nodeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  elapsedMs: number;
  returned: boolean;
  processes: ProcessTiming[];
  result: {
    status: UnifiedExecResult["status"] | null;
    denied: boolean;
    startedAt: string | null;
    endedAt: string | null;
    durationMs: number | null;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean | null;
    cancelled: boolean | null;
    processObservation: (Omit<UnifiedExecProcessObservation, "stopReason"> & {
      stopReason: UnifiedExecProcessObservation["stopReason"] | null;
    }) | null;
    stdout: { byteCount: number | null; truncated: boolean | null };
    stderr: { byteCount: number | null; truncated: boolean | null };
  };
}

interface DiagnosticHandledResult {
  details?: { unifiedExec?: Partial<UnifiedExecResult> & { denied?: boolean } };
}

/** Observe the real producer without replacing spawn or retaining command/output text. */
export async function captureNodeGoalCommandDiagnostic<T>({ sequence, timeoutMs, execute, record }: {
  sequence: number;
  timeoutMs: number;
  execute: () => Promise<T>;
  record: (diagnostic: NodeGoalCommandDiagnostic) => void;
}): Promise<T> {
  const started = performance.now();
  const elapsed = () => performance.now() - started;
  const processes: ProcessTiming[] = [];
  const cleanup: (() => void)[] = [];
  const listen = <Args extends unknown[]>(emitter: EventEmitter | null | undefined, event: string, callback: (...args: Args) => void) => {
    emitter?.once(event, callback);
    if (emitter) cleanup.push(() => emitter.removeListener(event, callback));
  };
  const onChild = (message: unknown) => {
    const { process: child } = message as { process: ChildProcess };
    const timing: ProcessTiming = { createdMs: elapsed(), spawnedMs: null, firstStdoutMs: null, firstStderrMs: null,
      exitMs: null, closeMs: null, exitCode: null, signal: null, errorCode: null };
    processes.push(timing);
    listen(child, "spawn", () => {
      timing.spawnedMs = elapsed();
      listen(child.stdout, "data", () => { timing.firstStdoutMs = elapsed(); });
      listen(child.stderr, "data", () => { timing.firstStderrMs = elapsed(); });
    });
    listen(child, "exit", (code: number | null, signal: NodeJS.Signals | null) => { timing.exitMs = elapsed(); timing.exitCode = code; timing.signal = signal; });
    listen(child, "close", () => { timing.closeMs = elapsed(); });
    listen(child, "error", (error: unknown) => {
      const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
      timing.errorCode = typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "unknown";
    });
  };
  let handled: T | undefined;
  let returned = false;
  subscribe("child_process", onChild);
  try {
    handled = await execute();
    returned = true;
    return handled;
  } finally {
    const elapsedMs = elapsed();
    unsubscribe("child_process", onChild);
    for (const detach of cleanup) detach();
    const result = (handled as DiagnosticHandledResult | undefined)?.details?.unifiedExec;
    const observation = result?.processObservation;
    record({ kind: "node_goal_command_diagnostic_v1", sequence, timeoutMs,
      nodeVersion: process.version, platform: process.platform, arch: process.arch,
      elapsedMs, returned, processes,
      result: {
        status: result?.status ?? null, denied: result?.denied === true,
        startedAt: result?.startedAt ?? null, endedAt: result?.endedAt ?? null,
        durationMs: result?.durationMs ?? null, exitCode: result?.exitCode ?? null, signal: result?.signal ?? null,
        timedOut: result?.timedOut ?? null, cancelled: result?.cancelled ?? null,
        processObservation: observation ? {
          scope: observation.scope, leaderExited: observation.leaderExited, stdioClosed: observation.stdioClosed,
          descendants: observation.descendants, stopReason: observation.stopReason ?? null,
          settledBy: observation.settledBy, signalFailures: [...observation.signalFailures],
        } : null,
        stdout: { byteCount: result?.stdout?.byteCount ?? null, truncated: result?.stdout?.truncated ?? null },
        stderr: { byteCount: result?.stderr?.byteCount ?? null, truncated: result?.stderr?.truncated ?? null },
      },
    });
  }
}
