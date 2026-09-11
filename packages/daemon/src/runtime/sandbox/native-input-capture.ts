import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isChannelOperationRelativePathV1 } from "@ling-stack/contracts";
import { NativeInputCaptureDecoder, NativeInputCaptureError, requireNativeInput,
  type NativeInputOwner, type NativeCapturedInput } from "./native-input-capture-protocol.js";

export interface NativeInputCaptureOptions {
  /** Host-selected distribution/build identity. Never load this from model input or the project. */
  readonly helper: { readonly path: string; readonly sha256: string; readonly version: string };
  readonly root: string;
  readonly path: string;
  readonly maxBytes: number;
  readonly identity: NativeInputOwner;
  readonly assertCurrentAuthority: () => void;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * Capture one authorized input through the native directory-FD reader. A hash
 * checks the caller's already-trusted helper identity, not the trust of a supplied
 * manifest. No PATH fallback, model-provided authority or source write occurs.
 * Returned bytes become usable only after verified EOF/exit and an owner recheck.
 */
export async function captureNativeCommandInput(options: NativeInputCaptureOptions): Promise<NativeCapturedInput> {
  const check = () => {
    requireNativeInput(!options.signal?.aborted, "native_input_cancelled");
    const result: unknown = options.assertCurrentAuthority();
    // Reject async authority, but consume its rejection so a wiring mistake
    // cannot create a second, unhandled process-level failure after refusal.
    if (result instanceof Promise) void result.catch(() => undefined);
    requireNativeInput(result === undefined, "native_input_authority_must_be_synchronous");
    requireNativeInput(!options.signal?.aborted, "native_input_cancelled");
  };
  check();
  requireNativeInput(process.platform !== "win32", "native_input_platform_unsupported");
  requireNativeInput(isAbsolute(options.root) && isChannelOperationRelativePathV1(options.path)
    && options.path.length <= 4096 && isAbsolute(options.helper.path) && /^[a-f0-9]{64}$/u.test(options.helper.sha256)
    && /^[\w.+-]{1,128}$/u.test(options.helper.version), "native_input_invalid_request");
  const timeoutMs = options.timeoutMs ?? 15000;
  requireNativeInput(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000, "native_input_invalid_deadline");
  let rootStat;
  try {
    requireNativeInput(realpathSync(options.root) === options.root, "native_input_root_not_canonical");
    rootStat = lstatSync(options.root, { bigint: true });
    requireNativeInput(rootStat.isDirectory(), "native_input_root_not_directory");
    const helperStat = lstatSync(options.helper.path);
    requireNativeInput(helperStat.isFile() && !helperStat.isSymbolicLink() && helperStat.size > 0 && helperStat.size <= 67108864
      && (helperStat.mode & 0o111) !== 0 && realpathSync(options.helper.path) === options.helper.path,
    "native_input_helper_identity_invalid");
    requireNativeInput(createHash("sha256").update(readFileSync(options.helper.path)).digest("hex") === options.helper.sha256,
      "native_input_helper_identity_invalid");
  } catch (error) {
    throw error instanceof NativeInputCaptureError ? error : new NativeInputCaptureError("native_input_path_unavailable");
  }
  const identity = structuredClone(options.identity);
  const request = { handshake: { protocolVersion: 1, operation: "handshake", requestId: randomUUID(), nonce: randomBytes(32).toString("hex"),
    expectedHelperVersion: options.helper.version, parentPid: process.pid, identity }, root: options.root,
    rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino), path: options.path, maxBytes: options.maxBytes };
  const decoder = new NativeInputCaptureDecoder({ ...request, ...request.handshake });
  const body = Buffer.from(JSON.stringify(request)), header = Buffer.alloc(4);
  requireNativeInput(body.length <= 262144, "native_input_invalid_request"); header.writeUInt32BE(body.length);
  return new Promise((resolve, reject) => {
    let failure: Error | undefined;
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
    check();
    const child = spawn(options.helper.path, ["--read-input"], { env: {}, stdio: "pipe", windowsHide: true });
    const complete = (error?: Error, value?: NativeCapturedInput) => {
      if (settled) return;
      settled = true; clearTimeout(deadline); clearTimeout(cleanupDeadline); options.signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value!);
    };
    const fail = (error: Error) => {
      failure ??= error;
      // This helper never forks. Kill only our ChildProcess handle, not a guessed PID/group.
      if (!settled) {
        try { child.kill("SIGKILL"); } catch { /* Keep the original diagnostic and bounded cleanup. */ }
        cleanupDeadline ??= setTimeout(() => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); complete(failure); }, 1000);
      }
    };
    const abort = () => fail(new NativeInputCaptureError("native_input_cancelled"));
    child.once("error", () => complete(new NativeInputCaptureError("native_input_helper_unavailable")));
    child.stdin.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") fail(new NativeInputCaptureError("native_input_transport_failed")); });
    child.stdout.on("data", (bytes: Buffer) => {
      if (failure || settled) return;
      try { decoder.push(bytes); } catch (error) { fail(error instanceof Error ? error : new NativeInputCaptureError("native_input_protocol_invalid")); }
    });
    child.stdout.on("error", () => fail(new NativeInputCaptureError("native_input_transport_failed")));
    child.stderr.on("data", () => fail(new NativeInputCaptureError("native_input_helper_failed")));
    child.stderr.on("error", () => fail(new NativeInputCaptureError("native_input_transport_failed")));
    child.once("close", (code, signal) => {
      if (failure) return complete(failure);
      try {
        requireNativeInput(code === 0 && signal === null, "native_input_helper_failed");
        const result = decoder.finish(); check(); complete(undefined, result);
      } catch (error) { complete(error instanceof Error ? error : new NativeInputCaptureError("native_input_capture_failed")); }
    });
    deadline = setTimeout(() => fail(new NativeInputCaptureError("native_input_timeout")), timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    else child.stdin.end(Buffer.concat([header, body]));
  });
}
