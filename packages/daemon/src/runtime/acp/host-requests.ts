import { RequestError, type AnyMessage, type JsonRpcId } from "@agentclientprotocol/sdk";
import { AcpLifecycleError, record } from "./live-errors.js";
import type { AcpReplyObservation } from "./live-stream.js";

export interface AcpHostRequest<P> { readonly requestId: JsonRpcId; readonly params: P }
export interface AcpHostHandler<P, R> {
  /** Synchronous policy/context reservation; never perform the effect here. */
  receive(request: AcpHostRequest<P>, signal: AbortSignal): void;
  execute(request: AcpHostRequest<P>, signal: AbortSignal): Promise<R>;
  beforeReply(request: AcpHostRequest<P>, signal: AbortSignal): void;
  beforeErrorReply?(request: AcpHostRequest<P>, code: number, signal: AbortSignal): void;
  onReplyOutcome(observation: AcpReplyObservation): void;
}
export interface AcpHostScope {
  readonly sessionId: string;
  readonly promptRequestId?: JsonRpcId;
  readonly signal: AbortSignal;
  readonly accept: () => void;
}
interface Entry {
  readonly method: string;
  readonly scope: AcpHostScope;
  readonly execute: (signal: AbortSignal) => Promise<unknown>;
  readonly beforeReply: (signal: AbortSignal) => void;
  readonly beforeErrorReply: (code: number, signal: AbortSignal) => void;
  readonly observe: (observation: AcpReplyObservation) => void;
  signal: AbortSignal;
  invoked: boolean;
  executing: boolean;
  deadline?: NodeJS.Timeout;
  bytes: number;
}


/** Shared bounded request/reply ownership; effects and authorization belong to trusted ports. */
export class AcpHostRequests {
  readonly #entries = new Map<JsonRpcId, Entry>();
  readonly #retained = new Set<Entry>();
  readonly #executions = new Set<Promise<unknown>>();
  #bytes = 0;
  constructor(readonly timeoutMs: number, readonly fail: (error: AcpLifecycleError) => AcpLifecycleError,
    readonly retireReply: (id: JsonRpcId) => void) {}

  protected reserve<P, R>(requestId: JsonRpcId, method: string, params: P, handler: AcpHostHandler<P, R>, scope: AcpHostScope): void {
    const request = structuredClone({ requestId, params });
    const bytes = Buffer.byteLength(JSON.stringify(request));
    if (this.#entries.has(requestId) || this.#retained.size >= 64 || this.#bytes + bytes > 16 * 1024 * 1024) throw new AcpLifecycleError("output_limit", "unknown");
    this.#bytes += bytes;
    const entry: Entry = { method, scope, signal: scope.signal, bytes, invoked: false, executing: false,
      execute: signal => handler.execute(structuredClone(request), signal),
      beforeReply: signal => sync(() => handler.beforeReply(structuredClone(request), signal)),
      beforeErrorReply: (code, signal) => sync(() => handler.beforeErrorReply?.(structuredClone(request), code, signal)),
      observe: observation => sync(() => handler.onReplyOutcome(structuredClone(observation))) };
    this.#entries.set(requestId, entry); this.#retained.add(entry);
    if (scope.signal.aborted) return;
    scope.accept();
    if (!scope.signal.aborted) sync(() => handler.receive(structuredClone(request), scope.signal));
  }

  protected async execute(requestId: JsonRpcId, method: string, requestSignal: AbortSignal): Promise<unknown> {
    const entry = this.#entries.get(requestId);
    if (!entry) throw RequestError.methodNotFound(method);
    if (entry.method !== method || entry.invoked) throw this.fail(new AcpLifecycleError("protocol_error", "unknown"));
    entry.invoked = true;
    const signal = AbortSignal.any([entry.scope.signal, requestSignal]);
    entry.signal = signal;
    if (signal.aborted) throw RequestError.requestCancelled();
    let abort = (): void => {};
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(RequestError.requestCancelled());
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    const timer = setTimeout(() => this.fail(new AcpLifecycleError("host_commit_failed", "unknown")), this.timeoutMs);
    entry.deadline = timer;
    try {
      entry.executing = true;
      const execution = Promise.resolve().then(() => {
        if (signal.aborted) throw RequestError.requestCancelled();
        return entry.execute(signal);
      });
      this.#executions.add(execution);
      const settled = (): void => {
        clearTimeout(timer); entry.deadline = undefined; entry.executing = false; this.#executions.delete(execution);
        if (this.#entries.get(requestId) !== entry) this.#release(entry);
      };
      void execution.then(settled, settled);
      const result = await Promise.race([cancelled, execution]);
      if (signal.aborted) throw RequestError.requestCancelled();
      const copy: unknown = structuredClone(result);
      const bytes = Buffer.byteLength(JSON.stringify(copy) ?? "");
      if (this.#bytes + bytes > 16 * 1024 * 1024) throw this.fail(new AcpLifecycleError("output_limit", "unknown"));
      this.#bytes += bytes; entry.bytes += bytes;
      return copy;
    } catch (error) {
      if (signal.aborted) throw RequestError.requestCancelled();
      // Preserve useful standard categories without exposing paths, contents or host errors.
      if (error instanceof RequestError && [-32602, -32002, -32800, -32000].includes(error.code)) {
        throw new RequestError(error.code, "Host request failed.");
      }
      throw RequestError.internalError();
    } finally { signal.removeEventListener("abort", abort); }
  }

  beforeWrite(message: AnyMessage): AnyMessage {
    if (!("id" in message) || "method" in message) return message;
    const entry = this.#entries.get(message.id);
    if (!entry) return message;
    const cancel = (): AnyMessage => {
      this.retireReply(message.id);
      return { jsonrpc: "2.0", id: message.id, error: RequestError.requestCancelled().toErrorResponse() };
    };
    if (entry.signal.aborted) return cancel();
    if ("result" in message) entry.beforeReply(entry.signal);
    else entry.beforeErrorReply(message.error.code, entry.signal);
    return entry.signal.aborted ? cancel() : message;
  }

  observe(observation: AcpReplyObservation): void { this.#entries.get(observation.requestId)?.observe(observation); }
  written(requestId: JsonRpcId): void {
    const entry = this.#entries.get(requestId);
    if (entry) { this.#entries.delete(requestId); if (!entry.executing) this.#release(entry); }
  }
  retire(): void {
    for (const [id, entry] of this.#entries) if (entry.signal.aborted) this.retireReply(id);
  }
  clear(): void {
    for (const entry of this.#retained) entry.deadline?.unref();
    for (const entry of this.#entries.values()) if (!entry.executing) this.#release(entry);
    this.#entries.clear();
  }
  #release(entry: Entry): void { if (this.#retained.delete(entry)) this.#bytes -= entry.bytes; }

  drain(): Promise<void> {
    let timer: NodeJS.Timeout;
    return Promise.race([
      Promise.allSettled([...this.#executions]).then(() => {}),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AcpLifecycleError("host_cleanup_failed", "unknown")), 1000);
      }),
    ]).finally(() => clearTimeout(timer));
  }
}


function sync(operation: () => unknown): void {
  try {
    const result = operation();
    if (record(result) && typeof result.then === "function") {
      void Promise.resolve(result).catch(() => {});
      throw new Error("async_commit");
    }
  } catch { throw new AcpLifecycleError("host_commit_failed", "unknown"); }
}


export function copyHostHandler<P, R>(handler: AcpHostHandler<P, R> | undefined): AcpHostHandler<P, R> | undefined {
  if (handler === undefined) return undefined;
  if (!handler || [handler.receive, handler.execute, handler.beforeReply, handler.onReplyOutcome].some(value => typeof value !== "function")) {
    throw new AcpLifecycleError("invalid_input");
  }
  return { receive: handler.receive.bind(handler), execute: handler.execute.bind(handler),
    beforeReply: handler.beforeReply.bind(handler), beforeErrorReply: handler.beforeErrorReply?.bind(handler),
    onReplyOutcome: handler.onReplyOutcome.bind(handler) };
}
