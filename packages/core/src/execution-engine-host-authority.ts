import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, writeSync } from "node:fs";
import type { Readable } from "node:stream";

export class ExecutionEngineHostAuthorityError extends Error {
  constructor(readonly code: string) { super(code); }
}

export interface ExecutionEngineHostAuthority {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly baseUrl: string;
  readonly pid: number;
  readonly credentials: { readonly capability: string; readonly csrfToken: string };
}

/** Only the inherited startup pipe. Never publish credentials to a path or ordinary stdio. */
export function writeExecutionEngineHostAuthority(input: {
  readonly fd: number;
  readonly baseUrl: string;
  readonly credentials: ExecutionEngineHostAuthority["credentials"];
}): void {
  if (input.fd !== 3) fail("engine_host_authority_invalid");
  try {
    const info = fstatSync(input.fd);
    if (!info.isFIFO() && !info.isSocket()) fail("engine_host_authority_insecure");
    const value: ExecutionEngineHostAuthority = {
      schemaVersion: 1, instanceId: randomUUID(), baseUrl: localBaseUrl(input.baseUrl), pid: process.pid,
      credentials: input.credentials,
    };
    validateAuthority(value, value.baseUrl, process.pid);
    const bytes = Buffer.from(JSON.stringify(value));
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(input.fd, bytes, offset, bytes.length - offset);
      if (!written) fail("engine_host_authority_unavailable");
      offset += written;
    }
  } finally {
    closeSync(input.fd);
  }
}

/** Read only a retained child's pipe, not a same-user file, URL or process environment. */
export function readExecutionEngineHostAuthority(input: {
  readonly channel: Readable;
  readonly baseUrl: string;
  readonly pid: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<ExecutionEngineHostAuthority> {
  const baseUrl = localBaseUrl(input.baseUrl);
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (error?: ExecutionEngineHostAuthorityError, value?: ExecutionEngineHostAuthority): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", unavailable);
      input.channel.off("data", data).off("end", end).off("error", unavailable).off("close", unavailable);
      // An abort can race an already queued pipe error. Drain it through close
      // before removing the final listener; settling alone does not cancel IO.
      const drainError = (): void => undefined;
      const removeDrain = (): void => {
        input.channel.off("error", drainError).off("close", removeDrain);
      };
      input.channel.on("error", drainError).once("close", removeDrain);
      // closed may be true even while Node still has error/close queued.
      if (input.channel.closed) setImmediate(removeDrain);
      input.channel.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    const unavailable = (): void => finish(new ExecutionEngineHostAuthorityError("engine_host_authority_unavailable"));
    const timer = setTimeout(unavailable, input.timeoutMs ?? 20_000);
    const data = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > 8192) { finish(new ExecutionEngineHostAuthorityError("engine_host_authority_invalid")); return; }
      chunks.push(chunk);
    };
    const end = (): void => {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        validateAuthority(value, baseUrl, input.pid);
        finish(undefined, value);
      } catch { finish(new ExecutionEngineHostAuthorityError("engine_host_authority_invalid")); }
    };
    input.channel.on("data", data).once("end", end).once("error", unavailable).once("close", unavailable);
    input.signal?.addEventListener("abort", unavailable, { once: true });
    if (input.signal?.aborted || input.channel.destroyed || input.channel.readableEnded) unavailable();
  });
}

function validateAuthority(value: unknown, baseUrl: string, pid: number): asserts value is ExecutionEngineHostAuthority {
  if (!value || typeof value !== "object") fail("engine_host_authority_invalid");
  const record = value as Partial<ExecutionEngineHostAuthority>;
  if (record.schemaVersion !== 1 || record.baseUrl !== baseUrl || typeof record.instanceId !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(record.instanceId)
    || record.pid !== pid || !Number.isSafeInteger(pid) || pid < 1
    || !record.credentials || [record.credentials.capability, record.credentials.csrfToken].some((item) =>
      typeof item !== "string" || !/^[a-zA-Z0-9_-]{32,128}$/.test(item))) fail("engine_host_authority_invalid");
}

function localBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== "/") fail("engine_host_must_be_local");
    return url.origin;
  } catch { fail("engine_host_must_be_local"); }
}

function fail(code: string): never { throw new ExecutionEngineHostAuthorityError(code); }
