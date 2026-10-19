import { isAbsolute, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";

export class NativeConnectionError extends Error {
  constructor(readonly code: "protocol_error" | "cancelled" | "output_limit" | "process_failed" | "login_failed" | "cleanup_failed" | "auth_required") { super(code); }
}

export interface CodexConnectionState {
  readonly connection: "connected";
  readonly authentication: "required" | "configured_unverified" | "provider_managed";
}

/** Codex 16ff14c v1 initialize + v2 account/read; no threads, tools or auth mutations. */
export function inspectCodexConnection(options: {
  readonly input: Writable;
  readonly output: Readable;
  readonly codexHome: string;
  readonly signal: AbortSignal;
  readonly expectedAuthentication?: "apiKey";
}): Promise<CodexConnectionState> {
  return new Promise((resolveResult, reject) => {
    let stage: "initialize" | "account" = "initialize";
    let pending = Buffer.alloc(0);
    let bytes = 0;
    let settled = false;
    let writes = 0;
    let connection: CodexConnectionState | undefined;
    let writeFailure: NodeJS.Immediate | undefined;
    const releaseInput = (): void => {
      options.input.off("error", inputFailed).off("close", inputFailed).off("finish", failed);
    };
    const finish = (error?: NativeConnectionError, result?: CodexConnectionState): void => {
      if (settled) return;
      settled = true;
      if (writes === 0 && !writeFailure) releaseInput();
      options.output.off("data", data).off("error", failed).off("end", failed).off("close", failed);
      options.signal.removeEventListener("abort", aborted);
      pending = Buffer.alloc(0);
      connection = undefined;
      if (error) reject(error); else resolveResult(result!);
    };
    const failed = (): void => finish(new NativeConnectionError("process_failed"));
    const inputFailed = (): void => {
      clearImmediate(writeFailure);
      writeFailure = undefined;
      failed();
      releaseInput();
    };
    const aborted = (): void => finish(new NativeConnectionError("cancelled"));
    const send = (message: unknown): void => {
      if (settled) return;
      writes++;
      try {
        options.input.write(`${JSON.stringify(message)}\n`, (error) => {
          writes--;
          if (error) {
            // Node emits error after the write callback. Keep its handler until then.
            writeFailure ??= setImmediate(inputFailed);
          } else if (writes === 0 && !writeFailure) {
            if (settled) releaseInput();
            else if (connection) finish(undefined, connection);
          }
        });
      } catch {
        writes--;
        inputFailed();
      }
    };
    const message = (value: unknown): void => {
      if (!record(value)) throw new NativeConnectionError("protocol_error");
      if (value.method !== undefined) {
        if (typeof value.method !== "string" || value.result !== undefined || value.error !== undefined) {
          throw new NativeConnectionError("protocol_error");
        }
        if (value.id !== undefined) {
          if (typeof value.id !== "string" && !(typeof value.id === "number" && Number.isSafeInteger(value.id))) {
            throw new NativeConnectionError("protocol_error");
          }
          // A diagnostic check has no tool/approval authority.
          send({ id: value.id, error: { code: -32601, message: "Requests are not supported during connection checks." } });
          throw new NativeConnectionError("protocol_error");
        }
        return;
      }
      if (connection || value.id !== (stage === "initialize" ? 1 : 2) || value.error !== undefined || !record(value.result)) {
        throw new NativeConnectionError("protocol_error");
      }
      const result = value.result;
      if (stage === "initialize") {
        if (!text(result.userAgent) || !text(result.codexHome) || !isAbsolute(result.codexHome) || resolve(result.codexHome) !== resolve(options.codexHome)
          || (result.platformFamily !== "unix" && result.platformFamily !== "windows") || !text(result.platformOs)) {
          throw new NativeConnectionError("protocol_error");
        }
        stage = "account";
        send({ method: "initialized" });
        send({ id: 2, method: "account/read", params: { refreshToken: false } });
        return;
      }
      if (typeof result.requiresOpenaiAuth !== "boolean") throw new NativeConnectionError("protocol_error");
      const account = result.account;
      if (account != null && !validAccount(account)) {
        throw new NativeConnectionError("protocol_error");
      }
      if (options.expectedAuthentication === "apiKey" && (!result.requiresOpenaiAuth || !record(account) || account.type !== "apiKey")) {
        throw new NativeConnectionError("auth_required");
      }
      connection = { connection: "connected", authentication: !result.requiresOpenaiAuth ? "provider_managed"
        : account == null ? "required" : "configured_unverified" };
      if (writes === 0 && !writeFailure) finish(undefined, connection);
    };
    const data = (chunk: unknown): void => {
      if (settled) return;
      try {
        if (!Buffer.isBuffer(chunk) && typeof chunk !== "string") throw new NativeConnectionError("protocol_error");
        const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        bytes += buffer.length;
        if (bytes > 64 * 1024) { finish(new NativeConnectionError("output_limit")); return; }
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
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "ling-stack", version: "0.1.2-alpha.1" }, capabilities: { experimentalApi: false } } });
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
}

export function validAccount(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.type === "apiKey") return true;
  if (value.type === "amazonBedrock") return value.usesCodexManagedCredentials === undefined || typeof value.usesCodexManagedCredentials === "boolean";
  return value.type === "chatgpt" && (value.email === null || typeof value.email === "string")
    && typeof value.planType === "string" && [
      "free", "go", "plus", "pro", "prolite", "team", "self_serve_business_prolite", "self_serve_business_usage_based",
      "business", "ent26", "enterprise_cbp_automation", "enterprise_cbp_usage_based", "enterprise", "edu", "edu_plus", "edu_pro", "unknown",
    ].includes(value.planType);
}
