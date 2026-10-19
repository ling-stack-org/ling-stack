import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { NativeExecutionStore, NativeSubmissionKey, NativeExecutionBinding, NativeRunOutput, RunEventEnvelope, RunStorePathsFacet } from "@ling-stack/core";
import { materializeNativeArtifacts } from "../native-artifact-import.js";
import { NativeArtifactError } from "../native-artifact-files.js";
import { CodexApprovalJournal, type CodexCreateApproval } from "./approval-journal.js";
import { CodexActionPreparer, type CodexApprovalPolicyContext, type CodexPreparedAction } from "./action-preparation.js";
import { CodexFileChangeContext } from "./file-change-context.js";
import { CodexApprovalWait, type CodexApprovalWaitOptions } from "./approval-wait.js";
import { CodexEventNormalizer, type CodexEventNormalizerOptions } from "./event-normalizer.js";
import type { CodexRequest } from "./duplex.js";
import { CodexLifecycleError, CodexLiveClient, type CodexLiveClientOptions,
  type CodexThreadConfiguration, type CodexTurnInput, type CodexTurnHandle } from "./live-client.js";

export interface CodexJournaledLifecycleOptions {
  readonly store: NativeExecutionStore & RunStorePathsFacet;
  readonly key: NativeSubmissionKey;
  readonly configuration: CodexThreadConfiguration;
  readonly approvalPolicy: CodexApprovalPolicyContext;
  readonly now?: () => string;
  readonly approvalWait?: CodexApprovalWaitOptions;
  readonly output?: Omit<CodexEventNormalizerOptions, "threadId" | "turnId"> & {
    readonly onEvent: (event: RunEventEnvelope, signal: AbortSignal) => void | Promise<void>;
  };
  readonly client: Omit<CodexLiveClientOptions, "onThreadAccepted" | "onTurnSubmitting" | "onTurnAccepted" | "onRequest" | "onReplySending"> & {
    readonly onRequest: (request: CodexRequest, signal: AbortSignal, createApproval: CodexCreateApproval, prepared: CodexPreparedAction) => Promise<unknown>;
  };
}

/** One reserved Ling Attempt and one native turn. The adapter still owns preflight, tools and child cleanup. */
export class CodexJournaledLifecycle {
  readonly #client: CodexLiveClient;
  readonly #store: NativeExecutionStore;
  readonly #key: NativeSubmissionKey;
  readonly #binding: NativeExecutionBinding;
  readonly #configuration: CodexThreadConfiguration;
  readonly #now: () => string;
  readonly #approvals: CodexApprovalJournal;
  readonly #files = new CodexFileChangeContext();
  readonly #wait?: CodexApprovalWait;
  #output?: { normalizer: CodexEventNormalizer; threadId: string; turnId: string; nextSequence: number };
  #opening = false;
  #opened = false;
  #turnStarted = false;

  constructor(options: CodexJournaledLifecycleOptions) {
    this.#store = options.store;
    this.#key = structuredClone(options.key);
    this.#configuration = structuredClone(options.configuration);
    this.#now = options.now ?? (() => new Date().toISOString());
    const actions = new CodexActionPreparer(this.#configuration.cwd, options.approvalPolicy, this.#files);
    this.#approvals = new CodexApprovalJournal(this.#store, this.#key, this.#now, actions);
    const current = this.#store.getNativeSubmission(this.#key.submissionId);
    if (!current || current.status !== "reserved") throw new CodexLifecycleError("invalid_state");
    const binding = this.#store.getNativeExecutionBinding(current.bindingId);
    if (!binding || resolve(binding.cwd) !== resolve(this.#configuration.cwd)
      || binding.selection.engineId !== "codex-app-server" || binding.selection.modelId !== this.#configuration.model
      || binding.selection.configurationFingerprint !== codexConfigurationFingerprint(this.#configuration)) {
      throw new CodexLifecycleError("binding_mismatch");
    }
    this.#binding = binding;
    if (options.approvalWait) this.#wait = new CodexApprovalWait(this.#store, this.#key, this.#now, {
      ...options.approvalWait,
      onWaitChanged: waiting => {
        this.#client.setApprovalWaiting(waiting);
        options.approvalWait?.onWaitChanged?.(waiting);
      },
    });
    this.#client = new CodexLiveClient({ ...options.client,
      limits: { ...(options.output ? { frameBytes: 36 * 1024 * 1024, notificationBytes: 128 * 1024 * 1024 } : {}), ...options.client.limits },
      onNotificationReceived: event => {
        this.#files.receive(event);
        options.client.onNotificationReceived?.(event);
      },
      onRequest: async (request, signal) => {
        let creating = true;
        const prepared = actions.prepare(request);
        try {
          const createApproval: CodexCreateApproval = approvalOptions => {
            if (!creating) throw new CodexLifecycleError("invalid_state", "accepted");
            return this.#approvals.create(request, prepared, signal, approvalOptions);
          };
          return this.#wait?.handles(request.method)
            ? await this.#wait.handle(request, signal, createApproval, prepared)
            : await options.client.onRequest(structuredClone(request), signal, createApproval, structuredClone(prepared));
        } finally { creating = false; }
      },
      onReplySending: (request, result) => this.#approvals.beforeWrite(request, result),
      onReplyOutcome: observation => {
        this.#approvals.observe(observation);
        options.client.onReplyOutcome?.(observation);
      },
      onThreadAccepted: async (accepted, signal) => {
        signal.throwIfAborted();
        actions.bindThreadEnvironment(accepted);
        this.#store.bindNativeExecutionSession({ ...this.#key, nativeSessionId: accepted.threadId }, this.#now());
      },
      onTurnSubmitting: async (_binding, signal) => {
        signal.throwIfAborted();
        this.#store.beginNativeSubmission(this.#key, this.#now());
      },
      onTurnAccepted: async (accepted, signal) => {
        signal.throwIfAborted();
        this.#store.acceptNativeSubmission({ ...this.#key, nativeTurnId: accepted.turnId }, this.#now());
        if (options.output) this.#output = { ...accepted, nextSequence: 1,
          normalizer: new CodexEventNormalizer({ maxBytes: 128 * 1024 * 1024, ...options.output, threadId: accepted.threadId, turnId: accepted.turnId }) };
      },
      onEvent: async (event, signal) => {
        const terminal = event.method === "turn/completed"
          ? (event.params as { turn: { status: "completed" | "interrupted" | "failed" } }).turn.status : undefined;
        const outcome = terminal === "interrupted" ? "cancelled" : terminal;
        if (this.#output && options.output && event.method !== "serverRequest/resolved") {
          let events: NativeRunOutput[];
          try { events = this.#output.normalizer.receive(event); }
          catch (error) {
            // Keep known native terminal evidence even if its output is incompatible with the workflow.
            if (outcome) this.#store.finishNativeSubmission({ ...this.#key, outcome }, this.#now());
            throw error;
          }
          if (events.length) {
            let imported;
            try {
              imported = await materializeNativeArtifacts(events, { directory: options.store.paths.artifactsDir,
                submissionId: this.#key.submissionId, signal, extraSecrets: options.output.extraSecrets });
            } catch (error) {
              if (outcome && error instanceof NativeArtifactError && error.code !== "artifact_conflict") {
                this.#store.finishNativeSubmission({ ...this.#key, outcome }, this.#now());
              }
              throw error;
            }
            signal.throwIfAborted();
            const saved = this.#store.appendNativeRunEvents({ ...this.#key,
              nativeSessionId: this.#output.threadId, nativeTurnId: this.#output.turnId,
              firstSequence: this.#output.nextSequence, ...imported, terminal: outcome, extraSecrets: options.output.extraSecrets }, this.#now());
            this.#output.nextSequence += saved.events.length;
            if (saved.created) for (const envelope of saved.events) {
              signal.throwIfAborted();
              await options.output.onEvent(structuredClone(envelope), signal);
            }
          }
        }
        if (event.method === "turn/completed") {
          // The live client validates the thread, turn and terminal status before this callback.
          const { turn } = event.params as { turn: { status: "completed" | "interrupted" | "failed" } };
          if (!this.#output) this.#store.finishNativeSubmission({ ...this.#key, outcome: turn.status === "interrupted" ? "cancelled" : turn.status }, this.#now());
          this.#approvals.clear();
          this.#files.clear();
          this.#wait?.synchronize();
        } else if (event.method === "serverRequest/resolved") {
          this.#approvals.resolve((event.params as { requestId: string | number }).requestId);
          this.#wait?.synchronize();
        }
        await options.client.onEvent(event, signal);
      },
    });
  }

  async open(): Promise<void> {
    if (this.#opening) throw new CodexLifecycleError("invalid_state");
    this.#opening = true;
    try {
      const submission = this.#store.getNativeSubmission(this.#key.submissionId)!;
      const reserved = this.#store.reserveNativeExecution({ runId: submission.runId, fence: this.#key.fence,
        selection: this.#binding.selection, generation: this.#binding.generation }, this.#now());
      if (reserved.submission.id !== this.#key.submissionId || reserved.submission.status !== "reserved") throw new CodexLifecycleError("invalid_state");
      await this.#client.initialize();
      await this.#client.openThread(this.#configuration, this.#binding.nativeSessionId);
      this.#opened = true;
    } catch (error) { this.#client.close(); this.recordFailure(error); throw error; }
  }

  async startTurn(input: CodexTurnInput): Promise<CodexTurnHandle> {
    if (!this.#opened || this.#turnStarted) throw new CodexLifecycleError("invalid_state");
    this.#turnStarted = true;
    try {
      const handle = await this.#client.startTurn(input);
      const completed = handle.completed.catch(error => { this.recordFailure(error); throw error; });
      // A caller can be cancelled between receiving the handle and attaching its await.
      void completed.catch(() => {});
      return { ...handle, completed };
    } catch (error) { this.#client.close(); this.recordFailure(error); throw error; }
  }

  close(): void {
    this.#client.close();
    if (!this.#turnStarted) this.recordFailure(new CodexLifecycleError("connection_lost"));
  }

  private recordFailure(error: unknown): void {
    const current = this.#store.getNativeSubmission(this.#key.submissionId);
    if (!current || !["reserved", "submission_pending", "accepted"].includes(current.status)) return;
    const outcome = error instanceof CodexLifecycleError ? error.outcome : "unknown";
    try {
      if (current.status === "reserved" || (current.status === "submission_pending" && outcome === "not_submitted")) {
        this.#store.finishNativeSubmission({ ...this.#key, outcome: error instanceof CodexLifecycleError && error.code === "submission_rejected"
          && current.status === "submission_pending" ? "rejected" : "not_submitted" }, this.#now());
      } else this.#store.markNativeSubmissionUnknown(this.#key, this.#now());
      this.#approvals.clear();
      this.#files.clear();
    } catch {
      // Leave the durable reservation unresolved if its Attempt was replaced or storage failed.
      throw new CodexLifecycleError("host_commit_failed", current.status === "accepted" ? "accepted" : outcome);
    }
  }
}

export function codexConfigurationFingerprint(configuration: CodexThreadConfiguration): string {
  const canonical = JSON.stringify(configuration, (_key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const object = value as Record<string, unknown>;
      return Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]]));
    }
    return value;
  });
  return createHash("sha256").update(canonical).digest("hex");
}
