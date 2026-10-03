import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Socket } from "node:net";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { assertHostMcpOperation, McpHostAdmissionError, type HostMcpOperation } from "./host-operation.js";
import { MCP_STDIO_MAX_BUFFER_BYTES, type McpStdioLaunchInput } from "./stdio-launcher.js";

const EOF_GRACE_MS = 250;
const TERMINATE_GRACE_MS = 500;
const CLEANUP_DEADLINE_MS = 1500;
const EXIT_DRAIN_MS = 1000;
const DEFAULT_SEND_TIMEOUT_MS = 30_000;
const MAX_PENDING_SENDS = 64;
const MAX_TIMER_MS = 2_147_483_647;

/** Only the original Host issuer supplies this seam; it is never a remote receipt. */
export interface HostMcpStdioOperation extends HostMcpOperation {
  cleanupConnectionEffect(effect: () => void): void;
}

/** Local observation only: neither leader exit nor closed pipes prove remote/descendant safety. */
export interface HostMcpStdioCloseObservation {
  readonly leaderExited: boolean;
  readonly stdioClosed: boolean;
  readonly descendants: "unverified";
  readonly settledBy: "close" | "cleanup_deadline" | "not_started";
  readonly cleanupFailures: readonly string[];
}

export interface HostMcpStdioTransport extends Transport {
  getCloseObservation(): HostMcpStdioCloseObservation | undefined;
}

export function createHostMcpStdioTransport(input: {
  readonly launch: McpStdioLaunchInput;
  readonly operation: HostMcpStdioOperation;
  readonly signal?: AbortSignal;
  readonly sendTimeoutMs?: number;
}): HostMcpStdioTransport {
  assertHostMcpOperation(input.operation);
  if (typeof input.operation.cleanupConnectionEffect !== "function") {
    throw new McpHostAdmissionError("mcp_host_admission_unsupported", "An issued connection cleanup seam is required.");
  }
  return new OwnedStdioTransport(input);
}

/**
 * One Host-owned process, speaking the SDK public Transport contract.
 * forward: Core gate -> native spawn/write; cleanup: original gate -> end/kill.
 * No SDK private process access, alternate launcher, replay or whole-operation settlement.
 */
class OwnedStdioTransport implements HostMcpStdioTransport {
  onmessage?: Transport["onmessage"];
  onerror?: Transport["onerror"];
  onclose?: Transport["onclose"];
  readonly #launch: McpStdioLaunchInput;
  readonly #operation: HostMcpStdioOperation;
  readonly #signal?: AbortSignal;
  readonly #sendTimeoutMs: number;
  readonly #readBuffer = new ReadBuffer({ maxBufferSize: MCP_STDIO_MAX_BUFFER_BYTES });
  readonly #ready = deferred();
  readonly #closed = deferred();
  readonly #pendingSends = new Set<(error: Error) => void>();
  readonly #pendingDrains = new Set<() => void>();
  readonly #cleanupFailures: string[] = [];
  #pendingBytes = 0;
  #child?: ChildProcessWithoutNullStreams;
  #state: "new" | "starting" | "running" | "closing" | "closed" = "new";
  #started = false;
  #leaderExited = false;
  #stdioClosed = false;
  #exitDrainTimer?: NodeJS.Timeout;
  #observation?: HostMcpStdioCloseObservation;

  constructor(input: {
    readonly launch: McpStdioLaunchInput;
    readonly operation: HostMcpStdioOperation;
    readonly signal?: AbortSignal;
    readonly sendTimeoutMs?: number;
  }) {
    this.#launch = Object.freeze({ ...input.launch, args: Object.freeze([...input.launch.args]), env: Object.freeze({ ...input.launch.env }) });
    this.#operation = input.operation;
    this.#signal = input.signal;
    this.#sendTimeoutMs = boundedTimeout(input.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS);
    // A gate/COMMIT error can occur before start returns its ready promise.
    void this.#ready.promise.catch(() => {});
  }

  async start(): Promise<void> {
    if (this.#started || this.#state !== "new") throw transportError("already_started");
    this.#started = true;
    this.#signal?.throwIfAborted();
    this.#operation.assertMayPrepare();
    this.#state = "starting";
    this.#signal?.addEventListener("abort", this.#onAbort, { once: true });
    try {
      this.#operation.launchConnectionEffect(() => {
        // Retain the original object/listeners before Core can throw at COMMIT.
        this.#child = spawn(this.#launch.command, [...this.#launch.args], {
          env: { ...getDefaultEnvironment(), ...this.#launch.env },
          cwd: this.#launch.cwd, stdio: ["pipe", "pipe", "pipe"], shell: false,
          windowsHide: process.platform === "win32",
        });
        this.#observe(this.#child);
      });
      if (this.#signal?.aborted) this.#onAbort();
      await this.#ready.promise;
    } catch (error) {
      this.#ready.reject(transportError("start_failed"));
      void this.close();
      throw error;
    }
  }

  send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this.#state !== "running" || !this.#child || this.#leaderExited) return Promise.reject(transportError("not_connected"));
    let frame: string;
    try { frame = serializeMessage(message); }
    catch { return Promise.reject(transportError("invalid_message")); }
    const size = Buffer.byteLength(frame);
    if (size > MCP_STDIO_MAX_BUFFER_BYTES || this.#pendingBytes + size > MCP_STDIO_MAX_BUFFER_BYTES
      || this.#pendingSends.size >= MAX_PENDING_SENDS) return Promise.reject(transportError("send_budget_exceeded"));
    const child = this.#child;
    this.#pendingBytes += size;
    return new Promise<void>((resolve, reject) => {
      let settled = false, callbackDone = false, writeReturned = false, needsDrain = false, drained = false;
      const timer = setTimeout(() => finish(transportError("send_timeout")), this.#sendTimeoutMs);
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#pendingDrains.delete(onDrain);
        this.#pendingSends.delete(fail);
        this.#pendingBytes -= size;
        if (error) { reject(error); this.#fail(error); }
        else resolve();
      };
      const succeed = (): void => { if (writeReturned && callbackDone && (!needsDrain || drained)) finish(); };
      const onDrain = (): void => { drained = true; succeed(); };
      const fail = (error: Error): void => finish(error);
      this.#pendingSends.add(fail);
      this.#pendingDrains.add(onDrain);
      // SDK callTool creates send synchronously inside the parent Core gate.
      // Defer physical I/O until that transaction closes, then recheck the exact
      // source at the actual write. A parent COMMIT failure can seal us first.
      queueMicrotask(() => {
        if (settled) return;
        try {
          if (this.#state !== "running" || this.#child !== child || this.#leaderExited) throw transportError("not_connected");
          this.#signal?.throwIfAborted();
          this.#operation.launchConnectionEffect(() => {
            // Never repeat a frame after false/drain or after a COMMIT failure.
            needsDrain = !child.stdin.write(frame, error => {
              if (error) { finish(nativeError(error, "write_failed")); return; }
              callbackDone = true;
              succeed();
            });
          });
          writeReturned = true;
          succeed();
        } catch (error) {
          // The original Core fault is preserved, but any pending native callback stays observed.
          finish(error instanceof Error ? error : transportError("write_gate_failed"));
        }
      });
    });
  }

  /** Reentrant callers share one promise and cannot restart the shutdown deadline. */
  close(): Promise<void> {
    if (this.#state === "closed" || this.#state === "closing") return this.#closed.promise;
    this.#state = "closing";
    this.#ready.reject(transportError("closed"));
    this.#rejectPending(transportError("closed"));
    this.#signal?.removeEventListener("abort", this.#onAbort);
    clearTimeout(this.#exitDrainTimer);
    if (!this.#child) this.#finish("not_started");
    else void this.#closeChild();
    return this.#closed.promise;
  }

  getCloseObservation(): HostMcpStdioCloseObservation | undefined { return this.#observation; }

  #observe(child: ChildProcessWithoutNullStreams): void {
    child.once("spawn", this.#onSpawn);
    child.on("error", this.#onProcessError);
    child.on("exit", this.#onExit);
    child.on("close", this.#onClose);
    child.stdout.on("data", this.#onStdout);
    child.stdout.on("error", this.#onPipeError);
    // Drain without caching raw stderr: secrets and an unlimited PassThrough are both unsafe.
    child.stderr.on("data", discardChunk);
    child.stderr.on("error", this.#onPipeError);
    child.stdin.on("error", this.#onPipeError);
    child.stdin.on("drain", this.#onDrain);
  }

  readonly #onSpawn = (): void => {
    if (this.#state !== "starting") return;
    this.#state = "running";
    this.#ready.resolve();
  };
  readonly #onAbort = (): void => { this.#fail(transportError("aborted")); };
  readonly #onProcessError = (error: Error): void => {
    const safeError = nativeError(error, "process_error");
    this.#ready.reject(safeError);
    this.#fail(safeError);
  };
  readonly #onPipeError = (error: Error): void => { this.#fail(nativeError(error, "pipe_error")); };
  readonly #onDrain = (): void => { for (const observe of [...this.#pendingDrains]) observe(); };
  readonly #onExit = (): void => {
    this.#leaderExited = true;
    this.#rejectPending(transportError("process_exited"));
    if (this.#state !== "closed" && this.#state !== "closing") {
      this.#exitDrainTimer = setTimeout(() => { void this.close(); }, EXIT_DRAIN_MS);
    }
  };
  readonly #onClose = (): void => { this.#stdioClosed = true; this.#finish("close"); };
  readonly #onStdout = (chunk: Buffer): void => {
    if (this.#state !== "running" && this.#state !== "starting") return;
    try {
      this.#readBuffer.append(chunk);
      while (this.#state === "running" || this.#state === "starting") {
        const message = this.#readBuffer.readMessage();
        if (message === null) break;
        this.#operation.assertMayPrepare();
        this.onmessage?.(message);
      }
    } catch (error) {
      // Framing, callback and source failures all seal future dispatch before closing.
      this.#fail(error instanceof McpHostAdmissionError ? error : transportError("receive_failed"));
    }
  };

  #fail(error: Error): void {
    if (this.#state === "closed" || this.#state === "closing") return;
    // Seal before invoking an out-of-band observer: it must not dispatch a new frame.
    const close = this.close();
    try { this.onerror?.(error); } catch { this.#rememberFailure("error_observer_failed"); }
    void close;
  }

  #rejectPending(error: Error): void {
    for (const finish of [...this.#pendingSends]) finish(error);
  }

  async #closeChild(): Promise<void> {
    const child = this.#child!;
    try {
      const deadline = Date.now() + CLEANUP_DEADLINE_MS;
      this.#cleanup(() => { if (!child.stdin.destroyed) child.stdin.end(); }, "stdin_end");
      if (await this.#waitClosed(EOF_GRACE_MS)) return;
      this.#signalChild(child, "SIGTERM");
      if (await this.#waitClosed(TERMINATE_GRACE_MS)) return;
      this.#signalChild(child, "SIGKILL");
      if (await this.#waitClosed(Math.max(1, deadline - Date.now()))) return;
      this.#finish("cleanup_deadline");
    } catch {
      this.#rememberFailure("close_observer_failed");
      this.#finish("cleanup_deadline");
    }
  }

  #signalChild(child: ChildProcessWithoutNullStreams, signal: "SIGTERM" | "SIGKILL"): void {
    if (this.#state === "closed" || this.#leaderExited || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    this.#cleanup(() => {
      // Only this exact object is targeted; no PID lookup or successor-source fallback.
      if (!child.kill(signal)) this.#rememberFailure(`${signal.toLowerCase()}_not_delivered`);
    }, signal.toLowerCase());
  }

  #cleanup(effect: () => void, stage: string): void {
    try { this.#operation.cleanupConnectionEffect(effect); }
    catch (error) { this.#rememberFailure(`${stage}:${errorCode(error)}`); }
  }

  async #waitClosed(durationMs: number): Promise<boolean> {
    if (this.#state === "closed") return true;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([this.#closed.promise.then(() => true), new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), durationMs);
      })]);
    } finally { clearTimeout(timer); }
  }

  #finish(settledBy: HostMcpStdioCloseObservation["settledBy"]): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    clearTimeout(this.#exitDrainTimer);
    this.#signal?.removeEventListener("abort", this.#onAbort);
    this.#ready.reject(transportError("closed"));
    this.#rejectPending(transportError("closed"));
    this.#readBuffer.clear();
    const child = this.#child;
    if (child) {
      this.#leaderExited ||= child.exitCode !== null || child.signalCode !== null;
      child.removeListener("spawn", this.#onSpawn);
      child.removeListener("error", this.#onProcessError);
      child.removeListener("exit", this.#onExit);
      child.removeListener("close", this.#onClose);
      child.stdout.removeListener("data", this.#onStdout);
      child.stdout.removeListener("error", this.#onPipeError);
      child.stderr.removeListener("data", discardChunk);
      child.stderr.removeListener("error", this.#onPipeError);
      child.stdin.removeListener("error", this.#onPipeError);
      child.stdin.removeListener("drain", this.#onDrain);
      // Inert sinks prevent a late native error from crashing the Host; they never write Store/UI.
      child.on("error", discardError);
      for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe.on("error", discardError);
      if (!this.#stdioClosed) {
        this.#cleanup(() => { if (!child.stdin.destroyed) child.stdin.destroy(); }, "stdin_destroy");
        child.stdout.destroy();
        child.stderr.destroy();
        if (child.stdin instanceof Socket) child.stdin.unref();
        child.unref();
      }
    }
    this.#observation = Object.freeze({ leaderExited: this.#leaderExited, stdioClosed: this.#stdioClosed,
      descendants: "unverified", settledBy, cleanupFailures: Object.freeze([...this.#cleanupFailures]) });
    try { this.onclose?.(); } catch { /* SDK/observer closure cannot reopen this sealed transport. */ }
    this.#closed.resolve();
  }

  #rememberFailure(code: string): void { if (this.#cleanupFailures.length < 8) this.#cleanupFailures.push(code); }
}

function deferred(): { readonly promise: Promise<void>; resolve(): void; reject(error: Error): void } {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function transportError(code: string): Error { return new McpHostAdmissionError(`mcp_stdio_${code}`, "MCP stdio transport could not complete the local operation."); }
function errorCode(error: unknown): string {
  const code = (error as { readonly code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^[a-zA-Z0-9_.:-]{1,96}$/u.test(code) ? code : "unknown";
}
function nativeError(error: unknown, fallback: string): Error { return transportError(`${fallback}:${errorCode(error)}`); }
function boundedTimeout(value: number): number { return Number.isFinite(value) && value > 0 ? Math.min(MAX_TIMER_MS, Math.max(1, Math.floor(value))) : 1; }
function discardChunk(_chunk: Buffer): void { /* Drain only; never retain raw stderr. */ }
function discardError(_error: Error): void { /* Closed local handle, no callbacks or writes. */ }
