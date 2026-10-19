import type { Readable, Writable } from "node:stream";
import { validateNativeOpenClawSessionRoute, type NativeOpenClawSessionRoute } from "@ling-stack/core";
import { client, methods, PROTOCOL_VERSION, type AnyMessage, type ClientConnection, type ContentBlock,
  type InitializeResponse, type JsonRpcId, type PromptResponse, type RequestPermissionRequest,
  type RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { AcpLifecycleError, record, text } from "./live-errors.js";
import { createAcpLiveStream, type AcpReplyObservation } from "./live-stream.js";
import { AcpSessionSettings, validateAcpSessionConfiguration, type AcpSessionConfiguration, type AcpSessionSettingsSnapshot } from "./session-settings.js";
import { AcpSessionMetadata, type AcpSessionMetadataSnapshot } from "./session-metadata.js";
import { AcpHostFiles, type AcpHostFileHandlers } from "./host-files.js";
import { AcpHostTerminals, type AcpHostTerminalHandlers } from "./host-terminals.js";

export { AcpLifecycleError } from "./live-errors.js";
export type { AcpSessionConfiguration } from "./session-settings.js";
export interface AcpSessionBinding { readonly sessionId: string; readonly configuration: AcpSessionConfiguration }
export interface AcpPromptBinding { readonly requestId: JsonRpcId; readonly binding: AcpSessionBinding }
/** Native update content is untrusted; target normalization must validate each supported variant. */
export interface AcpSessionUpdate { readonly sessionId: string; readonly update: Readonly<Record<string, unknown>> }
export interface AcpPromptHandle { readonly completed: Promise<PromptResponse>; cancel(): Promise<void> }
export interface AcpPermissionRequest { readonly requestId: JsonRpcId; readonly params: RequestPermissionRequest }
export type AcpPermissionReplyObservation = Omit<AcpReplyObservation, "method">;
export interface AcpLiveClientOptions {
  readonly input: Writable;
  readonly output: Readable;
  readonly signal: AbortSignal;
  readonly engineId: "kimi-acp" | "openclaw-acp";
  readonly expectedVersion: string;
  readonly requestTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly hostTimeoutMs?: number;
  readonly hostFileTimeoutMs?: number;
  /** Trusted target port, absent until its policy/effect/containment gates are implemented. */
  readonly hostFiles?: AcpHostFileHandlers;
  readonly hostTerminalTimeoutMs?: number;
  readonly hostTerminals?: AcpHostTerminalHandlers;
  readonly cancelTimeoutMs?: number;
  readonly writeTimeoutMs?: number;
  readonly frameBytes?: number;
  readonly onSessionAccepted: (binding: AcpSessionBinding, signal: AbortSignal) => Promise<void>;
  readonly onPromptSubmitting: (binding: AcpSessionBinding, signal: AbortSignal) => Promise<void>;
  /** Synchronous durable reservation immediately before invoking stdin.write, never a native acceptance. */
  readonly onPromptSending?: (prompt: AcpPromptBinding, signal: AbortSignal) => void;
  /** Synchronous host commit for the first bound native activity/result, before output or permission callbacks. */
  readonly onPromptAccepted?: (prompt: AcpPromptBinding, signal: AbortSignal) => void;
  /** Preserve validated native terminal evidence before asynchronous output delivery can fail. */
  readonly onPromptResultReceived?: (result: PromptResponse, signal: AbortSignal) => void;
  /** Synchronous context commit for an active submitted prompt, never idle/load replay. */
  readonly onUpdateReceived?: (update: AcpSessionUpdate, signal: AbortSignal) => void;
  readonly onUpdate: (update: AcpSessionUpdate, signal: AbortSignal) => Promise<void>;
  /** Synchronous approval snapshot commit before later input or asynchronous SDK dispatch. */
  readonly onPermissionReceived?: (request: AcpPermissionRequest, signal: AbortSignal) => void;
  readonly onPermission: (request: AcpPermissionRequest, signal: AbortSignal) => Promise<"approve_once" | "deny">;
  /** Synchronous claim of the selected once-only decision, rechecked after callback cancellation. */
  readonly onPermissionReplySending?: (request: AcpPermissionRequest, response: RequestPermissionResponse, signal: AbortSignal) => void;
  readonly onPermissionReplyOutcome?: (observation: AcpPermissionReplyObservation) => void;
  readonly assertSubmissionCurrent?: () => void;
  readonly onLocalLifetime?: (lifetime: Promise<unknown>) => void;
}
interface ActivePrompt {
  readonly permissions: AbortController;
  readonly completion: ReturnType<typeof deferred<PromptResponse>>;
  timer?: ReturnType<typeof setTimeout>;
  cancelTimer?: ReturnType<typeof setTimeout>;
  submitted: boolean;
  requestId?: JsonRpcId;
  accepted?: boolean;
  terminal: boolean;
  cancelling: boolean;
}
interface PendingPermission { readonly active: ActivePrompt; readonly signal: AbortSignal; readonly params: RequestPermissionRequest }
type ClientState = "new" | "initializing" | "ready" | "binding" | "session" | "prompt";

/** One owned ACP session; callers own process supervision, policy and durable journal commits. */
export class AcpLiveClient {
  readonly #options: AcpLiveClientOptions;
  readonly #connection: ClientConnection;
  readonly #transport: ReturnType<typeof createAcpLiveStream>;
  readonly #abort = new AbortController();
  readonly #permissions = new Map<JsonRpcId, PendingPermission>();
  readonly #bindingReady = deferred<void>();
  readonly #metadata = new AcpSessionMetadata();
  readonly #hostFiles: AcpHostFiles;
  readonly #hostTerminals: AcpHostTerminals;
  #state: ClientState = "new";
  #initialization?: InitializeResponse;
  #binding?: AcpSessionBinding;
  #sessionId?: string;
  #settings?: AcpSessionSettings;
  #active?: ActivePrompt;
  #failure?: AcpLifecycleError;
  #updates: Promise<void> = Promise.resolve();
  #queuedUpdates = 0;
  #queuedBytes = 0;
  readonly #externalAbort = (): void => { this.#fail(new AcpLifecycleError("cancelled", this.#outcome())); };

  get sessionMetadata(): AcpSessionMetadataSnapshot { return this.#metadata.snapshot; }

  constructor(options: AcpLiveClientOptions) {
    for (const duration of [options.requestTimeoutMs ?? 30000, options.hostTimeoutMs ?? 30000,
      options.turnTimeoutMs ?? 1800000, options.cancelTimeoutMs ?? 5000, options.hostFileTimeoutMs ?? 300000,
      options.hostTerminalTimeoutMs ?? 300000]) {
      if (!Number.isSafeInteger(duration) || duration < 1 || duration > 2 ** 30) throw new AcpLifecycleError("invalid_input");
    }
    if (!text(options.expectedVersion) || !["kimi-acp", "openclaw-acp"].includes(options.engineId)) throw new AcpLifecycleError("invalid_input");
    this.#options = options;
    this.#hostFiles = new AcpHostFiles(options.hostFiles, options.hostFileTimeoutMs ?? 300000,
      error => this.#fail(error), id => this.#transport.retireReply(id));
    this.#hostTerminals = new AcpHostTerminals(options.hostTerminals, options.hostTerminalTimeoutMs ?? 300000,
      error => this.#fail(error), id => this.#transport.retireReply(id), options.frameBytes ?? 8 * 1024 * 1024);
    this.#transport = createAcpLiveStream({ ...options, onReceive: (message, method) => this.#receive(message, method),
      beforeWrite: message => this.#beforeWrite(message), onSending: message => this.#sending(message), onWritten: message => {
        if ("id" in message && !("method" in message)) {
          this.#permissions.delete(message.id); this.#hostFiles.written(message.id); this.#hostTerminals.written(message.id);
        }
      }, onReplyOutcome: observation => {
        if (observation.method === methods.client.session.requestPermission) {
          return this.#options.onPermissionReplyOutcome?.({ requestId: observation.requestId, outcome: observation.outcome });
        }
        this.#hostFiles.observe(observation);
        this.#hostTerminals.observe(observation);
      }, onFailure: error => { this.#fail(new AcpLifecycleError(error.code, this.#outcome())); } });
    this.#connection = client({ name: "ling-native-acp" })
      // Receipt owns ordering before async SDK dispatch and never logs untrusted update content.
      .onNotification(methods.client.session.update, (value: unknown) => value, () => {})
      .onRequest(methods.client.session.requestPermission, context => this.#permission(context.requestId, context.signal))
      .onRequest(methods.client.fs.readTextFile, context => this.#hostFiles.read(context.requestId, context.signal))
      .onRequest(methods.client.fs.writeTextFile, context => this.#hostFiles.write(context.requestId, context.signal))
      .onRequest(methods.client.terminal.create, context => this.#hostTerminals.create(context.requestId, context.signal))
      .onRequest(methods.client.terminal.output, context => this.#hostTerminals.output(context.requestId, context.signal))
      .onRequest(methods.client.terminal.waitForExit, context => this.#hostTerminals.waitForExit(context.requestId, context.signal))
      .onRequest(methods.client.terminal.kill, context => this.#hostTerminals.kill(context.requestId, context.signal))
      .onRequest(methods.client.terminal.release, context => this.#hostTerminals.release(context.requestId, context.signal))
      .connect(this.#transport.stream);
    void this.#connection.closed.then(() => { this.#fail(new AcpLifecycleError(this.#active?.submitted ? "submission_uncertain" : "connection_lost", this.#outcome())); });
    options.signal.addEventListener("abort", this.#externalAbort, { once: true });
    if (options.signal.aborted || options.input.destroyed || options.output.destroyed) this.#externalAbort();
  }

  get closed(): Promise<void> { return this.#connection.closed.then(async () => {
    const results = await Promise.allSettled([this.#hostFiles.drain(), this.#hostTerminals.drain()]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }); }
  get sessionSettings(): AcpSessionSettingsSnapshot | undefined { return this.#settings?.snapshot; }
  close(): void { this.#fail(new AcpLifecycleError("cancelled", this.#outcome())); }

  async initialize(): Promise<InitializeResponse> {
    this.#ensure("new"); this.#state = "initializing";
    try {
      const value = await this.#bounded(this.#connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION, clientCapabilities: { ...this.#hostFiles.capabilities, ...this.#hostTerminals.capabilities }, clientInfo: { name: "ling-stack", version: "0.1.2-alpha.1" },
      }), this.#options.requestTimeoutMs ?? 30000, "timeout");
      if (!record(value) || value.protocolVersion !== PROTOCOL_VERSION || !record(value.agentInfo)
        || value.agentInfo.name !== (this.#options.engineId === "kimi-acp" ? "Kimi Code CLI" : "openclaw-acp")
        || value.agentInfo.version !== this.#options.expectedVersion || !record(value.agentCapabilities)
        || (value.agentCapabilities.loadSession !== undefined && typeof value.agentCapabilities.loadSession !== "boolean")) throw new AcpLifecycleError("binding_mismatch");
      this.#initialization = structuredClone(value); this.#state = "ready";
      return structuredClone(value);
    } catch (error) { throw this.#fail(this.#safe(error, "protocol_error")); }
  }

  async openSession(configuration: AcpSessionConfiguration, loadSessionId?: string,
    openclawRoute?: NativeOpenClawSessionRoute): Promise<AcpSessionBinding> {
    this.#ensure("ready");
    validateAcpSessionConfiguration(configuration);
    if (loadSessionId !== undefined && !text(loadSessionId)) throw new AcpLifecycleError("invalid_input");
    if (loadSessionId !== undefined && this.#initialization?.agentCapabilities?.loadSession !== true) throw new AcpLifecycleError("unsupported_capability");
    const selected = structuredClone(configuration);
    let metadata: { readonly sessionKey: string; readonly resetSession: false; readonly requireExistingSession: boolean } | undefined;
    if (this.#options.engineId === "openclaw-acp") {
      try { validateNativeOpenClawSessionRoute(openclawRoute); }
      catch { throw new AcpLifecycleError("invalid_input"); }
      metadata = { sessionKey: openclawRoute.sessionKey, resetSession: false, requireExistingSession: openclawRoute.requireExistingSession };
    } else if (openclawRoute !== undefined) throw new AcpLifecycleError("invalid_input");
    this.#settings = new AcpSessionSettings(this.#options.engineId, selected);
    this.#sessionId = loadSessionId;
    this.#state = "binding";
    try {
      const value = await this.#bounded(loadSessionId === undefined
        ? this.#connection.agent.request(methods.agent.session.new, { cwd: selected.cwd, mcpServers: [], ...(metadata ? { _meta: metadata } : {}) })
        : this.#connection.agent.request(methods.agent.session.load, { sessionId: loadSessionId, cwd: selected.cwd, mcpServers: [], ...(metadata ? { _meta: metadata } : {}) }),
      this.#options.requestTimeoutMs ?? 30000, "timeout");
      if (!record(value) || (loadSessionId === undefined && (!("sessionId" in value) || !text(value.sessionId)))) throw new AcpLifecycleError("protocol_error");
      const binding = { sessionId: loadSessionId ?? (value as { sessionId: string }).sessionId, configuration: selected };
      await this.#settings.negotiate((configId, value) => this.#bounded(this.#connection.agent.request(methods.agent.session.setConfigOption,
        { sessionId: binding.sessionId, configId, value }), this.#options.requestTimeoutMs ?? 30000, "timeout"),
      (modeId, confirmed) => this.#bounded(Promise.all([this.#connection.agent.request(methods.agent.session.setMode,
        { sessionId: binding.sessionId, modeId }), confirmed]), this.#options.requestTimeoutMs ?? 30000, "timeout"));
      this.#check();
      await this.#host(() => this.#options.onSessionAccepted(structuredClone(binding), this.#abort.signal));
      this.#binding = binding; this.#bindingReady.resolve();
      await this.#updates; this.#check(); this.#state = "session";
      return structuredClone(binding);
    } catch (error) { throw this.#fail(this.#safe(error, "protocol_error")); }
  }

  async startPrompt(content: readonly ContentBlock[]): Promise<AcpPromptHandle> {
    this.#ensure("session");
    if (!Array.isArray(content) || !content.length) throw new AcpLifecycleError("invalid_input");
    for (const item of content) validateContent(item, this.#initialization?.agentCapabilities?.promptCapabilities);
    const prompt = structuredClone([...content]);
    const active: ActivePrompt = { permissions: new AbortController(), completion: deferred<PromptResponse>(), submitted: false, terminal: false, cancelling: false };
    this.#active = active; this.#state = "prompt";
    try {
      await this.#host(() => this.#options.onPromptSubmitting(structuredClone(this.#binding!), this.#abort.signal));
      this.#check();
      active.timer = setTimeout(() => this.#fail(new AcpLifecycleError("submission_uncertain", this.#outcome())), this.#options.turnTimeoutMs ?? 1800000);
      const response = this.#connection.agent.request(methods.agent.session.prompt, { sessionId: this.#binding!.sessionId, prompt });
      void this.#finishPrompt(active, response);
      return { completed: active.completion.promise, cancel: () => this.#cancel(active) };
    } catch (error) { throw this.#fail(this.#safe(error, "host_commit_failed")); }
  }

  async #finishPrompt(active: ActivePrompt, response: Promise<unknown>): Promise<void> {
    try {
      const result = await this.#abortable(response, this.#abort.signal);
      if (!promptResponse(result)) throw new AcpLifecycleError("protocol_error", this.#outcome());
      active.terminal = true; active.permissions.abort(); this.#retirePermissions(active);
      clearTimeout(active.timer); clearTimeout(active.cancelTimer);
      await this.#hostTerminals.drain();
      await this.#updates; this.#check();
      this.#active = undefined; this.#state = "session";
      active.completion.resolve(structuredClone(result));
    } catch (error) { this.#fail(this.#safe(error, "submission_uncertain")); }
  }

  async #cancel(active: ActivePrompt): Promise<void> {
    this.#check();
    if (this.#active !== active || active.terminal) return;
    if (active.cancelling) return;
    active.cancelling = true; active.permissions.abort(); this.#retirePermissions(active);
    this.#check();
    active.cancelTimer = setTimeout(() => this.#fail(new AcpLifecycleError("submission_uncertain", this.#outcome())), this.#options.cancelTimeoutMs ?? 5000);
    try { await this.#abortable(this.#connection.agent.notify(methods.agent.session.cancel, { sessionId: this.#binding!.sessionId }), this.#abort.signal); }
    catch (error) { throw this.#fail(this.#safe(error, "submission_uncertain")); }
  }

  #receive(message: AnyMessage, responseMethod?: string): void {
    this.#check();
    const active = this.#active;
    const scope = active?.submitted && this.#binding ? {
      sessionId: this.#binding.sessionId, signal: AbortSignal.any([active.permissions.signal, this.#abort.signal]),
      promptRequestId: active.requestId,
      accept: () => this.#acceptPrompt(active),
    } : undefined;
    this.#hostFiles.receive(message, scope);
    this.#hostTerminals.receive(message, scope);
    if ("method" in message && message.method === methods.client.session.requestPermission) {
      if (!("id" in message)) throw new AcpLifecycleError("protocol_error", this.#outcome());
      // Malformed envelopes cannot reach host persistence; the SDK owns their error reply.
      if (permissionEnvelope(message.params)) this.#receivePermission(message.id, message.params);
    }
    if ((responseMethod === methods.agent.session.new || responseMethod === methods.agent.session.load) && "result" in message) {
      this.#settings!.acceptSession(message.result);
      if (responseMethod === methods.agent.session.new) {
        if (!record(message.result) || !text(message.result.sessionId)) throw new AcpLifecycleError("protocol_error");
        if (this.#sessionId && this.#sessionId !== message.result.sessionId) throw new AcpLifecycleError("binding_mismatch");
        this.#sessionId = message.result.sessionId;
      }
    }
    if (responseMethod === methods.agent.session.setConfigOption && "result" in message) this.#settings!.acceptConfiguration(message.result);
    if (responseMethod === methods.agent.session.setMode && "result" in message && !record(message.result)) throw new AcpLifecycleError("protocol_error");
    if (responseMethod === methods.agent.session.prompt && this.#active) {
      if (!this.#active.submitted || !("id" in message) || message.id !== this.#active.requestId) throw new AcpLifecycleError("protocol_error", this.#outcome());
      if ("result" in message && promptResponse(message.result)) {
        try {
          const returned: unknown = this.#options.onPromptResultReceived?.(structuredClone(message.result), this.#abort.signal);
          if (record(returned) && typeof returned.then === "function") {
            void Promise.resolve(returned).catch(() => {});
            throw new AcpLifecycleError("host_commit_failed", this.#outcome());
          }
          this.#check();
        } catch (error) { throw this.#fail(this.#safe(error, "host_commit_failed")); }
        // The OpenClaw bridge can report cancellation before remote chat acceptance.
        if (this.#options.engineId !== "openclaw-acp" || message.result.stopReason !== "cancelled") this.#acceptPrompt(this.#active);
      }
      this.#active.terminal = true; this.#active.permissions.abort(); this.#retirePermissions(this.#active);
    }
    if ("method" in message && message.method === methods.client.session.update) {
      const params = message.params;
      if ("id" in message || !record(params) || !text(params.sessionId) || !record(params.update) || !text(params.update.sessionUpdate)
        || (this.#state !== "binding" && this.#state !== "session" && this.#state !== "prompt")) throw new AcpLifecycleError("protocol_error", this.#outcome());
      if (this.#sessionId && params.sessionId !== this.#sessionId) throw new AcpLifecycleError("binding_mismatch", this.#outcome());
      this.#sessionId ??= params.sessionId;
      if (this.#metadata.receive(params.update)) return;
      if (this.#active?.terminal) throw new AcpLifecycleError("protocol_error", this.#outcome());
      if (this.#settings?.receive(params.update)) return;
      if (this.#active?.submitted) this.#acceptPrompt(this.#active);
      const update: AcpSessionUpdate = { sessionId: params.sessionId, update: structuredClone(params.update) };
      const bytes = Buffer.byteLength(JSON.stringify(update));
      if (++this.#queuedUpdates > 128 || (this.#queuedBytes += bytes) > 16 * 1024 * 1024) throw new AcpLifecycleError("output_limit", this.#outcome());
      if (this.#active?.submitted) {
        try {
          const result: unknown = this.#options.onUpdateReceived?.(structuredClone(update), this.#abort.signal);
          if (record(result) && typeof result.then === "function") {
            void Promise.resolve(result).catch(() => {});
            throw new AcpLifecycleError("host_commit_failed", this.#outcome());
          }
          this.#check();
        } catch (error) { throw this.#fail(this.#safe(error, "host_commit_failed")); }
      }
      this.#updates = this.#updates.then(async () => {
        await this.#abortable(this.#bindingReady.promise, this.#abort.signal); this.#check();
        if (update.sessionId !== this.#binding?.sessionId) throw new AcpLifecycleError("binding_mismatch", this.#outcome());
        await this.#host(() => this.#options.onUpdate(update, this.#abort.signal));
      }).catch(error => { this.#fail(this.#safe(error, "host_commit_failed")); }).finally(() => { this.#queuedUpdates--; this.#queuedBytes -= bytes; });
      this.#options.onLocalLifetime?.(this.#updates);
    }
  }

  #receivePermission(requestId: JsonRpcId, params: RequestPermissionRequest): void {
    const active = this.#active;
    if (!active?.submitted || params.sessionId !== this.#binding?.sessionId) throw new AcpLifecycleError("binding_mismatch", this.#outcome());
    const signal = AbortSignal.any([active.permissions.signal, this.#abort.signal]);
    const snapshot = structuredClone(params);
    this.#permissions.set(requestId, { active, signal, params: snapshot });
    if (signal.aborted) return;
    try {
      this.#acceptPrompt(active);
      const result: unknown = this.#options.onPermissionReceived?.({ requestId, params: structuredClone(snapshot) }, signal);
      if (record(result) && typeof result.then === "function") {
        void Promise.resolve(result).catch(() => {});
        throw new AcpLifecycleError("host_commit_failed", this.#outcome());
      }
      this.#check();
    } catch (error) { throw this.#fail(this.#safe(error, "host_commit_failed")); }
  }

  async #permission(requestId: JsonRpcId, requestSignal: AbortSignal): Promise<RequestPermissionResponse> {
    const cancelled: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
    const permission = this.#permissions.get(requestId);
    if (!permission || permission.active !== this.#active) return cancelled;
    const signal = AbortSignal.any([requestSignal, permission.signal]);
    const snapshot = permission.params;
    this.#permissions.set(requestId, { ...permission, signal });
    if (signal.aborted) return cancelled;
    try {
      const decision = await this.#abortable(Promise.resolve().then(() => {
        if (signal.aborted) return "deny" as const;
        return this.#options.onPermission({ requestId, params: structuredClone(snapshot) }, signal);
      }), signal);
      if (signal.aborted) return cancelled;
      const kind = decision === "approve_once" ? "allow_once" : decision === "deny" ? "reject_once" : undefined;
      const options = kind ? snapshot.options.filter(item => item.kind === kind) : [];
      if (options.length !== 1) return cancelled;
      return { outcome: { outcome: "selected", optionId: options[0]!.optionId } };
    } catch { if (!signal.aborted) this.#fail(new AcpLifecycleError("host_commit_failed", this.#outcome())); return cancelled; }
  }

  #sending(message: AnyMessage): void {
    if (!("method" in message) || message.method !== methods.agent.session.prompt) return;
    const active = this.#active;
    if (!active || active.submitted || !("id" in message) || !this.#binding) throw new AcpLifecycleError("invalid_state", this.#outcome());
    this.#options.assertSubmissionCurrent?.();
    this.#commitPrompt(this.#options.onPromptSending, message.id);
    active.requestId = message.id;
    active.submitted = true;
  }

  #acceptPrompt(active: ActivePrompt): void {
    if (active.accepted) return;
    if (!active.submitted || active.requestId === undefined || !this.#binding) throw new AcpLifecycleError("invalid_state", this.#outcome());
    this.#commitPrompt(this.#options.onPromptAccepted, active.requestId);
    active.accepted = true;
  }

  #commitPrompt(callback: AcpLiveClientOptions["onPromptSending"], requestId: JsonRpcId): void {
    try {
      const result: unknown = callback?.({ requestId, binding: structuredClone(this.#binding!) }, this.#abort.signal);
      if (record(result) && typeof result.then === "function") {
        void Promise.resolve(result).catch(() => {});
        throw new AcpLifecycleError("host_commit_failed", this.#outcome());
      }
      this.#check();
    } catch (error) { throw this.#fail(this.#safe(error, "host_commit_failed")); }
  }

  #beforeWrite(message: AnyMessage): AnyMessage {
    this.#check();
    message = this.#hostFiles.beforeWrite(message);
    message = this.#hostTerminals.beforeWrite(message);
    this.#check();
    if ("id" in message && !("method" in message)) {
      const permission = this.#permissions.get(message.id);
      if (permission) {
        const cancel = (): AnyMessage => {
          this.#transport.retireReply(message.id);
          return { jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } };
        };
        const retired = (): boolean => permission.signal.aborted || permission.active !== this.#active || permission.active.terminal;
        if (retired()) return cancel();
        if (!("result" in message) || !record(message.result) || !record(message.result.outcome)
          || message.result.outcome.outcome !== "selected") return cancel();
        const response = message.result as unknown as RequestPermissionResponse;
        try {
          const result: unknown = this.#options.onPermissionReplySending?.({ requestId: message.id, params: structuredClone(permission.params) },
            structuredClone(response), permission.signal);
          if (record(result) && typeof result.then === "function") {
            void Promise.resolve(result).catch(() => {});
            throw new AcpLifecycleError("host_commit_failed", this.#outcome());
          }
          this.#check();
        } catch (error) { throw this.#fail(this.#safe(error, "host_commit_failed")); }
        if (retired()) return cancel();
      }
    }
    return message;
  }

  #retirePermissions(active: ActivePrompt): void {
    this.#hostFiles.retire();
    this.#hostTerminals.retire();
    for (const [id, permission] of this.#permissions) {
      if (permission.active === active) this.#transport.retireReply(id);
    }
  }

  async #host(operation: () => Promise<void>): Promise<void> {
    try {
      await this.#bounded(Promise.resolve().then(() => { this.#check(); return operation(); }), this.#options.hostTimeoutMs ?? 30000, "host_commit_failed");
      this.#check();
    } catch (error) { throw this.#fail(this.#safe(error, "host_commit_failed")); }
  }
  async #bounded<T>(operation: Promise<T>, duration: number, code: AcpLifecycleError["code"]): Promise<T> {
    const timer = setTimeout(() => this.#fail(new AcpLifecycleError(code, this.#outcome())), duration);
    try { return await this.#abortable(operation, this.#abort.signal); } finally { clearTimeout(timer); }
  }
  async #abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    this.#options.onLocalLifetime?.(operation);
    let abort = (): void => {};
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(this.#failure ?? new AcpLifecycleError("cancelled", this.#outcome()));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    try { return await Promise.race([operation, stopped]); } finally { signal.removeEventListener("abort", abort); }
  }
  #outcome(): AcpLifecycleError["outcome"] { return this.#active?.submitted ? "unknown" : "not_submitted"; }
  #safe(error: unknown, code: AcpLifecycleError["code"]): AcpLifecycleError {
    return error instanceof AcpLifecycleError ? error : new AcpLifecycleError(code, this.#outcome());
  }
  #check(): void { if (this.#failure) throw this.#failure; }
  #ensure(state: ClientState): void { this.#check(); if (this.#state !== state) throw new AcpLifecycleError("invalid_state"); }
  #fail(error: AcpLifecycleError): AcpLifecycleError {
    if (this.#failure) return this.#failure;
    this.#failure = error; this.#abort.abort(); this.#bindingReady.reject(error);
    this.#options.signal.removeEventListener("abort", this.#externalAbort);
    if (this.#active) {
      clearTimeout(this.#active.timer); clearTimeout(this.#active.cancelTimer);
      const active = this.#active;
      active.permissions.abort();
      void this.#hostTerminals.drain().then(() => active.completion.reject(error), cleanupError => active.completion.reject(cleanupError));
    }
    this.#permissions.clear(); this.#transport.close(); this.#hostFiles.clear(); this.#hostTerminals.clear(); this.#connection.close(error);
    return error;
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

function promptResponse(value: unknown): value is PromptResponse {
  return record(value) && ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"].some(reason => reason === value.stopReason);
}

// Preflight only the receipt-time correlation/decision envelope. The SDK parses the full request.
function permissionEnvelope(value: unknown): value is RequestPermissionRequest {
  if (!record(value) || !text(value.sessionId) || !record(value.toolCall) || !text(value.toolCall.toolCallId)
    || !Array.isArray(value.options)) return false;
  return value.options.every(option => record(option) && text(option.optionId) && typeof option.name === "string"
    && ["allow_once", "allow_always", "reject_once", "reject_always"].some(kind => kind === option.kind))
    && new Set(value.options.map(option => option.optionId)).size === value.options.length;
}

function validateContent(value: unknown, capabilities: NonNullable<InitializeResponse["agentCapabilities"]>["promptCapabilities"]): void {
  if (!record(value)) throw new AcpLifecycleError("invalid_input");
  switch (value.type) {
    case "text":
      if (typeof value.text === "string") return;
      break;
    case "resource_link":
      if (text(value.uri) && text(value.name)) return;
      break;
    case "image": case "audio":
      if (capabilities?.[value.type] !== true) throw new AcpLifecycleError("unsupported_capability");
      if (typeof value.data === "string" && text(value.mimeType)) return;
      break;
    case "resource":
      if (capabilities?.embeddedContext !== true) throw new AcpLifecycleError("unsupported_capability");
      if (record(value.resource) && text(value.resource.uri)
        && (typeof value.resource.text === "string" || typeof value.resource.blob === "string")) return;
      break;
  }
  throw new AcpLifecycleError("invalid_input");
}
