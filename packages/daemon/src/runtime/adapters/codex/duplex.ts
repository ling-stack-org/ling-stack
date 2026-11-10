import type { Readable, Writable } from "node:stream";

export type CodexRpcErrorCode = "protocol_error" | "capacity_exceeded" | "transport_failed"
  | "cancelled" | "timeout" | "handler_failed" | "remote_error";

export class CodexRpcError extends Error {
  constructor(readonly code: CodexRpcErrorCode, readonly remoteCode?: number) { super(code); }
}

export interface CodexNotification { readonly method: string; readonly params?: unknown }
export interface CodexRequest extends CodexNotification { readonly id: string | number }
export interface CodexReplyObservation {
  readonly requestId: string | number;
  readonly method: string;
  readonly outcome: "written" | "not_written" | "unknown";
}

interface Limits {
  frameBytes: number; writeBytes: number; pendingRequests: number; nativeRequests: number;
  nativeIds: number; notificationCount: number; notificationBytes: number;
}
interface Pending {
  resolve: (value: unknown) => void; reject: (error: CodexRpcError) => void;
  timer: ReturnType<typeof setTimeout>; written: boolean;
  response?: { result?: unknown; error?: CodexRpcError };
}
interface Write {
  bytes: Buffer; resolve: () => void; reject: (error: CodexRpcError) => void;
  signal?: AbortSignal;
  native?: NativePending;
  sending?: () => void;
}
interface NativePending {
  timer: ReturnType<typeof setTimeout>; abort: AbortController; request: CodexRequest;
  invoked: boolean; result?: unknown; outcome?: CodexReplyObservation["outcome"];
}
export interface CodexDuplexOptions {
  readonly input: Writable;
  readonly output: Readable;
  readonly signal: AbortSignal;
  readonly requestTimeoutMs?: number;
  readonly writeTimeoutMs?: number;
  readonly nativeRequestTimeoutMs?: number;
  readonly limits?: Partial<Limits>;
  /** Synchronous receipt for security context; runs before queued application observers. */
  readonly onNotificationReceived?: (message: CodexNotification) => void;
  readonly onNotification?: (message: CodexNotification, signal: AbortSignal) => void | Promise<void>;
  readonly onRequest?: (message: CodexRequest, signal: AbortSignal) => unknown | Promise<unknown>;
  /** Synchronous durable claim/validation immediately before write invocation. Never performs async work. */
  readonly onRequestSending?: (request: CodexRequest) => void;
  readonly onReplySending?: (request: CodexRequest, result: unknown) => void;
  /** Synchronous observation, once even when a cancelled request's handler never settles. */
  readonly onReplyOutcome?: (observation: CodexReplyObservation) => void;
  readonly onLocalLifetime?: (lifetime: Promise<unknown>) => void;
}

/** Owns framing/dispatch, not child processes or durable decisions. The caller reaps its process. */
export class CodexDuplex {
  readonly closed: Promise<CodexRpcError>;
  readonly #options: CodexDuplexOptions;
  readonly #limits: Limits;
  readonly #abort = new AbortController();
  #finish!: (error: CodexRpcError) => void;
  #failure?: CodexRpcError;
  #fragment = Buffer.alloc(0);
  #id = 0;
  #pending = new Map<string | number, Pending>();
  #nativeIds = new Set<string | number>();
  #nativePending = new Map<string | number, NativePending>();
  #writeTimer?: ReturnType<typeof setTimeout>;
  #writes: Write[] = [];
  #writing?: Write;
  #writeBytes = 0;
  #notifications: { message: CodexNotification; bytes: number }[] = [];
  #notificationCount = 0;
  #notificationBytes = 0;
  #notifying = false;

  constructor(options: CodexDuplexOptions) {
    this.#options = options;
    this.#limits = { frameBytes: 1024 * 1024, writeBytes: 4 * 1024 * 1024, pendingRequests: 64,
      nativeRequests: 32, nativeIds: 65536, notificationCount: 256, notificationBytes: 8 * 1024 * 1024,
      ...options.limits };
    for (const limit of [...Object.values(this.#limits), options.requestTimeoutMs ?? 30000, options.writeTimeoutMs ?? 30000, options.nativeRequestTimeoutMs ?? 300000]) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2 ** 30) throw new CodexRpcError("capacity_exceeded");
    }
    this.closed = new Promise(resolve => { this.#finish = resolve; });
    options.input.on("error", this.#failed).once("close", this.#inputClosed).once("finish", this.#failed);
    options.output.on("error", this.#failed).once("close", this.#outputClosed).once("end", this.#ended).on("data", this.#data);
    options.signal.addEventListener("abort", this.#cancelled, { once: true });
    if (options.signal.aborted) this.#cancelled();
    else if (options.input.destroyed || options.input.writableEnded || options.output.destroyed || options.output.readableEnded) this.#failed();
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#pending.size >= this.#limits.pendingRequests || this.#id >= Number.MAX_SAFE_INTEGER) {
      this.close(new CodexRpcError("capacity_exceeded"));
      return Promise.reject(this.#failure);
    }
    const id = `ling:${++this.#id}`;
    return new Promise((resolve, reject) => {
      const entry: Pending = { resolve, reject, written: false,
        timer: setTimeout(() => this.close(new CodexRpcError("timeout")), this.#options.requestTimeoutMs ?? 30000) };
      this.#pending.set(id, entry);
      void this.#send({ id, method, params }, undefined, undefined, () => this.#options.onRequestSending?.({ id, method, params })).then(() => {
        entry.written = true;
        this.#settle(id, entry);
      }, error => this.close(error));
    });
  }

  notify(method: string, params?: unknown): Promise<void> { return this.#send({ method, ...(params === undefined ? {} : { params }) }); }

  cancelNativeRequest(id: string | number): boolean {
    const pending = this.#nativePending.get(id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.#nativePending.delete(id);
    pending.abort.abort();
    this.#observeReply(pending, pending.invoked ? "unknown" : "not_written");
    return true;
  }

  close(error = new CodexRpcError("cancelled")): void {
    if (this.#failure) return;
    this.#failure = error;
    this.#abort.abort();
    this.#options.signal.removeEventListener("abort", this.#cancelled);
    this.#options.output.off("data", this.#data).off("end", this.#ended);
    // Retain error handlers until streams close: write callbacks can precede error events.
    this.#fragment = Buffer.alloc(0);
    for (const entry of this.#pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.#pending.clear();
    for (const id of this.#nativePending.keys()) this.cancelNativeRequest(id);
    clearTimeout(this.#writeTimer);
    this.#nativeIds.clear();
    this.#writing?.reject(error);
    for (const write of this.#writes) write.reject(error);
    this.#writes = [];
    this.#notifications = [];
    this.#finish(error);
  }

  #cancelled = (): void => this.close(new CodexRpcError("cancelled"));
  #failed = (): void => this.close(new CodexRpcError("transport_failed"));
  #ended = (): void => this.close(new CodexRpcError(this.#fragment.length ? "protocol_error" : "transport_failed"));
  #inputClosed = (): void => {
    this.#failed();
    this.#options.input.off("error", this.#failed).off("finish", this.#failed);
  };
  #outputClosed = (): void => {
    this.#failed();
    this.#options.output.off("error", this.#failed);
  };

  #send(message: unknown, signal?: AbortSignal, native?: NativePending, sending?: () => void): Promise<void> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (signal?.aborted) return Promise.resolve();
    let bytes: Buffer;
    try { bytes = Buffer.from(JSON.stringify(message) + "\n"); }
    catch { this.close(new CodexRpcError("protocol_error")); return Promise.reject(this.#failure); }
    if (bytes.length > this.#limits.frameBytes || this.#writeBytes + bytes.length > this.#limits.writeBytes) {
      this.close(new CodexRpcError("capacity_exceeded"));
      return Promise.reject(this.#failure);
    }
    return new Promise((resolve, reject) => {
      // Validate the serialized response, not a mutable result retained by a handler.
      if (native) native.result = (JSON.parse(bytes.toString("utf8")) as { result?: unknown }).result;
      this.#writeBytes += bytes.length;
      this.#writes.push({ bytes, resolve, reject, signal, native, sending });
      this.#pumpWrites();
    });
  }

  #pumpWrites(): void {
    if (this.#failure || this.#writing) return;
    const write = this.#writes.shift();
    if (!write) return;
    if (write.signal?.aborted) {
      this.#writeBytes -= write.bytes.length;
      write.resolve();
      this.#pumpWrites();
      return;
    }
    this.#writing = write;
    try {
      write.sending?.();
      if (write.native) this.#options.onReplySending?.(write.native.request, write.native.result);
    } catch { this.close(new CodexRpcError("handler_failed")); return; }
    if (this.#failure) return;
    if (write.signal?.aborted) {
      this.#writing = undefined;
      this.#writeBytes -= write.bytes.length;
      write.resolve();
      this.#pumpWrites();
      return;
    }
    this.#writeTimer = setTimeout(() => this.close(new CodexRpcError("timeout")), this.#options.writeTimeoutMs ?? 30000);
    try {
      if (write.native) write.native.invoked = true;
      this.#options.input.write(write.bytes, error => {
        clearTimeout(this.#writeTimer);
        this.#writeBytes -= write.bytes.length;
        if (error) { write.reject(new CodexRpcError("transport_failed")); this.#failed(); return; }
        if (this.#failure) return;
        // Keep ownership while observing: callbacks may enqueue another write or fail.
        if (write.native) this.#observeReply(write.native, "written");
        if (this.#failure) { write.reject(this.#failure); return; }
        this.#writing = undefined;
        write.resolve();
        this.#pumpWrites();
      });
    } catch { this.#failed(); }
  }

  #observeReply(pending: NativePending, outcome: CodexReplyObservation["outcome"]): void {
    if (pending.outcome) return;
    pending.outcome = outcome;
    try { this.#options.onReplyOutcome?.({ requestId: pending.request.id, method: pending.request.method, outcome }); }
    catch { this.close(new CodexRpcError("handler_failed")); }
  }

  #data = (chunk: unknown): void => {
    if (this.#failure) return;
    try {
      if (!Buffer.isBuffer(chunk)) throw new CodexRpcError("protocol_error");
      let start = 0;
      while (start < chunk.length && !this.#failure) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline;
        const length = this.#fragment.length + end - start;
        if (length > this.#limits.frameBytes) throw new CodexRpcError("capacity_exceeded");
        const frame = Buffer.concat([this.#fragment, chunk.subarray(start, end)], length);
        if (newline < 0) { this.#fragment = frame; break; }
        this.#fragment = Buffer.alloc(0);
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
        this.#message(value, length);
        start = newline + 1;
      }
    } catch (error) { this.close(error instanceof CodexRpcError ? error : new CodexRpcError("protocol_error")); }
  };

  #message(value: unknown, bytes: number): void {
    if (!record(value) || (value.jsonrpc !== undefined && value.jsonrpc !== "2.0")) throw new CodexRpcError("protocol_error");
    const hasId = Object.hasOwn(value, "id");
    const hasResult = Object.hasOwn(value, "result");
    const hasError = Object.hasOwn(value, "error");
    if (hasId && !validId(value.id)) throw new CodexRpcError("protocol_error");
    if (Object.hasOwn(value, "method")) {
      if (typeof value.method !== "string" || !value.method || value.method.length > 256 || hasResult || hasError) throw new CodexRpcError("protocol_error");
      const message = { method: value.method, params: value.params };
      if (hasId) this.#nativeRequest({ ...message, id: value.id as string | number });
      else {
        // Resolution cancels a reply immediately, even if application event handling is busy.
        if (message.method === "serverRequest/resolved") {
          if (!record(message.params) || !validId(message.params.requestId)) throw new CodexRpcError("protocol_error");
          this.cancelNativeRequest(message.params.requestId);
        }
        if (message.method === "turn/completed") {
          const params = message.params;
          if (!record(params) || !validId(params.threadId) || !record(params.turn) || !validId(params.turn.id)
            || !["completed", "failed", "interrupted"].includes(String(params.turn.status))) throw new CodexRpcError("protocol_error");
          for (const [id, pending] of this.#nativePending) {
            const request = pending.request.params;
            if (record(request) && request.threadId === params.threadId && request.turnId === params.turn.id) this.cancelNativeRequest(id);
          }
        }
        try { this.#options.onNotificationReceived?.(structuredClone(message)); }
        catch { throw new CodexRpcError("handler_failed"); }
        if (!this.#failure) this.#notification(message, bytes);
      }
      return;
    }
    if (!hasId || hasResult === hasError) throw new CodexRpcError("protocol_error");
    const id = value.id as string | number;
    const entry = this.#pending.get(id);
    if (!entry || entry.response) throw new CodexRpcError("protocol_error");
    if (hasError) {
      if (!record(value.error) || !Number.isSafeInteger(value.error.code) || typeof value.error.message !== "string") throw new CodexRpcError("protocol_error");
      entry.response = { error: new CodexRpcError("remote_error", value.error.code as number) };
    } else entry.response = { result: value.result };
    this.#settle(id, entry);
  }

  #settle(id: string | number, entry: Pending): void {
    if (this.#failure || !entry.response || !entry.written) return;
    clearTimeout(entry.timer);
    this.#pending.delete(id);
    if (entry.response.error) entry.reject(entry.response.error); else entry.resolve(entry.response.result);
  }

  #nativeRequest(message: CodexRequest): void {
    if (this.#nativeIds.has(message.id)) throw new CodexRpcError("protocol_error");
    if (this.#nativeIds.size >= this.#limits.nativeIds || this.#nativePending.size >= this.#limits.nativeRequests) throw new CodexRpcError("capacity_exceeded");
    this.#nativeIds.add(message.id);
    const abort = new AbortController();
    const timer = setTimeout(() => this.close(new CodexRpcError("timeout")), this.#options.nativeRequestTimeoutMs ?? 300000);
    const pending: NativePending = { timer, abort, request: message, invoked: false };
    this.#nativePending.set(message.id, pending);
    const lifetime = Promise.resolve().then(async () => {
      if (this.#failure || abort.signal.aborted) return;
      if (!this.#options.onRequest) {
        await this.#send({ id: message.id, error: { code: -32601, message: "Unsupported request" } }, abort.signal, pending);
        return;
      }
      const result = await this.#options.onRequest(message, AbortSignal.any([this.#abort.signal, abort.signal]));
      if (!this.#failure && !abort.signal.aborted) await this.#send({ id: message.id, result: result ?? null }, abort.signal, pending);
    }).catch(() => { if (!abort.signal.aborted) this.close(new CodexRpcError("handler_failed")); }).finally(() => {
      clearTimeout(timer);
      this.#nativePending.delete(message.id);
    });
    this.#options.onLocalLifetime?.(lifetime);
  }

  #notification(message: CodexNotification, bytes: number): void {
    if (!this.#options.onNotification) return;
    if (this.#notificationCount >= this.#limits.notificationCount || this.#notificationBytes + bytes > this.#limits.notificationBytes) throw new CodexRpcError("capacity_exceeded");
    this.#notificationCount++;
    this.#notificationBytes += bytes;
    this.#notifications.push({ message, bytes });
    if (!this.#notifying) {
      const lifetime = this.#drainNotifications();
      this.#options.onLocalLifetime?.(lifetime);
    }
  }

  async #drainNotifications(): Promise<void> {
    this.#notifying = true;
    try {
      for (let next; !this.#failure && (next = this.#notifications.shift());) {
        await this.#options.onNotification!(next.message, this.#abort.signal);
        this.#notificationCount--;
        this.#notificationBytes -= next.bytes;
      }
    } catch { this.close(new CodexRpcError("handler_failed")); }
    finally { this.#notifying = false; }
  }
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function validId(value: unknown): value is string | number {
  return (typeof value === "number" && Number.isSafeInteger(value))
    || (typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value));
}
