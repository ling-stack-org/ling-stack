import type { ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { TerminalOutputResponse, WaitForTerminalExitResponse } from "@agentclientprotocol/sdk";
import { preparePlatformNativeProcessLaunch, type PlatformNativeProcessInput } from "../sandbox/native-process-launch.js";

export interface HostTerminalProcessOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly policyProfileId: PlatformNativeProcessInput["policyProfileId"];
  readonly allowedWritePaths: readonly string[];
  readonly outputByteLimit?: number;
  readonly timeoutMs?: number;
  readonly signal: AbortSignal;
  /** Synchronous action/approval fence after async preparation, directly before spawn. */
  readonly beforeSpawn?: () => void;
}
export class HostTerminalProcessError extends Error {
  constructor(readonly code: "terminal_invalid" | "terminal_start_failed" | "terminal_io_failed"
    | "terminal_cleanup_failed" | "terminal_disposed") { super(code); }
}
const invalid = (): never => { throw new HostTerminalProcessError("terminal_invalid"); };

/** A contained command, not approval authority or permission to activate an engine. */
export async function startBoundedHostTerminal(input: HostTerminalProcessOptions): Promise<HostTerminalProcess> {
  const options = { ...input, args: [...input.args], allowedWritePaths: [...input.allowedWritePaths],
    outputByteLimit: input.outputByteLimit ?? 4 * 1024 * 1024, timeoutMs: input.timeoutMs ?? 300_000 };
  if (![options.executable, options.cwd, options.workspaceRoot].every(path => typeof path === "string" && isAbsolute(path))
    || options.args.length > 256 || options.args.some(arg => typeof arg !== "string" || arg.includes("\0"))
    || Buffer.byteLength(JSON.stringify(options.args)) > 64 * 1024
    || !Number.isSafeInteger(options.outputByteLimit) || options.outputByteLimit < 0 || options.outputByteLimit > 4 * 1024 * 1024
    || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 300_000) invalid();
  options.signal.throwIfAborted();
  let root: string | undefined;
  let terminal: HostTerminalProcess | undefined;
  try {
    root = await realpath(await mkdtemp(join(tmpdir(), "ling-host-terminal-")));
    const operationRoot = join(root, "operation"), nativeHome = join(root, "home");
    await mkdir(operationRoot, { mode: 0o700 });
    await mkdir(nativeHome, { mode: 0o700 });
    const launch = await preparePlatformNativeProcessLaunch({ executable: options.executable,
      workspaceRoot: options.workspaceRoot, operationRoot, nativeHome, terminalCwd: options.cwd,
      policyProfileId: options.policyProfileId, allowedWritePaths: options.allowedWritePaths });
    options.signal.throwIfAborted();
    const checked: unknown = options.beforeSpawn?.();
    if (checked && typeof checked === "object" && "then" in checked && typeof checked.then === "function") {
      void Promise.resolve(checked).catch(() => {});
      invalid();
    }
    options.signal.throwIfAborted();
    const child = launch(options.executable, options.args, { cwd: options.cwd, shell: false,
      detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: nativeHome, TMPDIR: operationRoot,
        TMP: operationRoot, TEMP: operationRoot, XDG_CONFIG_HOME: nativeHome,
        XDG_DATA_HOME: nativeHome, XDG_CACHE_HOME: nativeHome, NO_COLOR: "1", TERM: "dumb",
        GIT_TERMINAL_PROMPT: "0", SHELL: options.executable } });
    terminal = new HostTerminalProcess(child, root, options.outputByteLimit, options.timeoutMs, options.signal);
    await terminal.started;
    options.signal.throwIfAborted();
    return terminal;
  } catch (error) {
    if (terminal) await terminal.dispose();
    else if (root) await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export class HostTerminalProcess {
  readonly started: Promise<void>;
  readonly #closed: Promise<void>;
  readonly #child: ChildProcess;
  readonly #limit: number;
  readonly #requestStop: () => void;
  #output = Buffer.alloc(0);
  #truncated = false;
  #exit?: WaitForTerminalExitResponse;
  #failure?: HostTerminalProcessError;
  #closedObserved = false;
  #released = false;
  #disposal?: Promise<void>;
  #stopTimer?: NodeJS.Timeout;
  #groupAbsence?: Promise<void>;

  constructor(child: ChildProcess, readonly operationRoot: string, limit: number, timeoutMs: number, signal: AbortSignal) {
    this.#child = child; this.#limit = limit;
    let started = false;
    let resolveStarted!: () => void, rejectStarted!: (error: Error) => void;
    this.started = new Promise((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
    void this.started.catch(() => {});
    let close!: () => void, failClose!: (error: Error) => void;
    this.#closed = new Promise((resolve, reject) => { close = resolve; failClose = reject; });
    void this.#closed.catch(() => {});
    const stdout = new StringDecoder("utf8"), stderr = new StringDecoder("utf8");
    const abort = (): void => this.#stop(error => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      rejectStarted(error);
      failClose(error);
    });
    this.#requestStop = abort;
    const timeout = setTimeout(abort, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    child.once("spawn", () => { started = true; resolveStarted(); });
    child.on("error", () => {
      if (this.#stopTimer) this.#failure = new HostTerminalProcessError("terminal_cleanup_failed");
      else this.#failure ??= new HostTerminalProcessError(started ? "terminal_io_failed" : "terminal_start_failed");
      rejectStarted(this.#failure); abort();
    });
    const failedStream = (): void => { this.#failure ??= new HostTerminalProcessError("terminal_io_failed"); abort(); };
    child.stdout?.on("data", (chunk: Buffer) => this.#append(stdout.write(chunk))).on("error", failedStream);
    child.stderr?.on("data", (chunk: Buffer) => this.#append(stderr.write(chunk))).on("error", failedStream);
    // A fork can outlive the first group signal. Reap again once the parent cannot fork.
    child.once("exit", () => {
      if (this.#stopTimer) this.#signalGroup(true);
      else abort();
    });
    child.once("close", (exitCode, exitSignal) => {
      this.#closedObserved = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      this.#append(stdout.end()); this.#append(stderr.end());
      if (started && Number.isSafeInteger(exitCode) && exitCode! >= 0) this.#exit = { exitCode };
      else if (started && exitSignal) this.#exit = { signal: exitSignal };
      else this.#failure ??= new HostTerminalProcessError("terminal_start_failed");
      if (!started) rejectStarted(this.#failure!);
      const settle = (): void => {
        clearTimeout(this.#stopTimer);
        if (this.#failure?.code === "terminal_cleanup_failed") failClose(this.#failure);
        else close();
      };
      if (this.#groupAbsence) void this.#groupAbsence.then(settle, () => {
        this.#failure = new HostTerminalProcessError("terminal_cleanup_failed"); settle();
      });
      else settle();
    });
    if (signal.aborted) abort();
  }

  get pid(): number { return this.#child.pid!; }

  output(): TerminalOutputResponse {
    this.#assertUsable();
    return { output: this.#output.toString("utf8"), truncated: this.#truncated,
      ...(this.#exit ? { exitStatus: { ...this.#exit } } : {}) };
  }

  async waitForExit(signal?: AbortSignal): Promise<WaitForTerminalExitResponse> {
    this.#assertUsable();
    signal?.throwIfAborted();
    let abort!: () => void;
    try {
      await Promise.race([this.#closed, ...(signal ? [new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      })] : [])]);
    } finally { if (abort) signal?.removeEventListener("abort", abort); }
    this.#assertUsable();
    if (!this.#exit) throw new HostTerminalProcessError("terminal_io_failed");
    return { ...this.#exit };
  }

  async kill(): Promise<void> {
    if (this.#released) throw new HostTerminalProcessError("terminal_disposed");
    await this.#terminate();
  }

  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#released = true;
    this.#disposal = (async () => {
      await this.#terminate();
      await rm(this.operationRoot, { recursive: true, force: true });
      this.#output = Buffer.alloc(0);
    })();
    void this.#disposal.catch(() => {});
    return this.#disposal;
  }

  async #terminate(): Promise<void> {
    this.#requestStop();
    // A close caused by destroyed pipes cannot overwrite a previously failed cleanup.
    await this.#closed;
    if (!this.#closedObserved) throw new HostTerminalProcessError("terminal_cleanup_failed");
  }

  #stop(fail: (error: Error) => void): void {
    if (this.#closedObserved || this.#stopTimer) return;
    // Signal errors may synchronously reenter through the child's error event.
    this.#stopTimer = setTimeout(() => {
      this.#failure = new HostTerminalProcessError("terminal_cleanup_failed");
      this.#child.stdout?.destroy(); this.#child.stderr?.destroy(); this.#child.unref();
      fail(this.#failure);
    }, 1000);
    this.#signalGroup();
  }

  #signalGroup(afterParentExit = false): void {
    if (process.platform !== "win32" && this.#child.pid) {
      try { process.kill(-this.#child.pid, "SIGKILL"); return; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        // macOS may return EPERM while the already-signalled group disappears.
        if (afterParentExit && process.platform === "darwin" && (error as NodeJS.ErrnoException).code === "EPERM") {
          this.#groupAbsence ??= this.#confirmGroupGone(this.#child.pid);
          void this.#groupAbsence.catch(() => {});
          return;
        }
        this.#failure = new HostTerminalProcessError("terminal_cleanup_failed");
      }
    }
    // Killing only the parent is best effort, never proof of successful group cleanup.
    try { this.#child.kill("SIGKILL"); }
    catch { this.#failure = new HostTerminalProcessError("terminal_cleanup_failed"); }
  }

  async #confirmGroupGone(pid: number): Promise<void> {
    for (;;) {
      if (this.#failure?.code === "terminal_cleanup_failed") throw this.#failure;
      try { process.kill(-pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw new HostTerminalProcessError("terminal_cleanup_failed");
      }
      // The original stop timer remains armed even if the output pipes close first.
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
  }

  #assertUsable(): void {
    if (this.#released) throw new HostTerminalProcessError("terminal_disposed");
    if (this.#failure) throw this.#failure;
  }

  #append(value: string): void {
    if (!value) return;
    const bytes = Buffer.concat([this.#output, Buffer.from(value)]);
    let start = Math.max(0, bytes.length - this.#limit);
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    this.#truncated ||= start > 0;
    this.#output = Buffer.from(bytes.subarray(start));
  }
}
