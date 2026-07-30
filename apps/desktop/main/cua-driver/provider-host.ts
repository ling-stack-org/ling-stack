import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import type { Writable, Readable } from "node:stream";
import type { CuaDriverStateRoot } from "./state-root.js";
import type { CuaDriverTelemetrySink } from "./telemetry.js";
import { createCuaDriverTelemetry, redactCuaDriverDiagnostic } from "./telemetry.js";
import {
  createCuaDriverInputFenceConfiguration,
  fenceCuaDriverInput,
  type CuaDriverInputFenceAcknowledgement,
  type CuaDriverInputFenceConfiguration,
} from "./input-fence-client.js";

export const CUA_DRIVER_MCP_ARGS = [
  "mcp",
  "--embedded",
  "--host-bundle-id",
  "com.lingstack.desktop",
] as const;
export const DEFAULT_CUA_DRIVER_JSON_RPC_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_CUA_DRIVER_STDERR_MAX_BYTES = 64 * 1024;

export type JsonRpcId = string | number;
export type JsonRpcParams = Readonly<Record<string, unknown>> | readonly unknown[];

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: JsonRpcParams;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: JsonRpcParams;
}

export interface JsonRpcSuccessResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: unknown;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcClientMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;
export type JsonRpcServerMessage = JsonRpcRequest | JsonRpcNotification;

export type CuaDriverProviderHostState =
  | "idle"
  | "starting"
  | "awaiting_initialize"
  | "initializing"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";

export type CuaDriverProviderHostErrorCode =
  | "already_initialized"
  | "child_terminal"
  | "generation_mismatch"
  | "initialize_invalid"
  | "message_invalid"
  | "message_oversized"
  | "not_initialized"
  | "pre_spawn_validation_failed"
  | "request_timeout"
  | "reserved_namespace"
  | "spawn_failed"
  | "write_failed";

export class CuaDriverProviderHostError extends Error {
  constructor(readonly code: CuaDriverProviderHostErrorCode, message: string = code) {
    super(message);
    this.name = "CuaDriverProviderHostError";
  }
}

export type CuaDriverProviderPreSpawnFailureKind = "artifact_invalid" | "platform_unavailable";

export class CuaDriverProviderPreSpawnError extends Error {
  readonly code = "cua_driver_pre_spawn_failed" as const;

  constructor(readonly failureKind: CuaDriverProviderPreSpawnFailureKind) {
    super(`pre_spawn_${failureKind}`);
    this.name = "CuaDriverProviderPreSpawnError";
  }
}

export interface CuaDriverProviderProcessLifecycle {
  /**
   * Windows retains the ChildProcess handle; the patched Rust child owns the
   * private KILL_ON_JOB_CLOSE Job Object that contains all descendants.
   */
  readonly lifetimeBoundary: "darwin-direct-child" | "windows-job-object" | "test-fixture";
  prepareSpawn?(input: {
    readonly executablePath: string;
    readonly executableDigest: string;
    readonly signal: AbortSignal;
  }): Promise<CuaDriverPreparedProviderSpawn>;
  spawn(input: {
    readonly executablePath: string;
    readonly executableDigest?: string;
    readonly preparedSpawn?: CuaDriverPreparedProviderSpawn;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
  }): ChildProcess;
  terminate(child: ChildProcess): Promise<void>;
  /** Bypass graceful shutdown after a missed security-boundary acknowledgement. */
  terminateImmediately?(child: ChildProcess): Promise<void>;
  assertNoResidue?(input: { readonly pid: number | undefined; readonly generation: number }): Promise<void>;
}

export interface CuaDriverPreparedProviderSpawn {
  readonly executablePath: string;
  readonly executableDigest: string;
  release(): Promise<void>;
  abort(): Promise<void>;
}

export interface CuaDriverProviderHostOptions {
  readonly executablePath: string;
  readonly executableDigest?: string;
  readonly stateRoot: CuaDriverStateRoot;
  readonly generation: number;
  readonly platform?: "darwin" | "win32";
  readonly hostProcessId?: number;
  readonly childInstanceNonce?: string;
  readonly baseEnvironment?: NodeJS.ProcessEnv;
  readonly lifecycle?: CuaDriverProviderProcessLifecycle;
  readonly requestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly maxMessageBytes?: number;
  readonly maxStderrBytes?: number;
  readonly preSpawn?: (signal: AbortSignal) => Promise<void>;
  readonly telemetry?: CuaDriverTelemetrySink;
  readonly onTerminal?: (input: {
    readonly generation: number;
    readonly reason: string;
    readonly unexpected: boolean;
    readonly preSpawnFailureKind?: CuaDriverProviderPreSpawnFailureKind;
  }) => void;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (response: JsonRpcResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

/**
 * Owns one child and one initialized stdio session for one immutable lease
 * generation. A terminal host is never restarted; the coordinator must rotate
 * to a fresh generation.
 */
export class CuaDriverProviderHost {
  readonly generation: number;
  readonly childInstanceNonce: string;
  private readonly telemetry: CuaDriverTelemetrySink;
  private readonly lifecycle: CuaDriverProviderProcessLifecycle;
  private readonly maxMessageBytes: number;
  private readonly maxStderrBytes: number;
  private stateValue: CuaDriverProviderHostState = "idle";
  private child: ChildProcess | undefined;
  private startPromise: Promise<void> | undefined;
  private startAbortController: AbortController | undefined;
  private startEpoch = 0;
  private stopPromise: Promise<void> | undefined;
  private immediateStopPromise: Promise<void> | undefined;
  private terminal = false;
  private inputFenceConfiguration: CuaDriverInputFenceConfiguration | undefined;
  private initializeSeen = false;
  private stdoutBuffer = Buffer.alloc(0);
  private stderrBytes = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly serverRequestIds = new Set<string>();
  private readonly serverMessageListeners = new Set<(message: JsonRpcServerMessage) => void>();
  private resolveExit: (() => void) | undefined;
  private exitPromise: Promise<void> = Promise.resolve();

  constructor(private readonly options: CuaDriverProviderHostOptions) {
    if (!isAbsolute(options.executablePath)) {
      throw new CuaDriverProviderHostError("spawn_failed", "provider_executable_must_be_absolute");
    }
    if (!Number.isSafeInteger(options.generation) || options.generation <= 0) {
      throw new CuaDriverProviderHostError("generation_mismatch");
    }
    this.generation = options.generation;
    this.childInstanceNonce = options.childInstanceNonce ?? randomBytes(32).toString("base64url");
    if (!/^[A-Za-z0-9_-]{32,128}$/u.test(this.childInstanceNonce)) {
      throw new CuaDriverProviderHostError("spawn_failed", "child_instance_nonce_invalid");
    }
    this.telemetry = options.telemetry ?? createCuaDriverTelemetry();
    const platform = options.platform ?? (process.platform === "win32" ? "win32" : "darwin");
    if (platform === "win32" && options.lifecycle?.lifetimeBoundary !== "windows-job-object" && options.lifecycle?.lifetimeBoundary !== "test-fixture") {
      throw new CuaDriverProviderHostError("spawn_failed", "windows_provider_job_object_lifecycle_required");
    }
    this.lifecycle = options.lifecycle ?? defaultProviderLifecycle;
    this.maxMessageBytes = boundedPositive(options.maxMessageBytes, DEFAULT_CUA_DRIVER_JSON_RPC_MAX_BYTES, 64 * 1024 * 1024);
    this.maxStderrBytes = boundedPositive(options.maxStderrBytes, DEFAULT_CUA_DRIVER_STDERR_MAX_BYTES, 1024 * 1024);
  }

  get state(): CuaDriverProviderHostState {
    return this.stateValue;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get executablePath(): string {
    return this.options.executablePath;
  }

  get initialized(): boolean {
    return this.stateValue === "ready";
  }

  onServerMessage(listener: (message: JsonRpcServerMessage) => void): () => void {
    this.serverMessageListeners.add(listener);
    return () => this.serverMessageListeners.delete(listener);
  }

  /** Spawn is lazy and single-flight. The proxy calls this only for initialize. */
  start(): Promise<void> {
    if (this.stateValue === "awaiting_initialize" || this.stateValue === "initializing" || this.stateValue === "ready") {
      return Promise.resolve();
    }
    if (this.terminal || this.stateValue === "stopping" || this.stateValue === "stopped" || this.stateValue === "failed") {
      return Promise.reject(new CuaDriverProviderHostError("child_terminal"));
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    const startEpoch = this.startEpoch + 1;
    this.startEpoch = startEpoch;
    const abortController = new AbortController();
    this.startAbortController = abortController;
    const pending = this.startInternal(startEpoch, abortController.signal);
    this.startPromise = pending;
    void pending.finally(() => {
      if (this.startPromise === pending) {
        this.startPromise = undefined;
      }
      if (this.startAbortController === abortController) {
        this.startAbortController = undefined;
      }
    }).catch(() => undefined);
    return pending;
  }

  /**
   * Forward one daemon-side MCP message. Requests preserve their original ids;
   * notifications and client responses are written without synthesizing ids.
   */
  async exchange(message: unknown): Promise<JsonRpcResponse | undefined> {
    const parsed = parseClientJsonRpcMessage(message);
    if (isRequestLike(parsed) && (
      parsed.method.startsWith("ling/")
      || (isRequest(parsed) && typeof parsed.id === "string" && parsed.id.startsWith("ling-control:"))
    )) {
      throw new CuaDriverProviderHostError("reserved_namespace");
    }
    if (isResponse(parsed)) {
      const key = jsonRpcIdKey(parsed.id);
      if (parsed.id === null || !this.serverRequestIds.delete(key)) {
        throw new CuaDriverProviderHostError("message_invalid", "unexpected_client_response");
      }
      this.assertReady();
      await this.writeMessage(parsed);
      return undefined;
    }
    if (parsed.method === "initialize") {
      if (!isRequest(parsed)) {
        throw new CuaDriverProviderHostError("initialize_invalid", "initialize_requires_request_id");
      }
      validateInitializeRequest(parsed);
      if (this.initializeSeen) {
        throw new CuaDriverProviderHostError("already_initialized");
      }
      this.initializeSeen = true;
      await this.start();
      this.stateValue = "initializing";
      try {
        const response = await this.sendRequest(parsed);
        validateInitializeResponse(response);
        this.stateValue = "ready";
        this.telemetry.emit("info", "cua_driver.host.ready", { generation: this.generation, pid: this.pid ?? null });
        return response;
      } catch (error) {
        await this.fail("initialize_failed", error);
        throw error;
      }
    }
    this.assertReady();
    if (isRequest(parsed)) {
      return this.sendRequest(parsed);
    }
    await this.writeMessage(parsed);
    return undefined;
  }

  /** Desktop-only control path; daemon messages cannot use this namespace. */
  async requestControl(method: `ling/${string}`, params: JsonRpcParams): Promise<JsonRpcResponse> {
    if (!method.startsWith("ling/")) {
      throw new CuaDriverProviderHostError("reserved_namespace");
    }
    return this.requestDesktop(method, params);
  }

  /**
   * Desktop-only macOS readiness path. It intentionally exposes neither a tool
   * name nor arguments so ordinary daemon requests cannot be smuggled through
   * the private control channel.
   */
  async requestCheckPermissions(): Promise<JsonRpcResponse> {
    return this.requestDesktop("tools/call", {
      name: "check_permissions",
      arguments: { prompt: false },
    });
  }

  private async requestDesktop(method: string, params: JsonRpcParams): Promise<JsonRpcResponse> {
    this.assertReady();
    const id = `ling-control:${randomBytes(16).toString("hex")}`;
    return this.sendRequest({ jsonrpc: "2.0", id, method, params });
  }

  stop(reason = "shutdown"): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    const pending = this.stopInternal(reason);
    this.stopPromise = pending;
    void pending.catch(() => {
      if (this.stopPromise === pending) {
        this.stopPromise = undefined;
      }
    });
    return pending;
  }

  /** Fence the exact live generation. An unspawned generation has no input to drain. */
  async fenceInput(timeoutMs?: number): Promise<CuaDriverInputFenceAcknowledgement | undefined> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return undefined;
    }
    const configuration = this.inputFenceConfiguration;
    if (!configuration) {
      throw new CuaDriverProviderHostError("child_terminal", "provider_input_fence_unavailable");
    }
    return fenceCuaDriverInput(configuration, timeoutMs);
  }

  /**
   * Security-boundary termination. This path never waits for stdin EOF or the
   * normal graceful shutdown window before killing the retained child.
   */
  terminateImmediately(reason = "security_boundary"): Promise<void> {
    if (this.immediateStopPromise) return this.immediateStopPromise;
    const pending = this.terminateImmediatelyInternal(reason);
    this.immediateStopPromise = pending;
    void pending.finally(() => {
      if (this.immediateStopPromise === pending) this.immediateStopPromise = undefined;
    }).catch(() => undefined);
    return pending;
  }

  private async startInternal(startEpoch: number, signal: AbortSignal): Promise<void> {
    this.stateValue = "starting";
    let preparedSpawn: CuaDriverPreparedProviderSpawn | undefined;
    try {
      if (this.options.preSpawn) {
        await waitForAbort(this.options.preSpawn(signal), signal);
      }
      if (this.lifecycle.prepareSpawn) {
        if (!this.options.executableDigest) {
          throw new CuaDriverProviderPreSpawnError("artifact_invalid");
        }
        preparedSpawn = await this.lifecycle.prepareSpawn({
          executablePath: this.options.executablePath,
          executableDigest: this.options.executableDigest,
          signal,
        });
        signal.throwIfAborted();
      }
    } catch (error) {
      await preparedSpawn?.abort().catch(() => undefined);
      if (!this.isStartCurrent(startEpoch, signal)) {
        throw new CuaDriverProviderHostError("child_terminal");
      }
      this.stateValue = "failed";
      this.terminal = true;
      this.telemetry.emit("error", "cua_driver.host.pre_spawn_validation_failed", {
        generation: this.generation,
        error: error instanceof Error ? error.message : String(error),
      });
      this.notifyTerminal(
        "pre_spawn_validation_failed",
        true,
        undefined,
        error instanceof CuaDriverProviderPreSpawnError ? error.failureKind : "platform_unavailable",
      );
      throw new CuaDriverProviderHostError("pre_spawn_validation_failed");
    }
    this.assertStartCurrent(startEpoch, signal);
    const inputFenceConfiguration = await createCuaDriverInputFenceConfiguration(this.generation);
    this.assertStartCurrent(startEpoch, signal);
    this.inputFenceConfiguration = inputFenceConfiguration;
    const environment = createManagedProviderEnvironment({
      baseEnvironment: this.options.baseEnvironment ?? process.env,
      stateRoot: this.options.stateRoot,
      hostProcessId: this.options.hostProcessId ?? process.pid,
      generation: this.generation,
      childInstanceNonce: this.childInstanceNonce,
      inputFence: inputFenceConfiguration,
    });
    let child: ChildProcess;
    try {
      child = this.lifecycle.spawn({
        executablePath: this.options.executablePath,
        ...(this.options.executableDigest
          ? { executableDigest: this.options.executableDigest }
          : {}),
        ...(preparedSpawn ? { preparedSpawn } : {}),
        args: CUA_DRIVER_MCP_ARGS,
        cwd: this.options.stateRoot.rootPath,
        environment,
      });
    } catch (error) {
      await preparedSpawn?.abort().catch(() => undefined);
      this.stateValue = "failed";
      this.terminal = true;
      this.telemetry.emit("error", "cua_driver.host.spawn_failed", { generation: this.generation, error: String(error) });
      this.notifyTerminal("spawn_failed", true);
      throw new CuaDriverProviderHostError("spawn_failed");
    }
    this.child = child;
    this.exitPromise = new Promise<void>((resolveExit) => {
      this.resolveExit = resolveExit;
      child.once("exit", () => {
        if (this.child === child) {
          this.resolveExit?.();
          this.resolveExit = undefined;
        }
      });
    });
    if (preparedSpawn) {
      try {
        await preparedSpawn.release();
      } catch (error) {
        try {
          await this.stopInternal("provider_spawn_authority_release_failed", true);
        } catch {
          // The retained-child failure below remains fail-closed.
        }
        this.telemetry.emit("error", "cua_driver.host.spawn_authority_release_failed", {
          generation: this.generation,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new CuaDriverProviderHostError("spawn_failed", "provider_spawn_authority_release_failed");
      }
      this.assertStartCurrent(startEpoch, signal);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      await this.stopInternal("provider_exited_during_spawn_authority_release", true);
      this.notifyTerminal("provider_exited_during_spawn_authority_release", true, child.pid);
      throw new CuaDriverProviderHostError("spawn_failed", "provider_exited_before_stdio_attach");
    }
    if (!child.stdin || !child.stdout || !child.stderr) {
      let cleanupError: unknown;
      try {
        await this.stopInternal("provider_stdio_unavailable", true);
      } catch (error) {
        cleanupError = error;
        this.stateValue = "failed";
        this.terminal = true;
      }
      this.notifyTerminal("provider_stdio_unavailable", true, child.pid);
      if (cleanupError) {
        throw new CuaDriverProviderHostError("spawn_failed", "provider_stdio_cleanup_failed");
      }
      throw new CuaDriverProviderHostError("spawn_failed", "provider_stdio_unavailable");
    }
    this.attachChild(child, child.stdout, child.stderr);
    this.stateValue = "awaiting_initialize";
    this.telemetry.emit("info", "cua_driver.host.spawned", { generation: this.generation, pid: child.pid ?? null });
  }

  private attachChild(child: ChildProcess, stdout: Readable, stderr: Readable): void {
    stdout.on("data", (chunk: Buffer | string) => this.consumeStdout(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stdout.once("end", () => this.handleTerminal(child, "stdout_eof", true, false));
    stdout.once("error", () => this.handleTerminal(child, "stdout_error", true, false));
    stderr.on("data", (chunk: Buffer | string) => this.consumeStderr(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.once("error", () => this.handleTerminal(child, "child_error", true, false));
    child.once("exit", (code, signal) => this.handleTerminal(child, `child_exit:${signal ?? code ?? "unknown"}`, this.stateValue !== "stopping", true));
  }

  private consumeStdout(chunk: Buffer): void {
    if (this.terminal || chunk.byteLength === 0) {
      return;
    }
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    if (this.stdoutBuffer.byteLength > this.maxMessageBytes && this.stdoutBuffer.indexOf(0x0a) < 0) {
      void this.fail("stdout_frame_oversized", new CuaDriverProviderHostError("message_oversized"));
      return;
    }
    let newline = this.stdoutBuffer.indexOf(0x0a);
    while (newline >= 0) {
      let line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line.byteLength > 0 && line[line.byteLength - 1] === 0x0d) {
        line = line.subarray(0, line.byteLength - 1);
      }
      if (line.byteLength > this.maxMessageBytes) {
        void this.fail("stdout_frame_oversized", new CuaDriverProviderHostError("message_oversized"));
        return;
      }
      if (line.byteLength > 0) {
        this.consumeStdoutLine(line);
      }
      newline = this.stdoutBuffer.indexOf(0x0a);
    }
  }

  private consumeStdoutLine(line: Buffer): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.toString("utf8")) as unknown;
    } catch {
      void this.fail("stdout_json_invalid", new CuaDriverProviderHostError("message_invalid"));
      return;
    }
    let message: JsonRpcResponse | JsonRpcServerMessage;
    try {
      message = parseServerJsonRpcMessage(parsed);
    } catch (error) {
      void this.fail("stdout_protocol_invalid", error);
      return;
    }
    if (isResponse(message)) {
      const key = jsonRpcIdKey(message.id);
      const pending = this.pending.get(key);
      if (!pending || message.id === null) {
        void this.fail("stdout_response_id_unknown", new CuaDriverProviderHostError("message_invalid"));
        return;
      }
      this.pending.delete(key);
      clearTimeout(pending.timeout);
      pending.resolve(message);
      return;
    }
    if (message.method.startsWith("ling/") && message.method !== "ling/managed_readiness_changed") {
      void this.fail("stdout_reserved_namespace", new CuaDriverProviderHostError("reserved_namespace"));
      return;
    }
    if (isRequest(message)) {
      this.serverRequestIds.add(jsonRpcIdKey(message.id));
    }
    for (const listener of this.serverMessageListeners) {
      try {
        listener(message);
      } catch {
        // A proxy listener cannot corrupt the stdio protocol loop.
      }
    }
  }

  private consumeStderr(chunk: Buffer): void {
    if (this.stderrBytes >= this.maxStderrBytes) {
      return;
    }
    const remaining = this.maxStderrBytes - this.stderrBytes;
    const accepted = chunk.subarray(0, remaining);
    this.stderrBytes += accepted.byteLength;
    const diagnostic = redactCuaDriverDiagnostic(accepted.toString("utf8").trim());
    if (diagnostic) {
      this.telemetry.emit("warn", "cua_driver.host.stderr", { generation: this.generation, diagnostic });
    }
  }

  private sendRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const key = jsonRpcIdKey(request.id);
    if (this.pending.has(key)) {
      return Promise.reject(new CuaDriverProviderHostError("message_invalid", "duplicate_request_id"));
    }
    const timeoutMs = boundedPositive(this.options.requestTimeoutMs, 20_000, 120_000);
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(key)) {
          reject(new CuaDriverProviderHostError("request_timeout"));
          void this.fail("request_timeout", new CuaDriverProviderHostError("request_timeout"));
        }
      }, timeoutMs);
      timeout.unref?.();
      this.pending.set(key, { method: request.method, resolve, reject, timeout });
      void this.writeMessage(request).catch((error) => {
        const pending = this.pending.get(key);
        if (pending) {
          this.pending.delete(key);
          clearTimeout(pending.timeout);
          pending.reject(error instanceof Error ? error : new CuaDriverProviderHostError("write_failed"));
        }
      });
    });
  }

  private async writeMessage(message: JsonRpcClientMessage): Promise<void> {
    const child = this.child;
    if (!child?.stdin || this.terminal || child.stdin.destroyed || !child.stdin.writable) {
      throw new CuaDriverProviderHostError("child_terminal");
    }
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    if (bytes.byteLength > this.maxMessageBytes + 1) {
      throw new CuaDriverProviderHostError("message_oversized");
    }
    try {
      await writeToStream(child.stdin, bytes);
    } catch {
      throw new CuaDriverProviderHostError("write_failed");
    }
  }

  private assertReady(): void {
    if (this.stateValue !== "ready" || this.terminal) {
      throw new CuaDriverProviderHostError("not_initialized");
    }
  }

  private handleTerminal(child: ChildProcess, reason: string, unexpected: boolean, processExited: boolean): void {
    if (this.child !== child) {
      return;
    }
    if (processExited) {
      this.resolveExit?.();
      this.resolveExit = undefined;
    }
    if (this.terminal) {
      return;
    }
    this.terminal = true;
    this.stateValue = unexpected ? "failed" : "stopped";
    this.rejectPending(new CuaDriverProviderHostError("child_terminal"));
    this.notifyTerminal(reason, unexpected, child.pid);
    if (!this.stopPromise) {
      const pending = this.stopInternal(reason, unexpected);
      this.stopPromise = pending;
      void pending.catch(() => {
        if (this.stopPromise === pending) {
          this.stopPromise = undefined;
        }
      });
    }
  }

  private async fail(reason: string, error: unknown): Promise<void> {
    if (this.terminal) {
      return;
    }
    this.telemetry.emit("error", "cua_driver.host.failed", {
      generation: this.generation,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    await this.stopInternal(reason, true);
  }

  private async stopInternal(reason: string, failed = false): Promise<void> {
    const shutdownTimeoutMs = boundedPositive(this.options.shutdownTimeoutMs, 2_000, 30_000);
    this.stateValue = "stopping";
    this.startEpoch += 1;
    this.startAbortController?.abort();
    if (!this.child && this.startPromise) {
      await waitForPromise(this.startPromise.catch(() => undefined), shutdownTimeoutMs);
    }
    const child = this.child;
    const pid = child?.pid;
    if (!child) {
      this.terminal = true;
      this.stateValue = failed ? "failed" : "stopped";
      this.rejectPending(new CuaDriverProviderHostError("child_terminal"));
      return;
    }
    this.rejectPending(new CuaDriverProviderHostError("child_terminal"));
    try {
      if (child.stdin && !child.stdin.destroyed && child.stdin.writable) {
        child.stdin.end();
      }
    } catch {
      // Retained-handle termination below is still required.
    }
    const exited = child.exitCode !== null || child.signalCode !== null || await waitForPromise(this.exitPromise, shutdownTimeoutMs);
    if (!exited) {
      await this.lifecycle.terminate(child);
      const terminated = child.exitCode !== null || child.signalCode !== null || await waitForPromise(this.exitPromise, shutdownTimeoutMs);
      if (!terminated) {
        // Leave a retry path for a late native exit event. A failed stop must
        // never permanently suppress the retained-handle residue check.
        this.stopPromise = undefined;
        this.stateValue = "failed";
        throw new CuaDriverProviderHostError("child_terminal", "provider_child_did_not_exit");
      }
    }
    await this.lifecycle.assertNoResidue?.({ pid, generation: this.generation });
    this.terminal = true;
    this.stateValue = failed ? "failed" : "stopped";
    this.child = undefined;
    this.inputFenceConfiguration = undefined;
    this.resolveExit?.();
    this.resolveExit = undefined;
    this.telemetry.emit(failed ? "error" : "info", "cua_driver.host.stopped", {
      generation: this.generation,
      pid: pid ?? null,
      reason,
    });
  }

  private async terminateImmediatelyInternal(reason: string): Promise<void> {
    this.stateValue = "stopping";
    this.startEpoch += 1;
    this.startAbortController?.abort();
    const child = this.child;
    const pid = child?.pid;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.terminal = true;
      this.child = undefined;
      this.inputFenceConfiguration = undefined;
      this.stateValue = "failed";
      this.rejectPending(new CuaDriverProviderHostError("child_terminal"));
      return;
    }
    this.rejectPending(new CuaDriverProviderHostError("child_terminal"));
    this.terminal = true;
    try {
      if (this.lifecycle.terminateImmediately) {
        await this.lifecycle.terminateImmediately(child);
      } else if (!child.kill("SIGKILL")) {
        throw new CuaDriverProviderHostError("child_terminal", "provider_immediate_termination_rejected");
      }
      const terminated = child.exitCode !== null
        || child.signalCode !== null
        || await waitForPromise(this.exitPromise, 250);
      if (!terminated) {
        throw new CuaDriverProviderHostError("child_terminal", "provider_immediate_termination_unconfirmed");
      }
      await this.lifecycle.assertNoResidue?.({ pid, generation: this.generation });
      this.child = undefined;
      this.inputFenceConfiguration = undefined;
      this.resolveExit?.();
      this.resolveExit = undefined;
      this.stateValue = "failed";
      this.telemetry.emit("error", "cua_driver.host.immediately_terminated", {
        generation: this.generation,
        pid: pid ?? null,
        reason,
      });
    } catch (error) {
      // Keep the retained handle available for a later cleanup attempt.
      this.terminal = false;
      this.stateValue = "failed";
      throw error;
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.serverRequestIds.clear();
  }

  private notifyTerminal(
    reason: string,
    unexpected: boolean,
    pid?: number,
    preSpawnFailureKind?: CuaDriverProviderPreSpawnFailureKind,
  ): void {
    this.telemetry.emit(unexpected ? "error" : "info", "cua_driver.host.terminal", {
      generation: this.generation,
      pid: pid ?? null,
      reason,
    });
    try {
      this.options.onTerminal?.({
        generation: this.generation,
        reason,
        unexpected,
        ...(preSpawnFailureKind ? { preSpawnFailureKind } : {}),
      });
    } catch {
      // Lifecycle cleanup remains authoritative.
    }
  }

  private isStartCurrent(startEpoch: number, signal: AbortSignal): boolean {
    return !signal.aborted
      && startEpoch === this.startEpoch
      && !this.terminal
      && this.stateValue === "starting";
  }

  private assertStartCurrent(startEpoch: number, signal: AbortSignal): void {
    if (!this.isStartCurrent(startEpoch, signal)) {
      throw new CuaDriverProviderHostError("child_terminal");
    }
  }
}

export function createManagedProviderEnvironment(input: {
  readonly baseEnvironment: NodeJS.ProcessEnv;
  readonly stateRoot: CuaDriverStateRoot;
  readonly hostProcessId: number;
  readonly generation: number;
  readonly childInstanceNonce: string;
  readonly inputFence: CuaDriverInputFenceConfiguration;
}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  // Keep only OS/user-session variables needed by native application APIs.
  for (const key of [
    "HOME",
    "USER",
    "LOGNAME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
  ]) {
    const value = input.baseEnvironment[key];
    if (typeof value === "string") {
      environment[key] = value;
    }
  }
  return {
    ...environment,
    CUA_DRIVER_EMBEDDED: "1",
    CUA_DRIVER_LING_MANAGED: "1",
    CUA_DRIVER_HOST_BUNDLE_ID: "com.lingstack.desktop",
    CUA_DRIVER_HOST_PID: String(input.hostProcessId),
    CUA_DRIVER_CHILD_INSTANCE_NONCE: input.childInstanceNonce,
    CUA_DRIVER_LEASE_GENERATION: String(input.generation),
    CUA_DRIVER_INPUT_FENCE_PORT: String(input.inputFence.port),
    CUA_DRIVER_INPUT_FENCE_TOKEN: input.inputFence.token,
    CUA_DRIVER_INPUT_EPOCH: String(input.inputFence.epoch),
    CUA_DRIVER_STATE_HOME: input.stateRoot.rootPath,
    CUA_DRIVER_TELEMETRY_HOME: input.stateRoot.telemetryPath,
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
    CUA_DRIVER_RS_UPDATE_CHECK: "false",
  };
}

export function parseClientJsonRpcMessage(value: unknown): JsonRpcClientMessage {
  return parseJsonRpcMessage(value, true) as JsonRpcClientMessage;
}

export function parseServerJsonRpcMessage(value: unknown): JsonRpcResponse | JsonRpcServerMessage {
  return parseJsonRpcMessage(value, false) as JsonRpcResponse | JsonRpcServerMessage;
}

function parseJsonRpcMessage(value: unknown, allowClientResponse: boolean): JsonRpcClientMessage | JsonRpcServerMessage {
  if (!isRecord(value) || value.jsonrpc !== "2.0") {
    throw new CuaDriverProviderHostError("message_invalid");
  }
  if (typeof value.method === "string") {
    if (!value.method || value.method.length > 256 || value.method !== value.method.trim()) {
      throw new CuaDriverProviderHostError("message_invalid");
    }
    if (Object.hasOwn(value, "id") && !isJsonRpcId(value.id)) {
      throw new CuaDriverProviderHostError("message_invalid");
    }
    if (Object.hasOwn(value, "params") && !Array.isArray(value.params) && !isRecord(value.params)) {
      throw new CuaDriverProviderHostError("message_invalid");
    }
    return value as unknown as JsonRpcRequest | JsonRpcNotification;
  }
  if (!Object.hasOwn(value, "id") || (!isJsonRpcId(value.id) && value.id !== null)) {
    throw new CuaDriverProviderHostError("message_invalid");
  }
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasResult === hasError || (hasError && !isJsonRpcError(value.error))) {
    throw new CuaDriverProviderHostError("message_invalid");
  }
  if (!allowClientResponse && value.id === null) {
    return value as unknown as JsonRpcResponse;
  }
  return value as unknown as JsonRpcResponse;
}

function validateInitializeResponse(response: JsonRpcResponse): void {
  if ("error" in response || !isRecord(response.result)) {
    throw new CuaDriverProviderHostError("initialize_invalid");
  }
  if (response.result.protocolVersion !== "2025-06-18") {
    throw new CuaDriverProviderHostError("initialize_invalid", "provider_protocol_version_mismatch");
  }
  if (!isRecord(response.result.serverInfo) || response.result.serverInfo.version !== "0.8.3") {
    throw new CuaDriverProviderHostError("initialize_invalid", "provider_version_mismatch");
  }
}

function validateInitializeRequest(request: JsonRpcRequest): void {
  const params: unknown = request.params;
  if (!isRecord(params)
    || params.protocolVersion !== "2025-11-25"
    || !isRecord(params.capabilities)
    || !isRecord(params.clientInfo)
    || !hasText(params.clientInfo.name)
    || !hasText(params.clientInfo.version)) {
    throw new CuaDriverProviderHostError("initialize_invalid", "initialize_request_contract_mismatch");
  }
}

function isJsonRpcError(value: unknown): boolean {
  return isRecord(value) && Number.isSafeInteger(value.code) && typeof value.message === "string";
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" ? value.length > 0 && value.length <= 256 : typeof value === "number" && Number.isSafeInteger(value);
}

function isRequestLike(value: JsonRpcClientMessage): value is JsonRpcRequest | JsonRpcNotification {
  return "method" in value;
}

function isRequest(value: JsonRpcClientMessage | JsonRpcServerMessage): value is JsonRpcRequest {
  return "method" in value && "id" in value;
}

function isResponse(value: JsonRpcClientMessage | JsonRpcServerMessage | JsonRpcResponse): value is JsonRpcResponse {
  return !("method" in value);
}

function jsonRpcIdKey(id: JsonRpcId | null): string {
  return `${typeof id}:${String(id)}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, any>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function boundedPositive(value: number | undefined, fallback: number, max: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? Math.min(value!, max) : fallback;
}

async function writeToStream(stream: Writable, bytes: Buffer): Promise<void> {
  if (stream.write(bytes)) {
    return;
  }
  await new Promise<void>((resolveWrite, rejectWrite) => {
    const cleanup = (): void => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
    };
    const onDrain = (): void => {
      cleanup();
      resolveWrite();
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectWrite(error);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

async function waitForPromise(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(false), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function waitForAbort(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    throw new CuaDriverProviderHostError("child_terminal");
  }
  await new Promise<void>((resolveWait, rejectWait) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => rejectWait(new CuaDriverProviderHostError("child_terminal")));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      () => finish(resolveWait),
      (error: unknown) => finish(() => rejectWait(error)),
    );
  });
}

const defaultProviderLifecycle: CuaDriverProviderProcessLifecycle = {
  lifetimeBoundary: "darwin-direct-child",
  spawn(input) {
    return spawn(input.executablePath, [...input.args], {
      cwd: input.cwd,
      env: input.environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  },
  async terminate(child) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    child.kill("SIGTERM");
  },
  async terminateImmediately(child) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  },
};
