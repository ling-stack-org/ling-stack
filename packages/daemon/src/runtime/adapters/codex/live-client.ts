import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CodexDuplex, CodexRpcError, type CodexDuplexOptions, type CodexNotification, type CodexRequest } from "./duplex.js";
import type { InitializeParams } from "./protocol/InitializeParams.js";
import type { AskForApproval } from "./protocol/v2/AskForApproval.js";
import type { SandboxPolicy } from "./protocol/v2/SandboxPolicy.js";
import type { ThreadStartParams } from "./protocol/v2/ThreadStartParams.js";
import type { ThreadResumeParams } from "./protocol/v2/ThreadResumeParams.js";
import type { TurnStartParams } from "./protocol/v2/TurnStartParams.js";
import type { Turn } from "./protocol/v2/Turn.js";
import { readCodexLocalEnvironment, type CodexLocalEnvironment } from "./local-environment.js";

export class CodexLifecycleError extends Error {
  constructor(readonly code: "invalid_state" | "invalid_input" | "binding_mismatch" | "invalid_response"
    | "submission_uncertain" | "submission_rejected" | "host_commit_failed" | "invalid_event" | "connection_lost",
  readonly outcome: "not_submitted" | "unknown" | "accepted" = "not_submitted") { super(code); }
}

export interface CodexThreadConfiguration {
  readonly cwd: string;
  readonly model: string;
  readonly modelProvider: string;
  readonly approvalPolicy: AskForApproval;
  readonly sandbox: SandboxPolicy;
  readonly config?: ThreadStartParams["config"];
  readonly baseInstructions?: string;
  readonly developerInstructions?: string;
}
export interface CodexThreadBinding {
  readonly threadId: string;
  readonly configuration: CodexThreadConfiguration;
  readonly localEnvironment?: CodexLocalEnvironment;
}
export interface CodexTurnBinding { readonly threadId: string; readonly turnId: string }
export type CodexTurnResult = Pick<Turn, "id" | "status">;
export type CodexTurnInput = Pick<TurnStartParams, "input" | "clientUserMessageId" | "effort" | "summary" | "outputSchema">;
export interface CodexTurnHandle extends CodexTurnBinding {
  readonly completed: Promise<CodexTurnResult>;
  readonly interrupt: () => Promise<void>;
}
export interface CodexLiveClientOptions extends Pick<CodexDuplexOptions, "input" | "output" | "signal" | "requestTimeoutMs" | "limits" | "onReplySending" | "onReplyOutcome" | "onNotificationReceived" | "onLocalLifetime"> {
  readonly codexHome: string;
  readonly assertSubmissionCurrent?: () => void;
  readonly turnTimeoutMs?: number;
  readonly hostTimeoutMs?: number;
  readonly onThreadAccepted: (binding: CodexThreadBinding, signal: AbortSignal) => Promise<void>;
  readonly onTurnSubmitting?: (binding: CodexThreadBinding, signal: AbortSignal) => Promise<void>;
  readonly onTurnAccepted: (binding: CodexTurnBinding, signal: AbortSignal) => Promise<void>;
  readonly beforeEvent?: (message: CodexNotification, signal: AbortSignal) => Promise<void>;
  readonly beforeRequest?: (message: CodexRequest, signal: AbortSignal) => Promise<void>;
  readonly onEvent: (message: CodexNotification, signal: AbortSignal) => Promise<void>;
  readonly onRequest: (message: CodexRequest, signal: AbortSignal) => Promise<unknown>;
}
interface ActiveTurn {
  id?: string;
  submitted: boolean;
  accepted: ReturnType<typeof deferred<void>>;
  completed: ReturnType<typeof deferred<CodexTurnResult>>;
  timer: ReturnType<typeof setTimeout>;
  remainingMs: number;
  activeSince: number;
  approvalWaiting: boolean;
  requests: Set<string | number>;
  interrupted: boolean;
}
type ClientState = "new" | "initializing" | "ready" | "binding" | "thread" | "turn";

/** Single native-thread lifecycle. Host callbacks must persist bindings before acknowledging them. */
export class CodexLiveClient {
  readonly #options: CodexLiveClientOptions;
  readonly #rpc: CodexDuplex;
  readonly #abort = new AbortController();
  readonly #terminal = deferred<CodexLifecycleError>();
  #failure?: CodexLifecycleError;
  #state: ClientState = "new";
  #binding?: CodexThreadBinding;
  #turn?: ActiveTurn;

  constructor(options: CodexLiveClientOptions) {
    if (!validPath(options.codexHome) || !Number.isSafeInteger(options.turnTimeoutMs ?? 1800000)
      || (options.turnTimeoutMs ?? 1800000) < 1 || (options.turnTimeoutMs ?? 1800000) > 2 ** 30
      || !Number.isSafeInteger(options.hostTimeoutMs ?? 30000) || (options.hostTimeoutMs ?? 30000) < 1
      || (options.hostTimeoutMs ?? 30000) > 2 ** 30) throw new CodexLifecycleError("invalid_input");
    this.#options = options;
    this.#rpc = new CodexDuplex({ ...options, onRequestSending: message => {
      if (message.method === "turn/start") options.assertSubmissionCurrent?.();
    }, onNotification: message => this.#notification(message),
      onRequest: (message, signal) => this.#request(message, signal) });
    void this.#rpc.closed.then(() => this.#fail(new CodexLifecycleError(
      this.#turn?.submitted && !this.#turn.id ? "submission_uncertain" : "connection_lost",
      this.#turn?.id ? "accepted" : this.#turn?.submitted ? "unknown" : "not_submitted")));
  }

  async initialize(): Promise<void> {
    this.#ensure("new");
    this.#state = "initializing";
    const params: InitializeParams = { clientInfo: { name: "ling-stack", version: "0.1.2-alpha.1", title: "Ling" },
      capabilities: { experimentalApi: true, requestAttestation: false } };
    try {
      const value = await this.#rpc.request("initialize", params);
      if (!record(value) || !text(value.userAgent) || !validPath(value.codexHome)
        || resolve(value.codexHome) !== resolve(this.#options.codexHome)
        || value.platformFamily !== (process.platform === "win32" ? "windows" : "unix") || !text(value.platformOs)) {
        throw new CodexLifecycleError("binding_mismatch");
      }
      await this.#rpc.notify("initialized");
      this.#check();
      this.#state = "ready";
    } catch (error) { throw this.#fail(lifecycle(error, "invalid_response")); }
  }

  async openThread(configuration: CodexThreadConfiguration, resumeThreadId?: string): Promise<CodexThreadBinding> {
    this.#ensure("ready");
    if (!validPath(configuration.cwd) || !text(configuration.model) || !text(configuration.modelProvider)
      || (resumeThreadId !== undefined && !text(resumeThreadId)) || !record(configuration.sandbox)) throw new CodexLifecycleError("invalid_input");
    const sandbox = configuration.sandbox.type === "readOnly" ? "read-only"
      : configuration.sandbox.type === "workspaceWrite" ? "workspace-write"
      : configuration.sandbox.type === "dangerFullAccess" ? "danger-full-access" : undefined;
    if (!sandbox) throw new CodexLifecycleError("invalid_input");
    const selected = structuredClone(configuration);
    const params: ThreadStartParams = { cwd: selected.cwd, model: selected.model, modelProvider: selected.modelProvider,
      approvalPolicy: selected.approvalPolicy, approvalsReviewer: "user", sandbox, config: selected.config,
      baseInstructions: selected.baseInstructions, developerInstructions: selected.developerInstructions };
    const resume: ThreadResumeParams | undefined = resumeThreadId ? { ...params, threadId: resumeThreadId, excludeTurns: true } : undefined;
    this.#state = "binding";
    try {
      const value = await this.#rpc.request(resume ? "thread/resume" : "thread/start", resume ?? params);
      this.#check();
      if (!record(value) || !record(value.thread) || !text(value.thread.id)
        || (resumeThreadId !== undefined && value.thread.id !== resumeThreadId)
        || !validPath(value.cwd) || resolve(value.cwd) !== resolve(selected.cwd)
        || !validPath(value.thread.cwd) || resolve(value.thread.cwd) !== resolve(selected.cwd)
        || value.model !== selected.model || value.thread.model !== selected.model
        || value.modelProvider !== selected.modelProvider || value.thread.modelProvider !== selected.modelProvider
        || value.approvalsReviewer !== "user" || !isDeepStrictEqual(value.approvalPolicy, selected.approvalPolicy)
        || !isDeepStrictEqual(value.sandbox, selected.sandbox)
        || !Array.isArray(value.thread.turns) || value.thread.turns.some(turn => !record(turn) || turn.status === "inProgress")
        || !record(value.thread.status) || value.thread.status.type !== "idle") throw new CodexLifecycleError("binding_mismatch");
      const localEnvironment = readCodexLocalEnvironment(value.thread.environments, selected.cwd);
      if (localEnvironment === null) throw new CodexLifecycleError("binding_mismatch");
      const binding = { threadId: value.thread.id, configuration: selected, ...(localEnvironment ? { localEnvironment } : {}) };
      await this.#host(() => this.#options.onThreadAccepted(structuredClone(binding), this.#abort.signal));
      this.#binding = binding;
      this.#state = "thread";
      return structuredClone(binding);
    } catch (error) { throw this.#fail(lifecycle(error, "invalid_response")); }
  }

  async startTurn(input: CodexTurnInput): Promise<CodexTurnHandle> {
    this.#ensure("thread");
    if (!record(input) || Object.keys(input).some(key => !["input", "clientUserMessageId", "effort", "summary", "outputSchema"].includes(key))
      || !Array.isArray(input.input) || !input.input.length || input.input.some(item => !validInput(item))) throw new CodexLifecycleError("invalid_input");
    const binding = this.#binding!;
    const selected = binding.configuration;
    const params: TurnStartParams = { ...structuredClone(input), threadId: binding.threadId, cwd: selected.cwd,
      model: selected.model, approvalPolicy: selected.approvalPolicy, approvalsReviewer: "user", sandboxPolicy: selected.sandbox };
    const active: ActiveTurn = { accepted: deferred<void>(), completed: deferred<CodexTurnResult>(), submitted: false,
      requests: new Set(), interrupted: false,
      remainingMs: this.#options.turnTimeoutMs ?? 1800000, activeSince: performance.now(), approvalWaiting: false,
      timer: setTimeout(() => this.#fail(new CodexLifecycleError("connection_lost", active.id ? "accepted" : active.submitted ? "unknown" : "not_submitted")), this.#options.turnTimeoutMs ?? 1800000) };
    this.#turn = active;
    this.#state = "turn";
    try {
      if (this.#options.onTurnSubmitting) await this.#host(() => this.#options.onTurnSubmitting!(structuredClone(binding), this.#abort.signal));
      this.#check();
      active.submitted = true;
      const value = await this.#rpc.request("turn/start", params);
      this.#check();
      if (!record(value) || !validTurn(value.turn)) throw new CodexLifecycleError("invalid_response", "unknown");
      active.id = value.turn.id;
      const turnBinding = { threadId: binding.threadId, turnId: active.id };
      await this.#host(() => this.#options.onTurnAccepted(turnBinding, this.#abort.signal), "accepted");
      active.accepted.resolve();
      return { ...turnBinding, completed: active.completed.promise, interrupt: () => this.#interrupt(active) };
    } catch (error) {
      const fallback = error instanceof CodexRpcError && error.code === "remote_error" ? "submission_rejected" : "submission_uncertain";
      throw this.#fail(lifecycle(error, fallback, active.id ? "accepted" : fallback === "submission_rejected" ? "not_submitted" : "unknown"));
    }
  }

  close(): void { this.#rpc.close(); }

  setApprovalWaiting(waiting: boolean): void {
    const active = this.#turn;
    if (!active || this.#failure || active.approvalWaiting === waiting) return;
    active.approvalWaiting = waiting;
    clearTimeout(active.timer);
    if (waiting) {
      active.remainingMs = Math.max(0, active.remainingMs - (performance.now() - active.activeSince));
      if (active.remainingMs === 0) this.#fail(new CodexLifecycleError("connection_lost", "accepted"));
    } else {
      active.activeSince = performance.now();
      active.timer = setTimeout(() => this.#fail(new CodexLifecycleError("connection_lost", "accepted")), active.remainingMs);
    }
  }

  async #interrupt(active: ActiveTurn): Promise<void> {
    this.#check();
    if (this.#turn !== active || !active.id) throw new CodexLifecycleError("invalid_state");
    if (active.interrupted) return;
    active.interrupted = true;
    this.#cancelRequests(active);
    try { await this.#rpc.request("turn/interrupt", { threadId: this.#binding!.threadId, turnId: active.id }); }
    catch (error) { throw this.#fail(lifecycle(error, "connection_lost", "accepted")); }
  }

  async #notification(message: CodexNotification): Promise<void> {
    const params = message.params;
    const isTurnEvent = message.method.startsWith("turn/") || message.method.startsWith("item/") || message.method === "error" || message.method === "model/rerouted";
    if (!record(params)) {
      if (isTurnEvent || message.method === "serverRequest/resolved") throw this.#fail(new CodexLifecycleError("invalid_event", this.#turn?.id ? "accepted" : "unknown"));
      return;
    }
    if (message.method === "serverRequest/resolved") {
      if (params.threadId !== this.#binding?.threadId || (typeof params.requestId !== "string" && typeof params.requestId !== "number")) throw new CodexLifecycleError("invalid_event");
      this.#rpc.cancelNativeRequest(params.requestId);
      this.#turn?.requests.delete(params.requestId);
      const outcome = this.#turn?.id ? "accepted" : "not_submitted";
      await this.#deliverEvent(message, outcome);
      return;
    }
    if (!isTurnEvent) return;
    const active = this.#turn;
    if (!active) throw this.#fail(new CodexLifecycleError("invalid_event"));
    await this.#race(active.accepted.promise);
    this.#check();
    const turnId = message.method === "turn/started" || message.method === "turn/completed"
      ? record(params.turn) ? params.turn.id : undefined : params.turnId;
    const binding = this.#binding;
    if (!binding || params.threadId !== binding.threadId || turnId !== active.id || this.#turn !== active) throw this.#fail(new CodexLifecycleError("invalid_event", "accepted"));
    if (message.method === "model/rerouted" && params.toModel !== binding.configuration.model) throw this.#fail(new CodexLifecycleError("binding_mismatch", "accepted"));
    if ((message.method === "turn/started" || message.method === "turn/completed") && !validTurn(params.turn)) throw this.#fail(new CodexLifecycleError("invalid_event", "accepted"));
    if (message.method === "turn/completed") {
      if (!validTurn(params.turn) || params.turn.status === "inProgress") throw this.#fail(new CodexLifecycleError("invalid_event", "accepted"));
      this.#cancelRequests(active);
      await this.#deliverEvent(message, "accepted");
      clearTimeout(active.timer);
      this.#turn = undefined;
      this.#state = "thread";
      active.completed.resolve({ id: params.turn.id, status: params.turn.status });
    } else await this.#deliverEvent(message, "accepted");
  }

  async #request(message: CodexRequest, signal: AbortSignal): Promise<unknown> {
    const active = this.#turn;
    if (!active) throw this.#fail(new CodexLifecycleError("invalid_event"));
    active.requests.add(message.id);
    try {
      await this.#race(active.accepted.promise);
      this.#check();
      if (active.interrupted || signal.aborted) { this.#rpc.cancelNativeRequest(message.id); return; }
      const params = message.params;
      if (!record(params) || params.threadId !== this.#binding?.threadId || params.turnId !== active.id || this.#turn !== active
        || !["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput", "item/tool/call"].includes(message.method)
        || !text(message.method === "item/tool/call" ? params.callId : params.itemId)) throw this.#fail(new CodexLifecycleError("invalid_event", "accepted"));
      if (this.#options.beforeRequest) {
        try { await this.#host(() => this.#options.beforeRequest!(message, signal), "accepted"); }
        catch (error) { throw this.#fail(lifecycle(error, "host_commit_failed", "accepted")); }
      }
      return await this.#options.onRequest(message, signal);
    } finally {
      // Keep the id until native resolution or turn completion: the transport may still be writing the reply.
      if (signal.aborted) active.requests.delete(message.id);
    }
  }

  #cancelRequests(active: ActiveTurn): void {
    for (const id of active.requests) this.#rpc.cancelNativeRequest(id);
    active.requests.clear();
  }

  async #deliverEvent(message: CodexNotification, outcome: "not_submitted" | "accepted"): Promise<void> {
    try {
      if (this.#options.beforeEvent) await this.#host(() => this.#options.beforeEvent!(message, this.#abort.signal), outcome);
      await this.#host(() => this.#options.onEvent(message, this.#abort.signal), outcome);
    } catch (error) { throw this.#fail(lifecycle(error, "host_commit_failed", outcome)); }
  }

  async #host(operation: () => Promise<void>, outcome: "not_submitted" | "accepted" = "not_submitted"): Promise<void> {
    const timer = setTimeout(() => this.#fail(new CodexLifecycleError("host_commit_failed", outcome)), this.#options.hostTimeoutMs ?? 30000);
    try { await this.#race(Promise.resolve().then(() => { this.#check(); return operation(); })); this.#check(); }
    catch (error) { throw this.#failure ?? new CodexLifecycleError("host_commit_failed", outcome); }
    finally { clearTimeout(timer); }
  }

  #race<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([operation, this.#terminal.promise.then(error => { throw error; })]);
  }
  #check(): void { if (this.#failure) throw this.#failure; }
  #ensure(state: ClientState): void { this.#check(); if (this.#state !== state) throw new CodexLifecycleError("invalid_state"); }
  #fail(error: CodexLifecycleError): CodexLifecycleError {
    if (this.#failure) return this.#failure;
    this.#failure = error;
    this.#abort.abort();
    this.#terminal.resolve(error);
    if (this.#turn) {
      clearTimeout(this.#turn.timer);
      this.#cancelRequests(this.#turn);
      this.#turn.accepted.reject(error);
      this.#turn.completed.reject(error);
    }
    this.#rpc.close();
    return error;
  }
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value); }
function validPath(value: unknown): value is string { return text(value) && isAbsolute(value); }
function validTurn(value: unknown): value is CodexTurnResult {
  return record(value) && text(value.id) && ["inProgress", "completed", "interrupted", "failed"].includes(String(value.status));
}
function validInput(value: unknown): boolean {
  if (!record(value)) return false;
  switch (value.type) {
    case "text": return typeof value.text === "string" && Array.isArray(value.text_elements);
    case "image": case "audio": return text(value.url);
    case "localImage": case "localAudio": return validPath(value.path);
    case "skill": case "mention": return text(value.name) && text(value.path);
    default: return false;
  }
}
function lifecycle(error: unknown, code: CodexLifecycleError["code"], outcome: CodexLifecycleError["outcome"] = "not_submitted"): CodexLifecycleError {
  return error instanceof CodexLifecycleError ? error : new CodexLifecycleError(code, outcome);
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  // The completed/accepted promises can reject before the caller receives a handle.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
