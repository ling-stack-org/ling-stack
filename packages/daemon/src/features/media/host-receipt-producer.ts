import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { digestHarnessToolValue, type HostMediaExecutionTicket, type HostMediaProtocol,
  type HostMediaReceiptIdentity, type MediaJob, type MediaWorkflowOutputRule, type RunStore, type RuntimeAttemptFenceV1 } from "@ling-stack/core";
import type { MediaExecutionHandle } from "@ling-stack/providers";
import type { AttemptHostOperationHandle, AttemptHostOperationTracker } from "../../runtime/attempt-host-operation-tracker.js";
import { MediaLocalExecutionAdmissionError, type MediaLocalExecutionHandle } from "../../runtime/media-local-executions.js";
import type { HostMediaArtifactCollectionContext, MediaArtifactCollectionResult } from "./artifact-collection-receipt.js";
import { assertHostMediaNativeTransport, type HostMediaHttpExchange, type HostMediaNativeTransport,
  type HostMediaWireRequest } from "./native-http-transport.js";
import { createMediaNativeObservationPlan, createMediaNativeRemoteDescriptorMatcher,
  decodeMediaNativeSubmission, decodeMediaNativeTerminal } from "./native-receipt-observations.js";

export interface HostMediaReceiptPreparation {
  readonly store: RunStore;
  readonly job: MediaJob;
  readonly localExecution: MediaLocalExecutionHandle;
  readonly childFence: RuntimeAttemptFenceV1;
  readonly protocol: HostMediaProtocol;
  readonly adapterId: string;
  readonly baseUrl: string;
  readonly outputRules?: readonly MediaWorkflowOutputRule[];
  readonly secretValues?: readonly (string | undefined)[];
}

type OriginalReceiptWrite =
  | { readonly kind: "response" | "no_start"; readonly artifactId: string; readonly effectId: string }
  | { readonly kind: "terminal" | "manifest" | "finalization"; readonly artifactId: string };

/** A single original generation owns its transport facts and private Core ticket across all ticks. */
export class HostMediaReceiptProducer {
  readonly #input: HostMediaReceiptPreparation;
  readonly #tracker: AttemptHostOperationTracker;
  readonly #parent: AttemptHostOperationHandle;
  readonly #transport: AttemptHostOperationHandle;
  readonly #ticket: HostMediaExecutionTicket;
  readonly #identity: HostMediaReceiptIdentity;
  readonly #plan: ReturnType<typeof createMediaNativeObservationPlan>;
  readonly #matcher: ReturnType<typeof createMediaNativeRemoteDescriptorMatcher>;
  readonly #effects = new Map<HostMediaWireRequest, { readonly id: string; readonly kind: string }>();
  #submission?: { readonly artifactId: string; readonly externalOperationId: string };
  #terminal?: ReturnType<typeof decodeMediaNativeTerminal>;
  #manifestArtifactId?: string;
  #sendEntered = false;
  #finished = false;

  constructor(input: HostMediaReceiptPreparation, tracker: AttemptHostOperationTracker,
    parent: AttemptHostOperationHandle, transport: AttemptHostOperationHandle) {
    this.#input = { ...input, childFence: Object.freeze({ ...input.childFence }),
      secretValues: Object.freeze([...(input.secretValues ?? [])]) };
    this.#tracker = tracker; this.#parent = parent; this.#transport = transport;
    this.#plan = createMediaNativeObservationPlan({ protocol: input.protocol, adapterId: input.adapterId,
      baseUrl: input.baseUrl, outputRules: input.outputRules });
    this.#matcher = createMediaNativeRemoteDescriptorMatcher(this.#plan, this.#input.secretValues);
    const child = input.store.getWorkUnit(input.childFence.workUnitId);
    const request = isRecord(child?.request) ? child.request : undefined;
    const admission = isRecord(request) && isRecord(request.executionAdmission) ? request.executionAdmission : undefined;
    if (!admission || admission.schemaVersion !== 1 || !isDeepStrictEqual(admission.source, tracker.source)
      || typeof admission.requestDigest !== "string" || request?.toolCallId !== parent.toolCallId
      || input.localExecution.mediaJobId !== input.job.id || child?.linkedMediaJobId !== input.job.id) {
      throw new Error("media_receipt_preparation_binding_invalid");
    }
    const executionId = `media_execution_${randomUUID()}`;
    const prepared = { schemaVersion: 1 as const, executionId, mediaJobId: input.job.id,
      mediaChildWorkUnitId: input.childFence.workUnitId, executionGenerationId: input.localExecution.generation,
      source: tracker.source, toolCallId: parent.toolCallId, protocol: input.protocol, adapterId: input.adapterId,
      toolName: input.job.operation === "video_generate" ? "video_generate" as const : "image_generate" as const,
      operation: input.job.operation, intentDigest: admission.requestDigest,
      targetDigest: digestHarnessToolValue(request?.target), namespaceDigest: this.#plan.namespaceDigest };
    const artifact = this.#seal("prepared", prepared);
    if (!artifact.contentSha256) throw new Error("media_receipt_preparation_seal_missing");
    const { schemaVersion: _schema, source: _source, toolCallId: _call, ...intent } = prepared;
    this.#ticket = tracker.prepareMediaExecution(parent, transport, { ...intent,
      preparedRequestArtifactId: artifact.id, preparedRequestDigest: artifact.contentSha256, preparedAt: now() });
    const row = tracker.bindMediaChildExecution(this.#ticket, this.#input.childFence);
    this.#identity = Object.freeze({ schemaVersion: 1, executionId, executionIdentityDigest: row.identityDigest,
      mediaJobId: row.mediaJobId, executionGenerationId: row.executionGenerationId, source: row.source,
      childFence: this.#input.childFence, namespaceDigest: row.namespaceDigest, protocol: row.protocol });
  }

  assertPreparation(input: HostMediaReceiptPreparation): void {
    this.#assertOpen();
    if (input.store !== this.#input.store || input.localExecution !== this.#input.localExecution
      || input.job.id !== this.#input.job.id || input.protocol !== this.#plan.protocol
      || input.adapterId !== this.#plan.adapterId || !isDeepStrictEqual(input.childFence, this.#identity.childFence)
      || !isDeepStrictEqual(input.outputRules, this.#input.outputRules)
      || !isDeepStrictEqual(input.secretValues ?? [], this.#input.secretValues)
      || createMediaNativeObservationPlan({ protocol: input.protocol, adapterId: input.adapterId,
        baseUrl: input.baseUrl }).namespaceDigest !== this.#identity.namespaceDigest) {
      throw new Error("media_receipt_generation_conflict");
    }
  }

  /** Materialized POST bytes enter the fixed Core pair transaction immediately around native fetch. */
  launch(request: HostMediaWireRequest, send: () => void): void {
    this.#assertOpen();
    if (typeof send !== "function" || Object.prototype.toString.call(send) === "[object AsyncFunction]") {
      throw new Error("media_receipt_send_must_be_synchronous");
    }
    const kind = this.#plan.effectKind(request);
    if (!kind || request.method !== "POST") throw new Error("media_receipt_effect_route_invalid");
    const effectId = `media_effect_${randomUUID()}`;
    this.#tracker.prepareMediaEffect(this.#ticket, { effectId, ordinal: this.#effects.size, kind,
      method: "POST", routeDigest: request.routeDigest, wireDigest: request.wireDigest, preparedAt: now() });
    this.#effects.set(request, { id: effectId, kind });
    let entered = false;
    try { this.#tracker.launchMediaEffect(this.#ticket, effectId, () => {
      entered = true; this.#sendEntered = true; return send();
    }); }
    catch (error) {
      if (!entered) {
        try {
          const seal = this.#seal("no-start", { ...this.#identity, kind: "media_effect_no_start_v1", effectId, completedAt: now() });
          this.#recordOriginalReceipt({ kind: "no_start", effectId, artifactId: seal.id });
        } catch { /* The original gate failure wins; an unconfirmed no-start remains blocked. */ }
      }
      throw error;
    }
  }

  /** Called only after the original response reaches EOF; structural clients/exchanges are rejected. */
  capture(native: HostMediaNativeTransport, exchange: HostMediaHttpExchange): void {
    this.#assertOpen();
    assertHostMediaNativeTransport(native); native.assertExchange(exchange);
    this.#matcher.capture(native, exchange);
    if (exchange.httpStatus < 200 || exchange.httpStatus >= 300) return;
    const effect = this.#effects.get(exchange.request);
    if (effect) {
      const submission = effect.kind === "remote_generation_submit" ? decodeMediaNativeSubmission(this.#plan, native, exchange) : undefined;
      if (effect.kind === "remote_generation_submit" && !submission) return;
      const response = this.#seal("response", { ...this.#identity, kind: "media_response_v1", effectId: effect.id,
        routeDigest: exchange.request.routeDigest, wireDigest: exchange.request.wireDigest,
        responseNamespaceDigest: this.#identity.namespaceDigest, httpStatus: exchange.httpStatus,
        bodySha256: exchange.bodySha256, completedAt: exchange.completedAt,
        ...(submission ? { externalOperationId: submission.externalOperationId } : {}) });
      this.#recordOriginalReceipt({ kind: "response", effectId: effect.id, artifactId: response.id });
      if (submission) {
        const artifact = this.#seal("submission", { ...this.#identity, kind: "media_submission_v1", effectId: effect.id,
          responseArtifactId: response.id, externalOperationId: submission.externalOperationId,
          statusRouteDigest: submission.statusRouteDigest,
          ...(submission.statusRouteDigests ? { statusRouteDigests: submission.statusRouteDigests } : {}), completedAt: now() });
        this.#submission = Object.freeze({ artifactId: artifact.id, externalOperationId: submission.externalOperationId });
      }
      return;
    }
    if (!this.#submission || this.#terminal) return;
    const row = this.#input.store.getHostMediaExecution(this.#ticket.executionId);
    if (!row?.submissionArtifactId) return; // An ACK artifact alone never authorizes polling or completion.
    const terminal = decodeMediaNativeTerminal(this.#plan, native, exchange, this.#submission.externalOperationId);
    if (!terminal) return;
    const artifact = this.#seal("terminal", { ...this.#identity, kind: "media_terminal_v1", observation: terminal.observation,
      responseNamespaceDigest: this.#identity.namespaceDigest, routeDigest: exchange.request.routeDigest,
      bodySha256: exchange.bodySha256, httpStatus: exchange.httpStatus, completedAt: exchange.completedAt });
    this.#recordOriginalReceipt({ kind: "terminal", artifactId: artifact.id });
    this.#terminal = terminal;
  }

  persistSubmission(handle: MediaExecutionHandle, nextPollAt: string): void {
    this.#assertOpen();
    if (!this.#submission || handle.externalOperationId !== this.#submission.externalOperationId
      || handle.adapterKind !== this.#plan.adapterId) throw new Error("media_receipt_submission_projection_mismatch");
    const projection = { recovery: handle.recovery, nextPollAt, pollAttempts: 0 };
    try { this.#tracker.recordMediaSubmissionAndExecutionHandle(this.#ticket, this.#submission.artifactId, projection); }
    catch {
      // Replay only the original sealed receipt and capability, never POST. A
      // post-COMMIT throw may have already committed both immutable facts and
      // projection; the fixed Core API verifies an exact idempotent readback.
      try { this.#tracker.recordMediaSubmissionAndExecutionHandle(this.#ticket, this.#submission.artifactId, projection); }
      catch (error) { throw new MediaLocalExecutionAdmissionError("media_submission_persistence_unconfirmed",
        error instanceof Error ? error.message : String(error)); }
    }
  }

  collectionContext(): HostMediaArtifactCollectionContext {
    this.#assertOpen();
    return Object.freeze({ executionId: this.#identity.executionId, executionGenerationId: this.#identity.executionGenerationId,
      source: this.#identity.source, childFence: this.#identity.childFence,
      getRemoteDescriptor: this.#matcher.getRemoteDescriptor });
  }

  recordCollection(result: MediaArtifactCollectionResult, collected: boolean): void {
    this.#assertOpen();
    const remote = this.#terminal?.observation.outcome;
    const outcome = remote === "failed" ? "remote_failed" : remote === "cancelled" ? "remote_cancelled"
      : collected ? "collected" : "collection_failed";
    const artifact = this.#seal("manifest", { ...this.#identity, kind: "media_manifest_v1", outcome,
      items: result.manifestItems, completedAt: now() });
    this.#recordOriginalReceipt({ kind: "manifest", artifactId: artifact.id });
    this.#manifestArtifactId = artifact.id;
  }

  /** Original local send latch plus every exact Core no-start fact, not a rolled-back launch marker. */
  recordNoStartCollection(): boolean {
    this.#assertOpen();
    if (this.#sendEntered || this.#submission || this.#terminal || this.#manifestArtifactId) return false;
    const effects = this.#input.store.listHostMediaEffects(this.#ticket.executionId);
    if (effects.some(effect => effect.launchedAt || !effect.noStartArtifactId || effect.responseArtifactId)
      || this.#input.store.listMediaJobArtifacts(this.#input.job.id).length) return false;
    this.recordCollection({ artifacts: [], manifestItems: [] }, false);
    return true;
  }

  /** Registry's exclusive zero-owner/zero-timer boundary is the only caller of this final tail. */
  finish(): void {
    this.#assertOpen();
    if (!this.#manifestArtifactId) throw new Error("media_receipt_manifest_unconfirmed");
    const row = this.#input.store.getHostMediaExecution(this.#ticket.executionId);
    if (!row) throw new Error("media_receipt_execution_missing");
    const effects = this.#input.store.listHostMediaEffects(this.#ticket.executionId).map(effect => ({ effectId: effect.effectId,
      ...(effect.responseArtifactId ? { responseArtifactId: effect.responseArtifactId } : {}),
      ...(effect.noStartArtifactId ? { noStartArtifactId: effect.noStartArtifactId } : {}) }));
    const artifact = this.#seal("finalization", { ...this.#identity, kind: "media_finalization_v1", effects,
      ...(row.submissionArtifactId ? { submissionArtifactId: row.submissionArtifactId } : {}),
      ...(row.terminalArtifactId ? { terminalArtifactId: row.terminalArtifactId } : {}),
      manifestArtifactId: this.#manifestArtifactId, completedAt: now() });
    this.#recordOriginalReceipt({ kind: "finalization", artifactId: artifact.id });
    this.#tracker.settleMediaFromStore(this.#transport);
    this.#tracker.settleMediaFromStore(this.#parent);
    this.#finished = true;
  }

  /** Revalidate only an original sealed fact; never retry transport, reseal, or invoke caller code. */
  #recordOriginalReceipt(write: OriginalReceiptWrite): void {
    const record = (): void => {
      switch (write.kind) {
        case "response": this.#tracker.recordMediaResponse(this.#ticket, write.effectId, write.artifactId); break;
        case "no_start": this.#tracker.recordMediaEffectNoStart(this.#ticket, write.effectId, write.artifactId); break;
        case "terminal": this.#tracker.recordMediaTerminal(this.#ticket, write.artifactId); break;
        case "manifest": this.#tracker.recordMediaArtifactManifest(this.#ticket, write.artifactId); break;
        case "finalization": this.#tracker.finalizeMediaExecution(this.#ticket, write.artifactId); break;
      }
    };
    try { record(); }
    catch {
      // A throw may follow COMMIT. Core's exact idempotent writer verifies the
      // same private ticket and seal once; a second throw remains uncertainty.
      record();
    }
  }

  #seal(label: string, payload: object) {
    return this.#input.store.createArtifact({ runId: this.#tracker.source.runId, type: "json",
      path: `media_receipts/${this.#input.localExecution.generation}/${label}-${randomUUID()}.json`,
      createdAt: now(), sealedPayload: payload });
  }
  #assertOpen(): void { if (this.#finished) throw new Error("media_receipt_producer_finished"); }
}

const now = (): string => new Date().toISOString();
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
