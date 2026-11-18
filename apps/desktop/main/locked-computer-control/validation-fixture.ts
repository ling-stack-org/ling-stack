import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { setTimeout as wait } from "node:timers/promises";
import type { LockedUseValidationFixture } from "./packaged-validation.js";

/** Counter messages come from an owned signed child, independently of MCP. */
export async function startLockedUseValidationFixture(path: string, signal: AbortSignal): Promise<LockedUseValidationFixture & { close(): Promise<void> }> {
  const child = spawn(path, ["--attended-fixture"], {
    stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
  });
  let latest: { processID: number; windowID: number; counter: number } | undefined;
  let failure: Error | undefined;
  let buffer = "";
  child.on("error", error => { failure = error; });
  child.stderr.resume();
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    if (Buffer.byteLength(buffer) > 8192) { failure = new Error("locked_use_validation_fixture_output_oversized"); child.kill(); return; }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const value: unknown = JSON.parse(line);
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid");
        const message = value as Record<string, unknown>;
        if (message.event !== "validationFixture" || message.processID !== child.pid
          || !Number.isSafeInteger(message.windowID) || (message.windowID as number) <= 0
          || !Number.isSafeInteger(message.counter) || (message.counter as number) < 0
          || latest && (latest.windowID !== message.windowID || message.counter !== latest.counter + 1)) throw new Error("invalid");
        latest = { processID: message.processID as number, windowID: message.windowID as number, counter: message.counter as number };
      } catch { failure = new Error("locked_use_validation_fixture_output_invalid"); }
    }
  });
  const close = () => stopFixture(child);
  const waitForCounter = async (value: number, callerSignal: AbortSignal): Promise<void> => {
    const deadline = performance.now() + 10_000;
    while (performance.now() < deadline) {
      callerSignal.throwIfAborted();
      if (failure) throw failure;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("locked_use_validation_fixture_exited");
      if (latest?.counter === value) return;
      if (latest && latest.counter > value) throw new Error("locked_use_validation_fixture_counter_mismatch");
      await wait(25, undefined, { signal: callerSignal });
    }
    throw new Error("locked_use_validation_fixture_counter_timeout");
  };
  try {
    await waitForCounter(0, signal);
    return { processID: latest!.processID, windowID: latest!.windowID, waitForCounter, close };
  } catch (error) { await close(); throw error; }
}

async function stopFixture(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const exited = once(child, "exit").then(() => undefined);
  child.kill("SIGTERM");
  const timeout = AbortSignal.timeout(3000);
  try { await Promise.race([exited, wait(3000, undefined, { signal: timeout }).then(() => { throw new Error("fixture_stop_timeout"); })]); }
  catch { child.kill("SIGKILL"); await exited; }
}
