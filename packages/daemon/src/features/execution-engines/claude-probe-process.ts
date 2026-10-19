import { spawn } from "node:child_process";
import { NativeConnectionError } from "./codex-connection.js";
import { buildNativeProcessEnvironment, killOwnedProbe } from "./installation-probe.js";

/** Capture one public CLI diagnostic; never expose its raw output or accept evidence before close. */
export async function captureClaudeProbeProcess(options: {
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly root: string;
  readonly signal: AbortSignal;
  readonly launch: typeof spawn;
}): Promise<{ readonly exitCode: 0 | 1; readonly payload: unknown }> {
  options.signal.throwIfAborted();
  const child = options.launch(options.executable, options.args, { cwd: options.root,
    env: { ...buildNativeProcessEnvironment(process.env, options.root), ...options.environment },
    shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  let failure: NativeConnectionError | undefined, bytes = 0;
  const chunks: Buffer[] = [];
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let rejectInterrupted: (error: NativeConnectionError) => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
  // Attach before any asynchronous spawn, stream or cancellation event can reject it.
  void interrupted.catch(() => {});
  const fail = (code: ConstructorParameters<typeof NativeConnectionError>[0]): void => {
    if (failure) return;
    failure = new NativeConnectionError(code);
    rejectInterrupted(failure);
    killOwnedProbe(child);
  };
  const failed = (): void => fail("process_failed");
  const aborted = (): void => fail("cancelled");
  const exited = (): void => killOwnedProbe(child);
  const consume = (chunk: Buffer | string, stdout: boolean): void => {
    if (failure) return;
    if (!Buffer.isBuffer(chunk) && typeof chunk !== "string") { fail("protocol_error"); return; }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 64 * 1024) { fail("output_limit"); return; }
    if (stdout) chunks.push(buffer);
  };
  const stdout = (chunk: Buffer | string): void => consume(chunk, true);
  const stderr = (chunk: Buffer | string): void => consume(chunk, false);
  child.on("error", failed);
  child.once("exit", exited);
  child.stdout?.on("data", stdout).on("error", failed);
  child.stderr?.on("data", stderr).on("error", failed);
  options.signal.addEventListener("abort", aborted, { once: true });
  try {
    if (!child.stdout || !child.stderr) failed();
    if (options.signal.aborted) aborted();
    const status = await Promise.race([closed, interrupted]);
    if (failure) throw failure;
    options.signal.throwIfAborted();
    if (status.signal !== null || (status.code !== 0 && status.code !== 1)) throw new NativeConnectionError("process_failed");
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)).trim();
      return { exitCode: status.code, payload: JSON.parse(text) as unknown };
    } catch {
      throw new NativeConnectionError(status.code === 0 ? "protocol_error" : "process_failed");
    }
  } finally {
    options.signal.removeEventListener("abort", aborted);
    killOwnedProbe(child);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([closed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { killOwnedProbe(child); reject(new NativeConnectionError("cleanup_failed")); }, 1000);
      })]);
      if (failure) throw failure;
    } finally {
      clearTimeout(timer);
      child.stdout?.destroy(); child.stderr?.destroy();
      child.off("error", failed).off("exit", exited);
      child.stdout?.off("data", stdout).off("error", failed);
      child.stderr?.off("data", stderr).off("error", failed);
    }
  }
}
