import type { Readable, Writable } from "node:stream";
import type { ExecutionEngineLoginChallenge, ExecutionEngineLoginMethod } from "@ling-stack/contracts";
import { inspectCodexConnection, NativeConnectionError, validAccount } from "./codex-connection.js";

interface LoginOptions {
  readonly input: Writable;
  readonly output: Readable;
  readonly codexHome: string;
  readonly method: Exclude<ExecutionEngineLoginMethod, "terminal">;
  readonly apiKey?: string;
  readonly signal: AbortSignal;
  readonly onStarted?: () => void;
  readonly onChallenge: (challenge: ExecutionEngineLoginChallenge) => void;
  readonly cancelTimeoutMs?: number;
}

/** Pinned Codex account protocol only. Neither a challenge nor account/updated is login success. */
export async function loginCodexAccount(options: LoginOptions): Promise<{ readonly authentication: "login_completed" | "configured_unverified" }> {
  if (options.method === "apiKey" ? typeof options.apiKey !== "string" || !options.apiKey.length
    || options.apiKey.length > 16 * 1024 || options.apiKey.trim() !== options.apiKey || /[\x00-\x1f\x7f]/.test(options.apiKey)
    : options.apiKey !== undefined) throw new NativeConnectionError("login_failed");
  await inspectCodexConnection(options);
  return new Promise((resolve, reject) => {
    let stage: "start" | "waiting" | "updating" | "account" | "cancelling" = "start";
    let loginId: string | undefined;
    let earlyCompletion: Record<string, unknown> | undefined;
    let accountUpdated = false;
    let pending = Buffer.alloc(0);
    let bytes = 0;
    let settled = false;
    let success = false;
    let writes = 0;
    let writeFailure: NodeJS.Immediate | undefined;
    let cancelTimer: NodeJS.Timeout | undefined;
    const releaseInput = (): void => {
      options.input.off("error", inputFailed).off("close", inputFailed).off("finish", failed);
    };
    const finish = (error?: NativeConnectionError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(cancelTimer);
      if (writes === 0 && !writeFailure) releaseInput();
      options.output.off("data", data).off("error", failed).off("end", failed).off("close", failed);
      options.signal.removeEventListener("abort", aborted);
      pending = Buffer.alloc(0);
      loginId = undefined;
      earlyCompletion = undefined;
      if (error) reject(error); else resolve({ authentication: options.method === "apiKey" ? "configured_unverified" : "login_completed" });
    };
    const fail = (code: NativeConnectionError["code"]): void => finish(new NativeConnectionError(code));
    const failed = (): void => fail(options.signal.aborted ? "cancelled" : "process_failed");
    const inputFailed = (): void => {
      clearImmediate(writeFailure);
      writeFailure = undefined;
      failed();
      releaseInput();
    };
    const send = (message: unknown): void => {
      if (settled) return;
      writes++;
      try {
        options.input.write(`${JSON.stringify(message)}\n`, (error) => {
          writes--;
          if (error) writeFailure ??= setImmediate(inputFailed);
          else if (writes === 0 && !writeFailure) {
            if (settled) releaseInput();
            else if (success) finish();
          }
        });
      } catch { writes--; inputFailed(); }
    };
    const aborted = (): void => {
      if (settled || stage === "cancelling") return;
      success = false;
      if (!loginId) { fail("cancelled"); return; }
      stage = "cancelling";
      cancelTimer = setTimeout(() => fail("cancelled"), options.cancelTimeoutMs ?? 500);
      send({ id: 5, method: "account/login/cancel", params: { loginId } });
    };
    const readAccount = (): void => {
      if (stage !== "updating" || !accountUpdated) return;
      stage = "account";
      send({ id: 4, method: "account/read", params: { refreshToken: false } });
    };
    const completed = (params: unknown): void => {
      if (options.method === "apiKey") {
        if (!record(params) || params.loginId !== null || typeof params.success !== "boolean"
          || (params.error != null && (typeof params.error !== "string" || params.success))) throw new NativeConnectionError("protocol_error");
        if (!params.success) fail("login_failed");
        return;
      }
      if (!record(params) || typeof params.loginId !== "string" || typeof params.success !== "boolean"
        || (params.error != null && (typeof params.error !== "string" || params.success))) throw new NativeConnectionError("protocol_error");
      if (stage === "start") {
        if (earlyCompletion) throw new NativeConnectionError("protocol_error");
        earlyCompletion = params;
        return;
      }
      if (params.loginId !== loginId || !loginId) throw new NativeConnectionError("protocol_error");
      if (stage === "cancelling") return;
      if (stage !== "waiting") throw new NativeConnectionError("protocol_error");
      if (!params.success) { fail("login_failed"); return; }
      stage = "updating";
      readAccount();
    };
    const message = (value: unknown): void => {
      if (!record(value)) throw new NativeConnectionError("protocol_error");
      if (value.method !== undefined) {
        if (typeof value.method !== "string" || value.id !== undefined || value.result !== undefined || value.error !== undefined) {
          throw new NativeConnectionError("protocol_error");
        }
        if (value.method === "account/updated" && record(value.params) && value.params.authMode === "chatgpt") {
          accountUpdated = true;
          readAccount();
        }
        if (value.method === "account/login/completed") completed(value.params);
        return;
      }
      if (stage === "cancelling") {
        if (value.id === 5) fail("cancelled");
        return;
      }
      if (value.id !== (stage === "start" ? 3 : stage === "account" ? 4 : undefined)
        || value.id === undefined || success) throw new NativeConnectionError("protocol_error");
      if (value.error !== undefined) { fail("login_failed"); return; }
      if (!record(value.result)) throw new NativeConnectionError("protocol_error");
      const result = value.result;
      if (stage === "start") {
        if (options.method === "apiKey") {
          if (result.type !== "apiKey" || result.loginId !== undefined) throw new NativeConnectionError("protocol_error");
          options.onStarted?.();
          // Native API-key setup has already saved and reloaded auth before replying.
          stage = "account";
          send({ id: 4, method: "account/read", params: { refreshToken: false } });
          return;
        }
        if (result.type !== options.method || typeof result.loginId !== "string"
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.loginId)) {
          throw new NativeConnectionError("protocol_error");
        }
        const challenge = readChallenge(result, options.method);
        loginId = result.loginId;
        stage = "waiting";
        options.onStarted?.();
        if (earlyCompletion) { completed(earlyCompletion); earlyCompletion = undefined; }
        else options.onChallenge(challenge);
        return;
      }
      if (result.requiresOpenaiAuth !== true || !record(result.account)
        || result.account.type !== (options.method === "apiKey" ? "apiKey" : "chatgpt") || !validAccount(result.account)) {
        fail("login_failed"); return;
      }
      success = true;
      if (writes === 0 && !writeFailure) finish();
    };
    const data = (chunk: unknown): void => {
      if (settled) return;
      try {
        if (!Buffer.isBuffer(chunk) && typeof chunk !== "string") throw new NativeConnectionError("protocol_error");
        const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        bytes += buffer.length;
        if (bytes > 64 * 1024) { fail("output_limit"); return; }
        pending = Buffer.concat([pending, buffer]);
        for (let newline = pending.indexOf(10); newline !== -1 && !settled; newline = pending.indexOf(10)) {
          const line = pending.subarray(0, newline);
          pending = pending.subarray(newline + 1);
          message(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)));
        }
      } catch (error) {
        finish(error instanceof NativeConnectionError ? error : new NativeConnectionError("protocol_error"));
      }
    };
    if (options.signal.aborted) { aborted(); return; }
    if (options.input.destroyed || options.input.writableEnded || options.output.destroyed || options.output.readableEnded) { failed(); return; }
    options.input.on("error", inputFailed).once("close", inputFailed).once("finish", failed);
    options.output.on("data", data).once("error", failed).once("end", failed).once("close", failed);
    options.signal.addEventListener("abort", aborted, { once: true });
    if (options.signal.aborted) { aborted(); return; }
    send({ id: 3, method: "account/login/start", params: options.method === "apiKey"
      ? { type: "apiKey", apiKey: options.apiKey } : { type: options.method } });
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readChallenge(value: Record<string, unknown>, method: Exclude<ExecutionEngineLoginMethod, "apiKey" | "terminal">): ExecutionEngineLoginChallenge {
  const raw = method === "chatgpt" ? value.authUrl : value.verificationUrl;
  if (typeof raw !== "string" || raw.length > 8192 || /[\s\\\x00-\x1f\x7f]/.test(raw)) throw new NativeConnectionError("protocol_error");
  const url = new URL(raw);
  if (url.protocol !== "https:" || !["auth.openai.com", "chatgpt.com"].includes(url.hostname)
    || url.port || url.username || url.password || url.hash) throw new NativeConnectionError("protocol_error");
  if (method === "chatgptDeviceCode") {
    if (url.href !== "https://auth.openai.com/codex/device" || typeof value.userCode !== "string"
      || !/^[A-Z0-9-]{4,32}$/.test(value.userCode)) throw new NativeConnectionError("protocol_error");
    return { type: "device_code", url: url.href, userCode: value.userCode };
  }
  const redirects = url.searchParams.getAll("redirect_uri");
  if (redirects.length > 1) throw new NativeConnectionError("protocol_error");
  if (redirects.length === 1) {
    const redirect = new URL(redirects[0]!);
    if (redirect.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname)
      || !redirect.port || redirect.port === "0" || redirect.pathname !== "/auth/callback"
      || redirect.username || redirect.password || redirect.search || redirect.hash) throw new NativeConnectionError("protocol_error");
  }
  return { type: "browser", url: url.href };
}
