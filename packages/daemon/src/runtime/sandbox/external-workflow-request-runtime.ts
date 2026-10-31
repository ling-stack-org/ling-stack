import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { verifyElectronNodeResources } from "./electron-node-resources.js";
import { EXTERNAL_WORKFLOW_REQUEST_ACTOR_ENTRY, isOwnedExternalWorkflowRequestChild,
  prepareExternalWorkflowRequest } from "./external-workflow-request-source.js";
import { verifyRestrictedCommandBinaryPin, type RestrictedCommandExecutablePin } from "./restricted-command-runtime.js";
import { isProtectedHostStageRegistry, type ProtectedHostStageRegistry } from "./protected-host-staging.js";

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const ownedRuntimes = new WeakSet<ExternalWorkflowRequestRuntime>();

export interface ExternalWorkflowRequestRuntimeConfig {
  readonly node: RestrictedCommandExecutablePin;
  /** Trusted Host bound; production omits it and uses the fixed deadline. */
  readonly timeoutMs?: number;
}
export interface ExternalWorkflowRequestSnapshot {
  readonly path: string;
  readonly exists: boolean;
  readonly markdown?: string;
  readonly token: string;
}
export interface ExternalWorkflowRequestResult {
  readonly path: string;
  readonly exists: true;
  readonly markdown: string;
}
export interface ExternalWorkflowRequestDecision {
  readonly action: "keep" | "replace";
  readonly markdown?: string;
}
function requireRuntime(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
function inside(root: string, target: string): boolean {
  const value = relative(root, target);
  return value !== ".." && !value.startsWith("../") && !isAbsolute(value);
}
function writeFrame(child: ChildProcessWithoutNullStreams, frame: object): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
  requireRuntime(bytes.length <= MAX_FRAME_BYTES && child.stdin.writable, "external_workflow_request_frame_invalid");
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { child.stdin.off("error", onError); reject(error); };
    child.stdin.once("error", onError);
    child.stdin.write(bytes, error => {
      child.stdin.off("error", onError);
      if (error) reject(error); else resolve();
    });
  });
}
function decodeBase64(value: unknown): Buffer {
  requireRuntime(typeof value === "string" && value.length <= Math.ceil(1024 * 1024 / 3) * 4 + 4
    && /^[A-Za-z0-9+/]*={0,2}$/u.test(value), "external_workflow_request_frame_invalid");
  const bytes = Buffer.from(value, "base64");
  requireRuntime(bytes.length <= 1024 * 1024 && bytes.toString("base64") === value, "external_workflow_request_frame_invalid");
  return bytes;
}
function readSnapshot(frame: unknown, root: string): ExternalWorkflowRequestSnapshot {
  requireRuntime(frame && typeof frame === "object" && !Array.isArray(frame), "external_workflow_request_frame_invalid");
  const row = frame as Record<string, unknown>;
  requireRuntime(row.type === "snapshot" && row.protocolVersion === 1 && typeof row.token === "string"
    && /^[a-f0-9]{64}$/u.test(row.token) && typeof row.path === "string" && isAbsolute(row.path)
    && inside(root, row.path) && typeof row.exists === "boolean", "external_workflow_request_frame_invalid");
  if (!row.exists) {
    requireRuntime(row.bytesBase64 === undefined && row.identity === undefined, "external_workflow_request_frame_invalid");
    return { path: row.path, exists: false, token: row.token };
  }
  const bytes = decodeBase64(row.bytesBase64);
  requireRuntime(row.identity && typeof row.identity === "object", "external_workflow_request_frame_invalid");
  return { path: row.path, exists: true, markdown: bytes.toString("utf8"), token: row.token };
}
function readResult(frame: unknown, root: string): ExternalWorkflowRequestResult {
  requireRuntime(frame && typeof frame === "object" && !Array.isArray(frame), "external_workflow_request_frame_invalid");
  const row = frame as Record<string, unknown>;
  requireRuntime(row.type === "result" && row.protocolVersion === 1 && row.exists === true
    && typeof row.path === "string" && isAbsolute(row.path) && inside(root, row.path)
    && row.identity && typeof row.identity === "object", "external_workflow_request_frame_invalid");
  return { path: row.path, exists: true, markdown: decodeBase64(row.bytesBase64).toString("utf8") };
}
function workerError(frame: unknown): Error | undefined {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return undefined;
  const row = frame as Record<string, unknown>;
  if (row.type !== "error" || typeof row.code !== "string") return undefined;
  return new Error(row.code.slice(0, 128));
}
export function createExternalWorkflowRequestFrameReader(child: ChildProcessWithoutNullStreams): {
  readonly next: () => Promise<unknown>;
  readonly fail: (error: Error) => void;
  readonly stderr: () => string;
  readonly close: Promise<readonly [number | null, NodeJS.Signals | null]>;
} {
  const frames: unknown[] = [], waiters: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  let stdout = "", stderr = "", stdoutBytes = 0, stderrBytes = 0;
  let failure: Error | undefined, stdoutEnded = false, closed = false;
  const rejectAll = (error: Error) => {
    failure ??= error;
    while (waiters.length) waiters.shift()!.reject(error);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes > MAX_FRAME_BYTES * 2) return rejectAll(new Error("external_workflow_request_output_budget"));
    stdout += chunk;
    for (;;) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
      if (!line) continue;
      let frame: unknown;
      try { frame = JSON.parse(line); }
      catch { return rejectAll(new Error("external_workflow_request_frame_invalid")); }
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(frame); else frames.push(frame);
    }
  });
  child.stdout.once("end", () => {
    stdoutEnded = true;
    if (stdout.length > 0) rejectAll(new Error("external_workflow_request_frame_invalid"));
    else while (waiters.length) waiters.shift()!.reject(new Error("external_workflow_request_closed"));
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => {
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes > MAX_STDERR_BYTES) return rejectAll(new Error("external_workflow_request_stderr_budget"));
    stderr += chunk;
  });
  child.once("error", error => rejectAll(error));
  const close = new Promise<readonly [number | null, NodeJS.Signals | null]>(resolve => {
    child.once("close", (code, signal) => {
      closed = true;
      if (!failure && stdout.length > 0) rejectAll(new Error("external_workflow_request_frame_invalid"));
      else if (!failure && waiters.length) rejectAll(new Error("external_workflow_request_closed"));
      resolve([code, signal] as const);
    });
  });
  return {
    next: () => failure ? Promise.reject(failure) : frames.length ? Promise.resolve(frames.shift())
      : stdoutEnded || closed ? Promise.reject(new Error("external_workflow_request_closed"))
        : new Promise((resolve, reject) => waiters.push({ resolve, reject })),
    fail: rejectAll,
    stderr: () => stderr,
    close,
  };
}
export function isExternalWorkflowRequestRuntime(value: unknown): value is ExternalWorkflowRequestRuntime {
  return typeof value === "object" && value !== null && ownedRuntimes.has(value as ExternalWorkflowRequestRuntime);
}

export class ExternalWorkflowRequestRuntime {
  readonly #config: ExternalWorkflowRequestRuntimeConfig;
  readonly #registry: ProtectedHostStageRegistry;
  readonly #timeoutMs: number;
  readonly #activeStops = new Set<(error: Error) => void>();
  #released = false;
  constructor(config: ExternalWorkflowRequestRuntimeConfig, registry: ProtectedHostStageRegistry) {
    requireRuntime(config?.node && isProtectedHostStageRegistry(registry), "external_workflow_request_runtime_invalid");
    const timeoutMs = config.timeoutMs ?? REQUEST_TIMEOUT_MS;
    requireRuntime(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000,
      "external_workflow_request_runtime_invalid");
    this.#config = structuredClone(config);
    this.#registry = registry;
    this.#timeoutMs = timeoutMs;
    ownedRuntimes.add(this);
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    const error = new Error("external_workflow_request_runtime_released");
    for (const stop of [...this.#activeStops]) stop(error);
  }

  #assertActive(): void {
    requireRuntime(!this.#released, "external_workflow_request_runtime_released");
  }

  async execute(input: {
    readonly root: string;
    readonly workflowPath?: string;
    readonly assertCurrentAuthority: () => void;
    readonly decide: (snapshot: ExternalWorkflowRequestSnapshot) => ExternalWorkflowRequestDecision;
    readonly signal?: AbortSignal;
  }): Promise<Readonly<{ readonly snapshot: ExternalWorkflowRequestSnapshot; readonly result: ExternalWorkflowRequestResult }>> {
    this.#assertActive();
    requireRuntime(typeof input.assertCurrentAuthority === "function" && typeof input.decide === "function",
      "external_workflow_request_invalid");
    input.signal?.throwIfAborted();
    const root = realpathSync(input.root);
    requireRuntime(root === input.root, "external_workflow_request_root_invalid");
    const executable = verifyRestrictedCommandBinaryPin(this.#config.node);
    const resources = this.#config.node.runtime ? verifyElectronNodeResources(executable, this.#config.node.runtime) : undefined;
    const scratch = realpathSync(mkdtempSync("/private/tmp/ling-external-workflow-request-"));
    const scratchIdentity = lstatSync(scratch, { bigint: true });
    let actor: ReturnType<ProtectedHostStageRegistry["bindExternalWorkflowRequestActor"]> | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    let terminalObserved = false;
    let actorPhase: "none" | "prepared" | "launch_entered" | "launched" | "released" | "unknown" = "none";
    let scratchCleanupSafe = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const markActorUnknown = () => {
      if (!actor || actorPhase === "released" || actorPhase === "unknown") return;
      actorPhase = "unknown";
      scratchCleanupSafe = false;
      try { this.#registry.markExternalWorkflowRequestActorUnknown(actor); }
      catch { /* The local unknown latch still prevents unsafe cleanup or release. */ }
    };
    const releaseActor = (terminal: boolean): void => {
      if (!actor || actorPhase === "released" || actorPhase === "unknown") return;
      try {
        if (actorPhase === "prepared") this.#registry.cancelExternalWorkflowRequestActor(actor);
        else if (actorPhase === "launched" && terminal) this.#registry.completeExternalWorkflowRequestActor(actor);
        else { markActorUnknown(); return; }
        actorPhase = "released";
      } catch (error) {
        markActorUnknown();
        throw error;
      }
    };
    const disposeScratch = () => {
      const current = lstatSync(scratch, { bigint: true });
      requireRuntime(current.isDirectory() && !current.isSymbolicLink()
        && current.dev === scratchIdentity.dev && current.ino === scratchIdentity.ino,
      "external_workflow_request_cleanup_identity_changed");
      rmSync(scratch, { recursive: true });
    };
    try {
      const prepared = prepareExternalWorkflowRequest({ root, scratch, executable,
        runtimeReadRoots: resources?.readRoots ?? [] });
      const domain = Object.freeze({ backend: prepared.backend, staticReadRoots: prepared.staticReadRoots });
      actor = this.#registry.bindExternalWorkflowRequestActor(prepared, domain, EXTERNAL_WORKFLOW_REQUEST_ACTOR_ENTRY);
      actorPhase = "prepared";
      this.#registry.beginExternalWorkflowRequestActorLaunch(actor);
      actorPhase = "launch_entered";
      try {
        child = prepared.spawn(() => {
          input.signal?.throwIfAborted();
          const result: unknown = input.assertCurrentAuthority();
          requireRuntime(result === undefined, "external_workflow_request_authority_async");
          requireRuntime(realpathSync(input.root) === root, "external_workflow_request_root_changed");
        }, actor);
        requireRuntime(isOwnedExternalWorkflowRequestChild(child, prepared), "external_workflow_request_child_unknown");
        this.#registry.recordExternalWorkflowRequestActorLaunched(actor);
        actorPhase = "launched";
      } catch (error) {
        markActorUnknown();
        throw error;
      }
      const reader = createExternalWorkflowRequestFrameReader(child);
      const stop = (error: Error) => {
        reader.fail(error);
        if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      };
      this.#activeStops.add(stop);
      const abort = () => stop(input.signal?.reason instanceof Error
        ? input.signal.reason : new Error("external_workflow_request_aborted"));
      try {
        this.#assertActive();
        input.signal?.addEventListener("abort", abort, { once: true });
        timeout = setTimeout(() => stop(new Error("external_workflow_request_timeout")), this.#timeoutMs);
        timeout.unref?.();
        try {
          await writeFrame(child, { type: "init", protocolVersion: 1, root,
            workflowPath: input.workflowPath ?? null });
          const first = await reader.next(), firstError = workerError(first);
          if (firstError) throw firstError;
          const snapshot = readSnapshot(first, root);
          input.signal?.throwIfAborted();
          const authorityResult: unknown = input.assertCurrentAuthority();
          requireRuntime(authorityResult === undefined && realpathSync(input.root) === root,
            "external_workflow_request_authority_changed");
          this.#assertActive();
          const decision = input.decide(snapshot);
          this.#assertActive();
          requireRuntime(decision && (decision.action === "keep" && decision.markdown === undefined
            || decision.action === "replace" && typeof decision.markdown === "string"),
          "external_workflow_request_decision_invalid");
          await writeFrame(child, decision.action === "keep"
            ? { type: "decision", protocolVersion: 1, token: snapshot.token, action: "keep" }
            : { type: "decision", protocolVersion: 1, token: snapshot.token, action: "replace",
              markdownBase64: Buffer.from(decision.markdown!, "utf8").toString("base64") });
          child.stdin.end();
          const second = await reader.next(), secondError = workerError(second);
          if (secondError) throw secondError;
          const result = readResult(second, root);
          const [exitCode, signal] = await reader.close;
          terminalObserved = true;
          this.#assertActive();
          requireRuntime(exitCode === 0 && signal === null, `external_workflow_request_failed:${reader.stderr().slice(0, 256)}`);
          releaseActor(true);
          return Object.freeze({ snapshot, result });
        } finally {
          input.signal?.removeEventListener("abort", abort);
        }
      } finally {
        this.#activeStops.delete(stop);
      }
    } catch (error) {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (child && !terminalObserved) {
        try {
          terminalObserved = child.exitCode !== null || child.signalCode !== null;
          if (!terminalObserved) await Promise.race([
            new Promise<void>(resolve => child!.once("close", () => resolve())),
            new Promise<void>(resolve => setTimeout(resolve, 1_000)),
          ]);
          terminalObserved = child.exitCode !== null || child.signalCode !== null;
        } catch { terminalObserved = false; }
      }
      if (actor) {
        try {
          if (actorPhase === "prepared") releaseActor(false);
          else if (actorPhase === "launched" && terminalObserved) releaseActor(true);
          else markActorUnknown();
        } catch { markActorUnknown(); /* Preserve the original failure and the conservative active lease. */ }
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (scratchCleanupSafe) {
        try { disposeScratch(); } catch { /* Never delete a replacement or hide the request result. */ }
      }
    }
  }
}
