import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ContentBlock, PromptResponse } from "@agentclientprotocol/sdk";
import { NativeExecutionJournalError, normalizeOpenClawAgentId, type ApprovalRequest, type NativeExecutionBinding, type NativeExecutionStore, type NativeRunOutput, type NativeSubmissionKey, type RunEventEnvelope, type RunStorePathsFacet } from "@ling-stack/core";
import { materializeNativeArtifacts } from "../adapters/native-artifact-import.js";
import type { NativeSecretRegistry } from "../adapters/native-stream-redaction.js";
import { AcpApprovalJournal, type AcpApprovalPreparer, type AcpPreparedApproval } from "./approval-journal.js";
import { AcpEventNormalizer, type AcpEventNormalizerOptions } from "./event-normalizer.js";
import { AcpLiveClient, type AcpLiveClientOptions, type AcpSessionBinding, type AcpSessionConfiguration,
  type AcpSessionUpdate, type AcpPromptHandle, type AcpPermissionRequest } from "./live-client.js";
import { AcpLifecycleError, record, text } from "./live-errors.js";
import { validateAcpSessionConfiguration } from "./session-settings.js";
import type { AcpHostFileHandlers } from "./host-files.js";
import type { AcpHostHandler } from "./host-requests.js";
import { copyHostTerminalHandlers, type AcpHostTerminalHandlers } from "./host-terminals.js";

export interface AcpActionContext extends AcpApprovalPreparer {
  receive(update: AcpSessionUpdate): void;
  clear(): void;
}
type AcpTarget = { readonly expectedVersion: string } & (
  | { readonly engineId: "kimi-acp"; readonly agentId?: never }
  | { readonly engineId: "openclaw-acp"; readonly agentId: string }
);
export interface AcpHostActionContext {
  readonly store: NativeExecutionStore & RunStorePathsFacet;
  readonly key: NativeSubmissionKey;
  readonly sessionId: string;
  readonly actions: AcpActionContext;
  readonly now: () => string;
  readonly findNativeApproval: (prepared: Extract<AcpPreparedApproval, { kind: "action" }>, saved?: ApprovalRequest) => string | undefined;
  readonly waitForApproval: (approvalId: string, signal: AbortSignal) => Promise<"approve_once" | "deny">;
}
export type AcpHostFileContext = AcpHostActionContext;
export interface AcpJournaledLifecycleOptions {
  readonly store: NativeExecutionStore & RunStorePathsFacet;
  readonly key: NativeSubmissionKey;
  readonly target: AcpTarget;
  readonly configuration: AcpSessionConfiguration;
  /** Trusted runtime target factory, never a renderer/native callback. */
  readonly createActions: (binding: AcpSessionBinding) => AcpActionContext;
  readonly createHostFiles?: { readonly [K in keyof AcpHostFileHandlers]?: (context: AcpHostFileContext) => NonNullable<AcpHostFileHandlers[K]> };
  readonly createHostTerminals?: (context: AcpHostActionContext) => AcpHostTerminalHandlers;
  readonly output: AcpEventNormalizerOptions;
  /** Host-local live dependency; intentionally separate from the cloned output options. */
  readonly secretRegistry?: NativeSecretRegistry;
  /** Synchronous host-owned profile/secret/source fence before durable or delegated work. */
  readonly assertCurrent?: () => void;
  readonly onEvent: (event: RunEventEnvelope) => void;
  readonly onApprovalWaitChanged?: (waiting: boolean) => void;
  /** Host-owned asynchronous fence immediately before terminal output is committed. */
  readonly assertResultCurrent?: () => void | Promise<void>;
  readonly approvalPollIntervalMs?: number;
  readonly now?: () => string;
  readonly client: Pick<AcpLiveClientOptions, "input" | "output" | "signal" | "requestTimeoutMs" | "turnTimeoutMs"
    | "hostTimeoutMs" | "cancelTimeoutMs" | "writeTimeoutMs" | "frameBytes" | "onLocalLifetime" | "assertSubmissionCurrent">;
}

/** One reserved Attempt and one ACP prompt; owns durable lifecycle, not target process launch. */
export class AcpJournaledLifecycle {
  readonly #options: AcpJournaledLifecycleOptions;
  readonly #client: AcpLiveClient;
  readonly #binding: NativeExecutionBinding;
  readonly #now: () => string;
  readonly #interval: number;
  readonly #delivered = new Set<string>();
  readonly #received = new Map<string | number, string | undefined>();
  readonly #waitTasks = new Set<Promise<"approve_once" | "deny">>();
  #actions?: AcpActionContext;
  #approvals?: AcpApprovalJournal;
  #normalizer?: AcpEventNormalizer;
  #promptId?: string | number;
  #sequence = 1;
  #opening = false;
  #opened = false;
  #started = false;
  #waiting = 0;
  #terminal?: PromptResponse;
  #terminalVerified = false;
  #closing = false;
  #closingSettlement?: Promise<void>;

  constructor(options: AcpJournaledLifecycleOptions) {
    this.#options = { ...options, key: structuredClone(options.key), target: structuredClone(options.target),
      configuration: structuredClone(options.configuration), output: structuredClone(options.output) };
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#interval = options.approvalPollIntervalMs ?? 250;
    if (!Number.isSafeInteger(this.#interval) || this.#interval < 1 || this.#interval > 1000) throw new AcpLifecycleError("invalid_input");
    options.assertCurrent?.();
    const current = options.store.getNativeSubmission(options.key.submissionId);
    if (!current || current.status !== "reserved") throw new AcpLifecycleError("invalid_state");
    const binding = options.store.getNativeExecutionBinding(current.bindingId);
    if (!binding || binding.selection.engineId !== options.target.engineId
      || resolve(binding.cwd) !== resolve(options.configuration.cwd)
      || binding.selection.configurationFingerprint !== acpConfigurationFingerprint(options.target, options.configuration)) throw new AcpLifecycleError("binding_mismatch");
    if (binding.selection.modelId !== options.configuration.modelId) throw new AcpLifecycleError("binding_mismatch");
    this.#binding = structuredClone(binding);
    let hostFiles: AcpHostFileHandlers = {};
    const terminalFactory = options.createHostTerminals;
    if (terminalFactory !== undefined && typeof terminalFactory !== "function") throw new AcpLifecycleError("invalid_input");
    let hostTerminals: AcpHostTerminalHandlers | undefined;
    const terminals = (): AcpHostTerminalHandlers => {
      if (!hostTerminals) throw new AcpLifecycleError("invalid_state");
      return hostTerminals;
    };
    this.#client = new AcpLiveClient({ ...options.client, ...options.target,
      hostTerminals: terminalFactory ? {
        create: deferredHostHandler(() => terminals().create, options.assertCurrent),
        output: deferredHostHandler(() => terminals().output, options.assertCurrent),
        waitForExit: deferredHostHandler(() => terminals().waitForExit, options.assertCurrent),
        kill: deferredHostHandler(() => terminals().kill, options.assertCurrent),
        release: deferredHostHandler(() => terminals().release, options.assertCurrent),
        dispose: id => terminals().dispose(id),
      } : undefined,
      hostFiles: {
        ...(options.createHostFiles?.readTextFile ? { readTextFile: deferredHostHandler(() => hostFiles.readTextFile!, options.assertCurrent) } : {}),
        ...(options.createHostFiles?.writeTextFile ? { writeTextFile: deferredHostHandler(() => hostFiles.writeTextFile!, options.assertCurrent) } : {}),
      },
      onSessionAccepted: async (accepted, signal) => {
        signal.throwIfAborted();
        options.assertCurrent?.();
        options.store.bindNativeExecutionSession({ ...this.#options.key, nativeSessionId: accepted.sessionId }, this.#now());
        this.#actions = options.createActions(structuredClone(accepted));
        this.#approvals = new AcpApprovalJournal(options.store, this.#options.key, this.#actions, this.#now);
        this.#normalizer = new AcpEventNormalizer(accepted.sessionId, this.#options.output, this.#options.secretRegistry);
        const context: AcpHostActionContext = { store: options.store, key: structuredClone(this.#options.key),
          sessionId: accepted.sessionId, actions: this.#actions, now: this.#now,
          findNativeApproval: (prepared, saved) => this.#approvals!.findForHost(prepared, saved),
          waitForApproval: (id, waitSignal) => this.#trackWait(this.#waitSaved(id, waitSignal)) };
        hostFiles = { readTextFile: options.createHostFiles?.readTextFile?.(context),
          writeTextFile: options.createHostFiles?.writeTextFile?.(context) };
        if (terminalFactory) hostTerminals = copyHostTerminalHandlers(terminalFactory(context));
      },
      onPromptSubmitting: async () => { options.assertCurrent?.(); },
      onPromptSending: (value, signal) => {
        signal.throwIfAborted();
        options.assertCurrent?.();
        if (value.requestId === null) throw new AcpLifecycleError("protocol_error");
        options.store.beginNativeSubmission({ ...this.#options.key, nativePromptRequestId: value.requestId }, this.#now());
        this.#promptId = value.requestId;
      },
      onPromptAccepted: (value, signal) => {
        signal.throwIfAborted();
        options.assertCurrent?.();
        if (value.requestId === null) throw new AcpLifecycleError("protocol_error");
        options.store.acceptNativeSubmission({ ...this.#options.key, nativePromptRequestId: value.requestId }, this.#now());
        this.#save([{ type: "turn_start", data: {} }], signal);
      },
      onPromptResultReceived: result => {
        options.assertCurrent?.();
        this.#terminal = { stopReason: result.stopReason };
        this.#terminalVerified = !options.assertResultCurrent;
      },
      onUpdateReceived: update => { options.assertCurrent?.(); this.#actions!.receive(update); },
      onUpdate: async (update, signal) => {
        options.assertCurrent?.();
        if (this.#promptId === undefined) return; // Load replay cannot be appended to the new Attempt.
        const events = this.#normalizer!.receive(update);
        if (events.length) {
          const imported = await materializeNativeArtifacts(events, { directory: options.store.paths.artifactsDir,
            submissionId: this.#options.key.submissionId, signal, extraSecrets: this.#options.output.extraSecrets,
            secretRegistry: this.#options.secretRegistry });
          signal.throwIfAborted();
          options.assertCurrent?.();
          this.#save(imported.events, signal, undefined, imported.artifacts);
        }
      },
      onPermissionReceived: (request, signal) => {
        options.assertCurrent?.();
        if (request.requestId === null) throw new AcpLifecycleError("protocol_error");
        const prepared = this.#actions!.prepare(request);
        const approval = prepared.kind === "action" && prepared.policyDecision.decision !== "deny"
          ? this.#approvals!.create(request, signal) : undefined;
        this.#received.set(request.requestId, approval?.id);
      },
      onPermission: (request, signal) => {
        options.assertCurrent?.();
        return this.#trackWait(this.#wait(request, signal));
      },
      onPermissionReplySending: (request, response) => { options.assertCurrent?.(); this.#approvals!.beforeWrite(request, response); },
      onPermissionReplyOutcome: observation => {
        options.assertCurrent?.();
        this.#approvals?.observe(observation);
        if (observation.requestId !== null && this.#received.has(observation.requestId)) this.#synchronize();
      },
    });
  }

  get closed(): Promise<void> { return this.#client.closed.finally(() => this.#closingSettlement).finally(() => this.#drainWaits()); }

  async open(): Promise<void> {
    if (this.#opening) throw new AcpLifecycleError("invalid_state");
    this.#opening = true;
    try {
      const submission = this.#options.store.getNativeSubmission(this.#options.key.submissionId)!;
      const reserved = this.#options.store.reserveNativeExecution({ runId: submission.runId, fence: this.#options.key.fence,
        selection: this.#binding.selection, generation: this.#binding.generation }, this.#now());
      if (reserved.submission.id !== submission.id || reserved.submission.status !== "reserved") throw new AcpLifecycleError("invalid_state");
      const route = this.#options.target.engineId === "openclaw-acp"
        ? this.#options.store.prepareNativeOpenClawSession({ ...this.#options.key, agentId: this.#options.target.agentId }, this.#now()) : undefined;
      await this.#client.initialize();
      this.#options.assertCurrent?.();
      if (this.#options.target.engineId === "openclaw-acp") {
        this.#options.store.prepareNativeOpenClawSession({ ...this.#options.key, agentId: this.#options.target.agentId }, this.#now());
        if (this.#options.store.getNativeExecutionBinding(this.#binding.id)?.nativeSessionId !== this.#binding.nativeSessionId) {
          throw new AcpLifecycleError("binding_mismatch");
        }
      }
      await this.#client.openSession(this.#options.configuration, this.#binding.nativeSessionId, route);
      this.#opened = true;
    } catch (error) { this.#client.close(); this.#failure(); throw error; }
  }

  async startPrompt(input: readonly ContentBlock[]): Promise<AcpPromptHandle> {
    if (!this.#opened || this.#started) throw new AcpLifecycleError("invalid_state");
    this.#started = true;
    try {
      const handle = await this.#client.startPrompt(input);
      const completed = handle.completed.then(async result => {
        try {
          await this.#drainWaits();
          if (this.#options.target.engineId === "openclaw-acp" && result.stopReason === "cancelled") {
            throw new AcpLifecycleError("submission_uncertain", "unknown");
          }
          try {
            await this.#options.assertResultCurrent?.();
            this.#options.assertCurrent?.();
            if (this.#closing) throw new AcpLifecycleError("invalid_state");
            this.#terminalVerified = true;
          }
          catch (error) { this.#terminal = undefined; throw error; }
          this.#synchronize();
          const usage = this.#client.sessionMetadata.usage;
          const events: NativeRunOutput[] = usage
            ? [{ type: "progress", data: { nativeKind: "session_usage", scope: "session", ...usage } }] : [];
          this.#save([...events, ...this.#normalizer!.finish(result)], this.#options.client.signal, outcome(result));
          this.#clear();
          return result;
        } catch (error) { await this.#settlePromptFailure(); throw error; }
      }, async error => {
        try { await this.#settlePromptFailure(); } finally { await this.#drainWaits(); }
        throw error;
      });
      void completed.catch(() => {});
      return { completed, cancel: () => handle.cancel() };
    } catch (error) { this.#client.close(); this.#failure(); throw error; }
  }

  close(): void {
    this.#closing = true;
    this.#client.close();
    if (this.#options.createHostTerminals) {
      // Disposal must journal observed terminal exits before the submission loses authority.
      this.#closingSettlement ??= this.#client.closed.finally(() => this.#failure());
      void this.#closingSettlement.catch(() => {});
    } else this.#failure();
  }

  async #wait(request: AcpPermissionRequest, signal: AbortSignal): Promise<"approve_once" | "deny"> {
    signal.throwIfAborted();
    if (request.requestId === null) throw new AcpLifecycleError("protocol_error");
    const approvalId = this.#received.get(request.requestId);
    if (!approvalId) return "deny";
    if (this.#approvals!.create(request, signal).id !== approvalId) throw new AcpLifecycleError("host_commit_failed");
    return this.#waitSaved(approvalId, signal);
  }

  #trackWait(task: Promise<"approve_once" | "deny">): Promise<"approve_once" | "deny"> {
    this.#waitTasks.add(task);
    void task.then(() => this.#waitTasks.delete(task), () => this.#waitTasks.delete(task));
    return task;
  }

  async #waitSaved(approvalId: string, signal: AbortSignal): Promise<"approve_once" | "deny"> {
    signal.throwIfAborted();
    const current = this.#synchronize().approvals.find(item => item.approval.id === approvalId);
    if (!current || current.correlation.resolvedAt) throw new AcpLifecycleError("host_commit_failed");
    if (current.approval.status === "approved") return "approve_once";
    if (current.approval.status === "denied") return "deny";
    if (current.approval.status !== "pending") throw new AcpLifecycleError("host_commit_failed");
    this.#waiting++;
    try {
      if (this.#waiting === 1) this.#options.onApprovalWaitChanged?.(true);
      for (;;) {
        signal.throwIfAborted();
        const snapshot = this.#synchronize();
        signal.throwIfAborted();
        const record = snapshot.approvals.find(item => item.approval.id === approvalId);
        if (!record || record.correlation.resolvedAt) throw new AcpLifecycleError("host_commit_failed");
        if (record.approval.status === "approved") return "approve_once";
        if (record.approval.status === "denied") return "deny";
        if (record.approval.status !== "pending") throw new AcpLifecycleError("host_commit_failed");
        const remaining = Date.parse(record.approval.expiresAt!) - Date.parse(this.#now());
        if (!Number.isFinite(remaining)) throw new AcpLifecycleError("host_commit_failed");
        await delay(Math.max(1, Math.min(this.#interval, remaining)), undefined, { signal });
      }
    } finally {
      this.#waiting--;
      if (this.#waiting === 0) this.#options.onApprovalWaitChanged?.(false);
    }
  }

  #synchronize() {
    this.#options.assertCurrent?.();
    const snapshot = this.#options.store.synchronizeNativeApprovalWait(this.#options.key, this.#now());
    for (const event of snapshot.events) this.#publish(event);
    return snapshot;
  }

  #save(events: readonly NativeRunOutput[], signal: AbortSignal, terminal?: "completed" | "cancelled",
    artifacts?: Parameters<NativeExecutionStore["appendNativeRunEvents"]>[0]["artifacts"]): void {
    signal.throwIfAborted();
    this.#options.assertCurrent?.();
    const saved = this.#options.store.appendNativeRunEvents({ ...this.#options.key,
      nativeSessionId: this.#normalizer!.sessionId, nativePromptRequestId: this.#promptId!, firstSequence: this.#sequence,
      events, artifacts, terminal, extraSecrets: this.#options.secretRegistry?.getSnapshot() ?? this.#options.output.extraSecrets }, this.#now());
    this.#sequence += saved.events.length;
    if (saved.created) for (const event of saved.events) { signal.throwIfAborted(); this.#publish(event); }
  }

  #publish(event: RunEventEnvelope): void {
    if (this.#delivered.has(event.id)) return;
    this.#delivered.add(event.id);
    const returned: unknown = this.#options.onEvent(structuredClone(event));
    if (record(returned) && typeof returned.then === "function") {
      void Promise.resolve(returned).catch(() => {});
      throw new AcpLifecycleError("host_commit_failed");
    }
  }

  #clear(): void { this.#approvals?.clear(); this.#actions?.clear(); this.#received.clear(); }

  async #drainWaits(): Promise<void> { await Promise.allSettled([...this.#waitTasks]); }

  async #settlePromptFailure(): Promise<void> {
    if (this.#closingSettlement) await this.#closingSettlement;
    else this.#failure();
  }

  #failure(): void {
    try {
      const current = this.#options.store.getNativeSubmission(this.#options.key.submissionId);
      if (!current || !["reserved", "submission_pending", "accepted"].includes(current.status)) return;
      if (this.#terminal) {
        // Close cannot trust a result whose asynchronous host fence is still pending.
        if (!this.#terminalVerified) this.#terminal = undefined;
        else {
          try { this.#options.assertCurrent?.(); }
          catch { this.#terminal = undefined; }
        }
      }
      if (this.#terminal && current.status === "accepted"
        && (this.#options.target.engineId !== "openclaw-acp" || this.#terminal.stopReason !== "cancelled")) {
        try {
          this.#options.store.finishNativeSubmission({ ...this.#options.key, outcome: outcome(this.#terminal) }, this.#now());
        } catch (error) {
          if (!(error instanceof NativeExecutionJournalError) || error.code !== "native_host_effect_unresolved") throw error;
          this.#options.store.markNativeSubmissionUnknown(this.#options.key, this.#now());
        }
      } else if (current.status === "reserved") this.#options.store.finishNativeSubmission({ ...this.#options.key, outcome: "not_submitted" }, this.#now());
      else this.#options.store.markNativeSubmissionUnknown(this.#options.key, this.#now());
    } finally { this.#clear(); }
  }
}

function deferredHostHandler<P, R>(get: () => AcpHostHandler<P, R>, assertCurrent?: () => void): AcpHostHandler<P, R> {
  return { receive: (request, signal) => { assertCurrent?.(); return get().receive(request, signal); },
    execute: (request, signal) => { assertCurrent?.(); return get().execute(request, signal); },
    beforeReply: (request, signal) => { assertCurrent?.(); return get().beforeReply(request, signal); },
    beforeErrorReply: (request, code, signal) => { assertCurrent?.(); return get().beforeErrorReply?.(request, code, signal); },
    onReplyOutcome: observation => { assertCurrent?.(); return get().onReplyOutcome(observation); } };
}

function outcome(result: PromptResponse): "completed" | "cancelled" { return result.stopReason === "cancelled" ? "cancelled" : "completed"; }

export function acpConfigurationFingerprint(target: AcpTarget, configuration: AcpSessionConfiguration): string {
  validateAcpSessionConfiguration(configuration);
  if (!["kimi-acp", "openclaw-acp"].includes(target.engineId) || !text(target.expectedVersion) || !text(configuration.cwd)) throw new AcpLifecycleError("invalid_input");
  let agentId: string | undefined;
  if (target.engineId === "openclaw-acp") {
    try { agentId = normalizeOpenClawAgentId(target.agentId); }
    catch { throw new AcpLifecycleError("invalid_input"); }
  } else if (target.agentId !== undefined) throw new AcpLifecycleError("invalid_input");
  return createHash("sha256").update(JSON.stringify({ engineId: target.engineId, expectedVersion: target.expectedVersion, agentId,
    cwd: configuration.cwd, modelId: configuration.modelId, modeId: configuration.modeId, thoughtLevel: configuration.thoughtLevel })).digest("hex");
}
