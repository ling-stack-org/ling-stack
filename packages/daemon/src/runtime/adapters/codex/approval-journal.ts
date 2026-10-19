import { isDeepStrictEqual } from "node:util";
import type { ApprovalRequest, NativeExecutionStore, NativeSubmissionKey } from "@ling-stack/core";
import { CodexRpcError, type CodexRequest, type CodexReplyObservation } from "./duplex.js";
import { nativeDenialDecision, type CodexActionPreparer, type CodexPreparedAction } from "./action-preparation.js";
import { codexPermissionResponse } from "./permission-preparation.js";

export type CodexCreateApproval = (options?: { readonly expiresAt?: string }) => ApprovalRequest;
const commandApproval = "item/commandExecution/requestApproval";
const fileApproval = "item/fileChange/requestApproval";
const permissionsApproval = "item/permissions/requestApproval";

/** Correlates Daemon-prepared approvals with replies. The run layer owns user decision waiting. */
export class CodexApprovalJournal {
  readonly #requests = new Map<string | number, { approvalId: string; method: string; prepared: CodexPreparedAction }>();

  constructor(readonly store: NativeExecutionStore, readonly key: NativeSubmissionKey, readonly now: () => string,
    readonly actions: CodexActionPreparer) {}

  create(request: CodexRequest, prepared: CodexPreparedAction, signal: AbortSignal, options?: Parameters<CodexCreateApproval>[0]): ApprovalRequest {
    signal.throwIfAborted();
    if (prepared.kind !== "action" || (options !== undefined && (!record(options) || Object.keys(options).some(key => key !== "expiresAt")))) {
      throw new CodexRpcError("handler_failed");
    }
    if (!isDeepStrictEqual(this.actions.prepare(request), prepared)) throw new CodexRpcError("handler_failed");
    const currentTime = this.now();
    const deadline = Date.parse(currentTime) + 300000;
    const expires = options?.expiresAt === undefined ? deadline : typeof options.expiresAt === "string" ? Date.parse(options.expiresAt) : NaN;
    if (!Number.isFinite(expires) || expires > deadline) throw new CodexRpcError("handler_failed");
    const approval = { ...prepared.approval, expiresAt: new Date(expires).toISOString() };
    const params = request.params;
    const submission = this.store.getNativeSubmission(this.key.submissionId);
    const binding = submission && this.store.getNativeExecutionBinding(submission.bindingId);
    if (![commandApproval, fileApproval, permissionsApproval].includes(request.method) || !record(params)
      || submission?.status !== "accepted" || params.threadId !== binding?.nativeSessionId || params.turnId !== submission.nativeTurnId
      || typeof params.itemId !== "string" || approval.toolCallId !== params.itemId
      || (request.method === commandApproval && params.kind !== undefined && params.kind !== "command")
      || (request.method === fileApproval && params.grantRoot != null)) throw new CodexRpcError("handler_failed");
    const saved = this.store.createNativeApproval({ ...this.key, requestId: request.id, method: request.method, approval }, currentTime);
    this.#requests.set(request.id, { approvalId: saved.approval.id, method: request.method, prepared: structuredClone(prepared) });
    return saved.approval;
  }

  beforeWrite(request: CodexRequest, result: unknown): void {
    const entry = this.#requests.get(request.id);
    if (!entry) {
      // Unsupported/unmapped approval requests may only be declined, never implicitly granted.
      const denial = nativeDenialDecision(request.params);
      if ([commandApproval, fileApproval].includes(request.method) && (!denial || !isDeepStrictEqual(result, { decision: denial }))) {
        throw new CodexRpcError("handler_failed");
      }
      if (request.method === permissionsApproval && !isDeepStrictEqual(result, { permissions: {}, scope: "turn" })) {
        throw new CodexRpcError("handler_failed");
      }
      return;
    }
    if (entry.method !== request.method) throw new CodexRpcError("handler_failed");
    const claimed = this.store.claimNativeApprovalReply({ approvalId: entry.approvalId, fence: this.key.fence }, this.now());
    if (entry.prepared.kind !== "action") throw new CodexRpcError("handler_failed");
    if (claimed.approval.status === "approved") this.actions.assertCurrent(request, entry.prepared);
    const approved = claimed.approval.status === "approved";
    const payload = entry.prepared.approval.payload;
    const expected = request.method === permissionsApproval && payload.type === "native_permission_request"
      ? codexPermissionResponse(payload, approved)
      : { decision: approved ? "accept" : entry.prepared.denialDecision };
    if (!isDeepStrictEqual(result, expected)) throw new CodexRpcError("handler_failed");
  }

  observe(observation: CodexReplyObservation): void {
    const entry = this.#requests.get(observation.requestId);
    if (!entry) return;
    if (entry.method !== observation.method) throw new CodexRpcError("handler_failed");
    const current = this.store.getNativeApprovalCorrelation(entry.approvalId);
    if (!current) throw new CodexRpcError("handler_failed");
    if (current.resolvedAt) { this.#requests.delete(observation.requestId); return; }
    const key = { approvalId: entry.approvalId, fence: this.key.fence };
    if (current.replyStatus === "claimed") this.store.settleNativeApprovalReply({ ...key, outcome: observation.outcome }, this.now());
    else if (observation.outcome !== "not_written") throw new CodexRpcError("handler_failed");
    if (observation.outcome !== "written") this.resolve(observation.requestId);
  }

  resolve(requestId: string | number): void {
    const entry = this.#requests.get(requestId);
    if (!entry) return;
    this.store.resolveNativeApprovalRequest({ approvalId: entry.approvalId, fence: this.key.fence }, this.now());
    this.#requests.delete(requestId);
  }

  clear(): void { this.#requests.clear(); }
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
