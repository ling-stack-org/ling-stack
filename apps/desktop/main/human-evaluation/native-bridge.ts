import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, realpathSync, accessSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export interface HumanNativeSession {
  readonly osSessionId: string;
  readonly osUserId: string;
  readonly active: boolean;
  readonly locked: boolean;
}

export interface HumanNativeConfirmation {
  readonly status: "confirmed" | "cancelled" | "unavailable" | "failed";
  readonly invocationId: string;
  readonly intentId: string;
  readonly requestId: string;
  readonly payloadDigest: string;
  readonly sessionBefore: HumanNativeSession;
  readonly sessionAfter: HumanNativeSession;
}

export interface HumanEvaluationNativeBridge {
  readSession(signal: AbortSignal): Promise<HumanNativeSession>;
  confirm(input: {
    readonly intentId: string;
    readonly requestId: string;
    readonly payloadDigest: string;
    readonly payloadJson: string;
    readonly signal: AbortSignal;
  }): Promise<HumanNativeConfirmation>;
}

type NativeInvoke = (path: string, request: object, signal: AbortSignal) => Promise<unknown>;
const HASH = /^[a-f0-9]{64}$/u;

/** Only the fixed executable inside this application's resource tree is admitted. */
export function resolveHumanEvaluationHelper(resourcesRoot: string, platform = process.platform): string {
  if (platform !== "darwin" || !isAbsolute(resourcesRoot)) throw new Error("human_native_unavailable");
  const root = realpathSync(resourcesRoot);
  const directory = resolve(root, "human-evaluation");
  const helper = resolve(directory, "ling-human-evaluation-helper");
  if (lstatSync(directory).isSymbolicLink() || lstatSync(helper).isSymbolicLink()
    || !lstatSync(helper).isFile() || realpathSync(directory) !== directory
    || realpathSync(helper) !== helper) throw new Error("human_native_source_invalid");
  accessSync(helper, constants.X_OK);
  return helper;
}

/** Main-owned calls are separate processes, never a shared identity single-flight. */
export function createHumanEvaluationNativeBridge(options: {
  readonly helperPath: string;
  readonly invoke?: NativeInvoke;
}): HumanEvaluationNativeBridge {
  if (!isAbsolute(options.helperPath)) throw new Error("human_native_path_invalid");
  const invoke = options.invoke ?? invokeHumanEvaluationHelper;
  return Object.freeze({
    async readSession(signal: AbortSignal) {
      const value = await invoke(options.helperPath, { command: "session", protocol: 1 }, signal);
      const session = parseHumanNativeSession(value);
      if (!session) throw new Error("human_native_session_invalid");
      return session;
    },
    async confirm(input: Parameters<HumanEvaluationNativeBridge["confirm"]>[0]) {
      if (signalAborted(input.signal) || !HASH.test(input.payloadDigest)
        || Buffer.byteLength(input.payloadJson, "utf8") > 24_576
        || createHash("sha256").update(input.payloadJson, "utf8").digest("hex") !== input.payloadDigest) {
        throw new Error("human_native_payload_invalid");
      }
      const invocationId = randomUUID();
      const value = await invoke(options.helperPath, {
        command: "confirm", protocol: 1, invocationId,
        intentId: input.intentId, requestId: input.requestId,
        payloadDigest: input.payloadDigest, payloadJson: input.payloadJson,
      }, input.signal);
      if (!recordWithKeys(value, ["status", "invocationId", "intentId", "requestId", "payloadDigest", "sessionBefore", "sessionAfter"])
        || !["confirmed", "cancelled", "unavailable", "failed"].includes(String(value.status))
        || value.invocationId !== invocationId || value.intentId !== input.intentId
        || value.requestId !== input.requestId || value.payloadDigest !== input.payloadDigest) {
        throw new Error("human_native_confirmation_invalid");
      }
      const sessionBefore = parseHumanNativeSession(value.sessionBefore);
      const sessionAfter = parseHumanNativeSession(value.sessionAfter);
      if (!sessionBefore || !sessionAfter || input.signal.aborted) throw new Error("human_native_confirmation_invalid");
      return Object.freeze({ status: value.status as HumanNativeConfirmation["status"], invocationId,
        intentId: input.intentId, requestId: input.requestId, payloadDigest: input.payloadDigest,
        sessionBefore, sessionAfter });
    },
  });
}

export function parseHumanNativeSession(value: unknown): HumanNativeSession | undefined {
  if (!recordWithKeys(value, ["osSessionId", "osUserId", "active", "locked"])
    || typeof value.osSessionId !== "string" || !HASH.test(value.osSessionId)
    || typeof value.osUserId !== "string" || !HASH.test(value.osUserId)
    || typeof value.active !== "boolean" || typeof value.locked !== "boolean") return undefined;
  return Object.freeze({ osSessionId: value.osSessionId, osUserId: value.osUserId,
    active: value.active, locked: value.locked });
}

export function sameHumanSession(a: HumanNativeSession, b: HumanNativeSession): boolean {
  return a.active && b.active && !a.locked && !b.locked
    && a.osSessionId === b.osSessionId && a.osUserId === b.osUserId;
}

function signalAborted(signal: AbortSignal): boolean { return signal.aborted; }

function recordWithKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === keys.length
    && keys.every((key) => Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], "value"));
}

/** Abort/timeout kill the child, but only actual close releases the owned lane. */
export function invokeHumanEvaluationHelper(helperPath: string, request: object, signal: AbortSignal,
  spawnImpl: typeof spawn = spawn, timeoutMs = 120_000): Promise<unknown> {
  if (signal.aborted) return Promise.reject(new Error("human_native_cancelled"));
  const bytes = Buffer.from(JSON.stringify(request), "utf8");
  if (bytes.length > 32_768) return Promise.reject(new Error("human_native_request_too_large"));
  return new Promise((resolveResult, reject) => {
    const child = spawnImpl(helperPath, [], { stdio: ["pipe", "pipe", "pipe"], shell: false });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let failure: Error | undefined;
    let closed = false;
    const stop = (code: string): void => {
      failure ??= new Error(code);
      if (!closed) { try { child.kill("SIGKILL"); } catch { /* Wait for close even if kill fails. */ } }
    };
    const abort = (): void => stop("human_native_cancelled");
    const timer = setTimeout(() => stop("human_native_timeout"), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", () => { failure ??= new Error("human_native_unavailable"); });
    child.stdin?.on("error", () => stop("human_native_input_failed"));
    child.stderr?.on("data", () => { /* Never publish helper stderr/payload to the renderer. */ });
    child.stdout?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 16_384) stop("human_native_output_too_large");
      else chunks.push(Buffer.from(chunk));
    });
    child.once("close", (code) => {
      closed = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (failure || code !== 0 || signal.aborted) { reject(failure ?? new Error("human_native_failed")); return; }
      try { resolveResult(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("human_native_output_invalid")); }
    });
    if (signal.aborted) abort();
    else child.stdin?.end(bytes);
  });
}
