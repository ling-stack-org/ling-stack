import { isDeepStrictEqual } from "node:util";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { redactSecrets, type ApprovalRequest, type CreateNativeApprovalInput, type NativeExecutionStore, type NativeSubmissionKey } from "@ling-stack/core";
import type { ApprovalActionPolicyDecision } from "../../features/runs/approval-action-policy.js";
import type { AcpPermissionRequest, AcpPermissionReplyObservation } from "./live-client.js";
import { AcpLifecycleError, text } from "./live-errors.js";

export type AcpPreparedApproval = { readonly kind: "action"; readonly approval: Omit<CreateNativeApprovalInput["approval"], "expiresAt">;
  readonly policyDecision: ApprovalActionPolicyDecision; readonly contextRevision?: number;
  readonly contextCwd?: string; readonly contextIdentity?: string } | { readonly kind: "unsupported"; readonly reason: string };
/** Trusted target normalization, including current context/policy. Never supplied by a renderer/native payload. */
export interface AcpApprovalPreparer { prepare(request: AcpPermissionRequest): AcpPreparedApproval }
type Action = Extract<AcpPreparedApproval, { kind: "action" }>;
interface Entry { readonly approvalId: string; readonly request: AcpPermissionRequest; readonly prepared: Action; readonly expiresAt: string }

function approvalIdentity(approval: Action["approval"]) {
  const { extraSecrets: _extraSecrets, ...identity } = approval;
  return identity;
}

/** Redaction metadata can rotate; every raw action and policy field remains identity. */
export function acpActionIdentity(prepared: Action) {
  return { ...prepared, approval: approvalIdentity(prepared.approval) };
}

export function sameAcpAction(left: AcpPreparedApproval | undefined, right: AcpPreparedApproval | undefined): boolean {
  return left?.kind === "action" && right?.kind === "action"
    && isDeepStrictEqual(acpActionIdentity(left), acpActionIdentity(right));
}

/** One reserved ACP submission. The runtime owns native preparation, human waiting and terminal events. */
export class AcpApprovalJournal {
  readonly #requests = new Map<string | number, Entry>();
  readonly #key: NativeSubmissionKey;
  constructor(readonly store: NativeExecutionStore, key: NativeSubmissionKey, readonly actions: AcpApprovalPreparer,
    readonly now: () => string = () => new Date().toISOString()) { this.#key = structuredClone(key); }

  create(request: AcpPermissionRequest, signal: AbortSignal): ApprovalRequest {
    signal.throwIfAborted();
    const snapshot = structuredClone(request);
    if (snapshot.requestId === null) fail();
    this.#binding(snapshot);
    const prepared = structuredClone(this.actions.prepare(structuredClone(snapshot)));
    if (prepared.kind !== "action" || !["ask", "allow"].includes(prepared.policyDecision.decision)
      || prepared.approval.toolCallId !== snapshot.params.toolCall.toolCallId
      || prepared.approval.payload.type === "native_permission_request"
      || !option(snapshot, true) || !option(snapshot, false)) fail();
    const previous = this.#requests.get(snapshot.requestId);
    if (previous && (!isDeepStrictEqual(previous.request, snapshot) || !sameAcpAction(previous.prepared, prepared))) fail();
    const creation = previous?.prepared ?? prepared;
    const time = this.now();
    const expiresAt = previous?.expiresAt ?? new Date(Date.parse(time) + 300000).toISOString();
    signal.throwIfAborted();
    const saved = this.store.createNativeApproval({ ...this.#key, requestId: snapshot.requestId,
      method: "session/request_permission", approval: { ...creation.approval, expiresAt } }, time);
    this.#requests.set(snapshot.requestId, { approvalId: saved.approval.id, request: snapshot, prepared: creation, expiresAt });
    return saved.approval;
  }

  beforeWrite(request: AcpPermissionRequest, response: RequestPermissionResponse): void {
    if (request.requestId === null) fail();
    const entry = this.#requests.get(request.requestId);
    if (!entry) {
      // An unmapped native request may be declined, but never granted without a saved decision.
      const denial = option(request, false);
      if (!denial || !isDeepStrictEqual(response, { outcome: { outcome: "selected", optionId: denial } })) fail();
      return;
    }
    if (!isDeepStrictEqual(entry.request, request)) fail();
    this.#binding(request);
    const claimed = this.store.claimNativeApprovalReply({ approvalId: entry.approvalId, fence: this.#key.fence }, this.now());
    const approved = claimed.approval.status === "approved";
    if (approved) {
      const current = this.actions.prepare(structuredClone(entry.request));
      if (current.kind !== "action" || !["ask", "allow"].includes(current.policyDecision.decision) || !sameAcpAction(current, entry.prepared)) fail();
    }
    const expected = option(entry.request, approved);
    if (!expected || !isDeepStrictEqual(response, { outcome: { outcome: "selected", optionId: expected } })) fail();
  }

  observe(observation: AcpPermissionReplyObservation): void {
    if (observation.requestId === null) fail();
    const entry = this.#requests.get(observation.requestId);
    if (!entry) return;
    const current = this.store.getNativeApprovalCorrelation(entry.approvalId);
    if (!current || current.submissionId !== this.#key.submissionId || current.method !== "session/request_permission") fail();
    if (current.resolvedAt) { this.#requests.delete(observation.requestId); return; }
    const key = { approvalId: entry.approvalId, fence: this.#key.fence };
    if (current.replyStatus === "claimed") this.store.settleNativeApprovalReply({ ...key, outcome: observation.outcome }, this.now());
    else if (observation.outcome !== "not_written") fail();
    if (observation.outcome !== "written") {
      this.store.resolveNativeApprovalRequest(key, this.now());
      this.#requests.delete(observation.requestId);
    }
  }

  findForHost(prepared: Extract<AcpPreparedApproval, { kind: "action" }>, saved?: ApprovalRequest): string | undefined {
    const matches = [...this.#requests.values()].filter(entry => entry.prepared.kind === "action"
      && entry.prepared.contextRevision === prepared.contextRevision && entry.prepared.contextCwd === prepared.contextCwd
      && isDeepStrictEqual(approvalIdentity(entry.prepared.approval), approvalIdentity(prepared.approval))
      && sameAcpAction(this.actions.prepare(structuredClone(entry.request)), entry.prepared));
    if (matches.length !== 1) return undefined;
    const entry = matches[0]!;
    this.#binding(entry.request);
    if (saved && (saved.id !== entry.approvalId || saved.expiresAt !== entry.expiresAt || saved.actionType !== entry.prepared.approval.actionType
      || !isDeepStrictEqual(saved.payload, redactSecrets(entry.prepared.approval.payload, entry.prepared.approval.extraSecrets ?? [])))) return undefined;
    return entry.approvalId;
  }

  clear(): void { this.#requests.clear(); }

  #binding(request: AcpPermissionRequest): void {
    const submission = this.store.getNativeSubmission(this.#key.submissionId);
    const binding = submission && this.store.getNativeExecutionBinding(submission.bindingId);
    if (!submission || !binding || !isDeepStrictEqual(submission.fence, this.#key.fence)
      || submission.status !== "accepted" || submission.nativePromptRequestId === undefined || submission.nativeTurnId !== undefined
      || !["kimi-acp", "openclaw-acp"].includes(binding.selection.engineId) || binding.nativeSessionId !== request.params.sessionId) fail();
  }
}

function option(request: AcpPermissionRequest, approved: boolean): string | undefined {
  if (request.params.options.some(item => !text(item.optionId))
    || new Set(request.params.options.map(item => item.optionId)).size !== request.params.options.length) return undefined;
  const options = request.params.options.filter(item => item.kind === (approved ? "allow_once" : "reject_once"));
  return options.length === 1 ? options[0]!.optionId : undefined;
}
function fail(): never { throw new AcpLifecycleError("host_commit_failed", "unknown"); }
