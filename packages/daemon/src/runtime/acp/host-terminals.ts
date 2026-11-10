import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { methods, RequestError, type AnyMessage, type ClientCapabilities, type CreateTerminalRequest,
  type CreateTerminalResponse, type JsonRpcId, type KillTerminalResponse, type ReleaseTerminalResponse,
  type TerminalOutputRequest, type TerminalOutputResponse, type WaitForTerminalExitResponse } from "@agentclientprotocol/sdk";
import { AcpHostRequests, copyHostHandler, type AcpHostHandler, type AcpHostScope } from "./host-requests.js";
import { AcpLifecycleError, record, text } from "./live-errors.js";

/** Allocated by Ling, never accepted from native command input. The target journals this exact id. */
export type AcpHostTerminalCreateParams = CreateTerminalRequest & { readonly terminalId: string };
export interface AcpHostTerminalHandlers {
  readonly create: AcpHostHandler<AcpHostTerminalCreateParams, CreateTerminalResponse>;
  readonly output: AcpHostHandler<TerminalOutputRequest, TerminalOutputResponse>;
  readonly waitForExit: AcpHostHandler<TerminalOutputRequest, WaitForTerminalExitResponse>;
  readonly kill: AcpHostHandler<TerminalOutputRequest, KillTerminalResponse>;
  readonly release: AcpHostHandler<TerminalOutputRequest, ReleaseTerminalResponse>;
  /** Idempotent cleanup, including never-started handles; resolve only after actual owned effects settle. */
  dispose(terminalId: string): Promise<void>;
}

export function copyHostTerminalHandlers(port: AcpHostTerminalHandlers): AcpHostTerminalHandlers {
  if (!port || [port.create, port.output, port.waitForExit, port.kill, port.release].some(value => !value)
    || typeof port.dispose !== "function") throw new AcpLifecycleError("invalid_input");
  return { create: copyHostHandler(port.create)!, output: copyHostHandler(port.output)!,
    waitForExit: copyHostHandler(port.waitForExit)!, kill: copyHostHandler(port.kill)!, release: copyHostHandler(port.release)!,
    dispose: port.dispose.bind(port) };
}

interface Terminal {
  readonly id: string;
  readonly scope: AcpHostScope;
  readonly abort: AbortController;
  readonly stop: () => void;
  readonly outputByteLimit: number;
  delivered: boolean;
  retired: boolean;
  creation?: Promise<unknown>;
  cleanup?: Promise<void>;
}
const terminalMethods = methods.client.terminal;
const maximumOutputBytes = 4 * 1024 * 1024;

/** Protocol handle ownership, not a shell executor or a substitute for the target's durable policy. */
export class AcpHostTerminals extends AcpHostRequests {
  readonly #port?: AcpHostTerminalHandlers;
  readonly #terminals = new Map<string, Terminal>();
  #cleanupFailure?: AcpLifecycleError;

  constructor(port: AcpHostTerminalHandlers | undefined, timeoutMs: number,
    fail: (error: AcpLifecycleError) => AcpLifecycleError, retireReply: (id: JsonRpcId) => void, readonly frameBytes: number) {
    super(timeoutMs, fail, retireReply);
    if (port !== undefined) this.#port = copyHostTerminalHandlers(port);
  }

  get capabilities(): ClientCapabilities { return this.#port ? { terminal: true } : {}; }

  receive(message: AnyMessage, scope?: AcpHostScope): void {
    if (!("method" in message) || !Object.values(terminalMethods).some(method => method === message.method)) return;
    if (!("id" in message)) throw new AcpLifecycleError("protocol_error", "unknown");
    if (!this.#port) return;
    const params = message.params;
    if (!scope || scope.promptRequestId === undefined || !record(params) || params.sessionId !== scope.sessionId) {
      throw new AcpLifecycleError("binding_mismatch", "unknown");
    }
    if (message.method === terminalMethods.create) {
      const input = parseCreate(params);
      if (this.#terminals.size >= 64) throw new AcpLifecycleError("output_limit", "unknown");
      const id = randomUUID();
      const terminal: Terminal = { id, scope, abort: new AbortController(), delivered: false, retired: false,
        outputByteLimit: input.outputByteLimit ?? maximumOutputBytes, stop: () => { void this.#retire(terminal); } };
      this.#terminals.set(id, terminal);
      scope.signal.addEventListener("abort", terminal.stop, { once: true });
      this.#create(message.id, { ...input, terminalId: id }, terminal);
      if (scope.signal.aborted) terminal.stop();
      return;
    }
    if (!text(params.terminalId) || !keys(params, ["sessionId", "terminalId", "_meta"]) || !meta(params._meta)) {
      throw new AcpLifecycleError("protocol_error", "unknown");
    }
    const request = { sessionId: scope.sessionId, terminalId: params.terminalId };
    const terminal = this.#terminals.get(params.terminalId);
    if (!terminal || terminal.retired || !terminal.delivered || terminal.scope.promptRequestId !== scope.promptRequestId) {
      this.reserve(message.id, message.method, request, { receive() {}, beforeReply() {}, onReplyOutcome() {},
        async execute() { throw RequestError.resourceNotFound(); } }, scope);
      return;
    }
    switch (message.method) {
      case terminalMethods.output: this.#use(message.id, message.method, request, terminal, this.#port.output, scope); break;
      case terminalMethods.waitForExit: this.#use(message.id, message.method, request, terminal, this.#port.waitForExit, scope); break;
      case terminalMethods.kill: this.#use(message.id, message.method, request, terminal, this.#port.kill, scope); break;
      case terminalMethods.release: this.#use(message.id, message.method, request, terminal, this.#port.release, scope); break;
    }
  }

  #create(requestId: JsonRpcId, params: AcpHostTerminalCreateParams, terminal: Terminal): void {
    const port = this.#port!.create;
    this.reserve(requestId, terminalMethods.create, params, {
      ...port,
      execute: async (request, signal) => {
        signal.addEventListener("abort", terminal.stop, { once: true });
        terminal.creation = Promise.resolve().then(async () => {
          signal.throwIfAborted();
          const result = await port.execute(request, signal);
          if (!record(result) || result.terminalId !== terminal.id || !keys(result, ["terminalId"])) {
            throw this.fail(new AcpLifecycleError("host_commit_failed", "unknown"));
          }
          return { terminalId: terminal.id };
        });
        try { return await terminal.creation as CreateTerminalResponse; }
        catch (error) { terminal.stop(); throw error; }
        finally { signal.removeEventListener("abort", terminal.stop); }
      },
      onReplyOutcome: observation => {
        const returned: unknown = port.onReplyOutcome(observation);
        if (record(returned) && typeof returned.then === "function") {
          void Promise.resolve(returned).catch(() => {});
          throw new AcpLifecycleError("host_commit_failed", "unknown");
        }
        if (observation.outcome === "written" && !terminal.retired) terminal.delivered = true;
        else terminal.stop();
      },
    }, terminal.scope);
  }

  #use<R>(requestId: JsonRpcId, method: string, params: TerminalOutputRequest, terminal: Terminal,
    port: AcpHostHandler<TerminalOutputRequest, R>, scope: AcpHostScope): void {
    const releasing = method === terminalMethods.release;
    this.reserve(requestId, method, params, { ...port, execute: async (request, signal) => {
      if (terminal.retired) throw RequestError.resourceNotFound();
      const result = await port.execute(request, signal);
      if (releasing) await this.#retire(terminal);
      if (this.#cleanupFailure) throw this.#cleanupFailure;
      if (method === terminalMethods.output && (!record(result) || typeof result.output !== "string"
        || Buffer.byteLength(result.output) > 16 * 1024 * 1024 || typeof result.truncated !== "boolean"
        || !keys(result, ["output", "truncated", "exitStatus"]) || (result.exitStatus != null && !validExit(result.exitStatus)))) {
        throw this.fail(new AcpLifecycleError("host_commit_failed", "unknown"));
      }
      if (method === terminalMethods.waitForExit && !validExit(result)
        || (method === terminalMethods.kill || releasing) && (!record(result) || Object.keys(result).length)) {
        throw this.fail(new AcpLifecycleError("host_commit_failed", "unknown"));
      }
      if (method === terminalMethods.output) {
        const output = result as TerminalOutputResponse;
        const bytes = Buffer.from(output.output);
        let start = Math.max(0, bytes.length - terminal.outputByteLimit);
        while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
        const tail = bytes.subarray(start).toString("utf8");
        // Raw output bytes and serialized frame bytes differ for control characters and quotes.
        const overhead = Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: requestId,
          result: { ...output, output: "", truncated: false } }) + "\n");
        if (overhead > this.frameBytes) throw this.fail(new AcpLifecycleError("output_limit", "unknown"));
        const framed = jsonTail(tail, this.frameBytes - overhead);
        return { ...output, output: framed, truncated: output.truncated || start > 0 || framed.length !== tail.length };
      }
      return result;
    } }, releasing ? scope : { ...scope, signal: AbortSignal.any([scope.signal, terminal.abort.signal]) });
  }

  create(id: JsonRpcId, signal: AbortSignal): Promise<CreateTerminalResponse> { return this.execute(id, terminalMethods.create, signal) as Promise<CreateTerminalResponse>; }
  output(id: JsonRpcId, signal: AbortSignal): Promise<TerminalOutputResponse> { return this.execute(id, terminalMethods.output, signal) as Promise<TerminalOutputResponse>; }
  waitForExit(id: JsonRpcId, signal: AbortSignal): Promise<WaitForTerminalExitResponse> { return this.execute(id, terminalMethods.waitForExit, signal) as Promise<WaitForTerminalExitResponse>; }
  kill(id: JsonRpcId, signal: AbortSignal): Promise<KillTerminalResponse> { return this.execute(id, terminalMethods.kill, signal) as Promise<KillTerminalResponse>; }
  release(id: JsonRpcId, signal: AbortSignal): Promise<ReleaseTerminalResponse> { return this.execute(id, terminalMethods.release, signal) as Promise<ReleaseTerminalResponse>; }

  #retire(terminal: Terminal): Promise<void> {
    if (terminal.cleanup) return terminal.cleanup;
    // A cancelled create can still be spawning. Never dispose before its actual operation settles.
    terminal.cleanup = Promise.resolve().then(async () => {
      await Promise.allSettled(terminal.creation ? [terminal.creation] : []);
      await this.#port!.dispose(terminal.id);
      this.#terminals.delete(terminal.id);
    }).catch(() => {
      this.#cleanupFailure = new AcpLifecycleError("host_cleanup_failed", "unknown");
      this.fail(this.#cleanupFailure);
      throw this.#cleanupFailure;
    });
    void terminal.cleanup.catch(() => {});
    // Publish cleanup ownership before abort listeners can reenter close/release.
    terminal.retired = true;
    terminal.scope.signal.removeEventListener("abort", terminal.stop);
    terminal.abort.abort();
    return terminal.cleanup;
  }

  override async drain(): Promise<void> {
    let timer: NodeJS.Timeout;
    try {
      await Promise.race([
        Promise.all([super.drain(), ...[...this.#terminals.values()].map(terminal => terminal.cleanup)]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AcpLifecycleError("host_cleanup_failed", "unknown")), 1000); }),
      ]);
      if (this.#cleanupFailure) throw this.#cleanupFailure;
    } finally { clearTimeout(timer!); }
  }
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
function meta(value: unknown): boolean { return value == null || record(value); }
function argument(value: unknown): value is string { return typeof value === "string" && !value.includes("\0"); }
function jsonTail(value: string, budget: number): string {
  let start = value.length, size = 0;
  while (start > 0) {
    const unit = value.charCodeAt(start - 1);
    const width = unit >= 0xdc00 && unit <= 0xdfff ? 2 : 1;
    const code = value.codePointAt(start - width)!;
    const bytes = code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code) ? 2
      : code < 32 ? 6 : code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
    if (size + bytes > budget) break;
    start -= width; size += bytes;
  }
  return value.slice(start);
}
function validExit(value: unknown): boolean {
  if (!record(value) || !keys(value, ["exitCode", "signal"])) return false;
  const code = typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode) && value.exitCode >= 0;
  const signal = text(value.signal) && /^[A-Z][A-Z0-9]+$/.test(value.signal);
  return code && value.signal == null || signal && value.exitCode == null;
}
function parseCreate(params: Record<string, unknown>): CreateTerminalRequest {
  if (!text(params.command) || !argument(params.command) || !meta(params._meta)
    || !keys(params, ["sessionId", "command", "args", "env", "cwd", "outputByteLimit", "_meta"])
    || params.args !== undefined && (!Array.isArray(params.args) || !params.args.every(argument))
    || params.cwd != null && (!text(params.cwd) || !isAbsolute(params.cwd) || /[\x00-\x1f\x7f]/.test(params.cwd))
    || params.outputByteLimit != null && (typeof params.outputByteLimit !== "number" || !Number.isSafeInteger(params.outputByteLimit)
      || params.outputByteLimit < 0 || params.outputByteLimit > 4294967295)
    || params.env !== undefined && (!Array.isArray(params.env) || !params.env.every(item => record(item)
      && text(item.name) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(item.name) && argument(item.value)
      && keys(item, ["name", "value", "_meta"]) && meta(item._meta))
      || new Set(params.env.map(item => item.name)).size !== params.env.length)) {
    throw new AcpLifecycleError("protocol_error", "unknown");
  }
  return { sessionId: params.sessionId as string, command: params.command,
    ...(params.args !== undefined ? { args: [...params.args as string[]] } : {}),
    ...(params.env !== undefined ? { env: (params.env as { name: string; value: string }[]).map(({ name, value }) => ({ name, value })) } : {}),
    ...(params.cwd != null ? { cwd: params.cwd as string } : {}),
    outputByteLimit: Math.min(params.outputByteLimit == null ? maximumOutputBytes : params.outputByteLimit as number, maximumOutputBytes) };
}
