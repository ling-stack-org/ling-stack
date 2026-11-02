import { subscribe, unsubscribe } from "node:diagnostics_channel";

/** Observe the real producer without replacing spawn or retaining command/output text. */
export async function captureNodeGoalCommandDiagnostic({ sequence, timeoutMs, execute, record }) {
  const started = performance.now();
  const elapsed = () => performance.now() - started;
  const processes = [];
  const cleanup = [];
  const listen = (emitter, event, callback) => {
    emitter?.once(event, callback);
    if (emitter) cleanup.push(() => emitter.removeListener(event, callback));
  };
  const onChild = ({ process: child }) => {
    const timing = { createdMs: elapsed(), spawnedMs: null, firstStdoutMs: null, firstStderrMs: null,
      exitMs: null, closeMs: null, exitCode: null, signal: null, errorCode: null };
    processes.push(timing);
    listen(child, "spawn", () => {
      timing.spawnedMs = elapsed();
      listen(child.stdout, "data", () => { timing.firstStdoutMs = elapsed(); });
      listen(child.stderr, "data", () => { timing.firstStderrMs = elapsed(); });
    });
    listen(child, "exit", (code, signal) => { timing.exitMs = elapsed(); timing.exitCode = code; timing.signal = signal; });
    listen(child, "close", () => { timing.closeMs = elapsed(); });
    listen(child, "error", error => {
      timing.errorCode = typeof error.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : "unknown";
    });
  };
  let handled;
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
    const result = handled?.details?.unifiedExec;
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
