import type { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { buildNativeProcessEnvironment, killOwnedProbe } from "./installation-probe.js";
import { NativeConnectionError } from "./codex-connection.js";

interface Options {
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly root: string;
  readonly signal: AbortSignal;
  readonly launch: typeof spawn;
  readonly maxOutputBytes?: number;
  readonly maxStderrBytes?: number;
  readonly assertCurrentAuthority?: () => void;
  readonly onLocalLifetime?: (lifetime: Promise<unknown>) => void;
}
export interface OwnedNativeStreams {
  readonly input: Writable;
  readonly output: Readable;
  readonly signal: AbortSignal;
  /** Declare intentional transport shutdown before closing either one-use pipe. */
  readonly beginLocalCleanup: () => void;
}

/** Owns one child tree until operation completion and reaping, never native account authority. */
export async function withOwnedNativeProcess<T>(options: Options, operation: (streams: OwnedNativeStreams) => Promise<T>): Promise<T> {
  const maxOutput = options.maxOutputBytes ?? 64 * 1024;
  const maxStderr = options.maxStderrBytes ?? 64 * 1024;
  if (![maxOutput, maxStderr].every(limit => Number.isSafeInteger(limit) && limit > 0 && limit <= 2 ** 30)) {
    throw new NativeConnectionError("output_limit");
  }
  options.signal.throwIfAborted();
  options.assertCurrentAuthority?.();
  const child = options.launch(options.executable, options.args, {
    cwd: options.root, env: { ...buildNativeProcessEnvironment(process.env, options.root), ...options.environment },
    shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32",
  });
  const stopped = new AbortController();
  const signal = AbortSignal.any([options.signal, stopped.signal]);
  let failure: NativeConnectionError | undefined;
  let bytes = 0;
  let stderrBytes = 0;
  let phase: "active" | "local_closing" | "reaping" = "active";
  const beginLocalCleanup = (): void => { if (phase === "active") phase = "local_closing"; };
  const fail = (code: "process_failed" | "output_limit"): void => {
    failure ??= new NativeConnectionError(code);
    stopped.abort();
    killOwnedProbe(child);
  };
  const failed = (): void => fail("process_failed");
  const consume = (chunk: Buffer): void => { bytes += chunk.length; if (bytes > maxOutput) fail("output_limit"); };
  const stderr = (chunk: Buffer): void => { stderrBytes += chunk.length; consume(chunk); if (stderrBytes > maxStderr) fail("output_limit"); };
  const exited = (): void => { if (phase === "active") failed(); };
  child.once("error", failed).once("exit", exited);
  child.stdin?.on("error", failed);
  child.stdout?.on("data", consume).on("error", failed);
  child.stderr?.on("data", stderr).on("error", failed);
  const closed = new Promise<void>(resolve => child.once("close", () => {
    // Expected local shutdown must not cancel the operation still draining its pipes.
    if (phase === "active") { failure ??= new NativeConnectionError("process_failed"); stopped.abort(); }
    resolve();
  }));
  let rejectCancelled: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    rejectCancelled = () => reject(failure ?? new NativeConnectionError("cancelled"));
    signal.addEventListener("abort", rejectCancelled, { once: true });
  });
  let result: T;
  try {
    if (!child.stdin || !child.stdout) throw new NativeConnectionError("process_failed");
    signal.throwIfAborted();
    const execution = Promise.resolve().then(() => operation({ input: child.stdin!, output: child.stdout!, signal, beginLocalCleanup }));
    // Cancellation can return early, but it cannot end an uncooperative original
    // callback or certify physical process close. Admission observes this lifetime.
    options.onLocalLifetime?.(Promise.allSettled([execution, closed]));
    result = await Promise.race([execution, cancelled]);
    if (failure) throw failure;
  } finally {
    phase = "reaping";
    signal.removeEventListener("abort", rejectCancelled);
    stopped.abort();
    killOwnedProbe(child);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([closed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          killOwnedProbe(child);
          child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
          reject(new NativeConnectionError("cleanup_failed"));
        }, 1000);
      })]);
    } finally {
      clearTimeout(timer);
      child.off("error", failed).off("exit", exited);
      child.stdin?.off("error", failed);
      child.stdout?.off("data", consume).off("error", failed);
      child.stderr?.off("data", stderr).off("error", failed);
    }
  }
  if (failure) throw failure;
  if (options.signal.aborted) throw new NativeConnectionError("cancelled");
  return result;
}
