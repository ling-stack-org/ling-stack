import { setTimeout as delay } from "node:timers/promises";
import type { NativeExecutionStore, NativeSubmissionKey, RunEventEnvelope } from "@ling-stack/core";
import type { CodexCreateApproval } from "./approval-journal.js";
import { nativeDenialDecision, type CodexPreparedAction } from "./action-preparation.js";
import { CodexRpcError, type CodexRequest } from "./duplex.js";
import { codexPermissionResponse } from "./permission-preparation.js";

export interface CodexApprovalWaitOptions {
  readonly onEvent: (event: RunEventEnvelope) => void;
  readonly onWaitChanged?: (waiting: boolean) => void;
  readonly pollIntervalMs?: number;
}

/** Waits for Ling decisions only. Native execution and reply delivery remain owned by the journal. */
export class CodexApprovalWait {
  readonly #delivered = new Set<string>();
  readonly #interval: number;
  #active = 0;

  constructor(readonly store: NativeExecutionStore, readonly key: NativeSubmissionKey,
    readonly now: () => string, readonly options: CodexApprovalWaitOptions) {
    this.#interval = options.pollIntervalMs ?? 250;
    if (!Number.isSafeInteger(this.#interval) || this.#interval < 1 || this.#interval > 1000) throw new CodexRpcError("handler_failed");
  }

  handles(method: string): boolean {
    return ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"].includes(method);
  }

  synchronize(publish = true) {
    const snapshot = this.store.synchronizeNativeApprovalWait(this.key, this.now());
    if (publish) for (const event of snapshot.events) {
      if (this.#delivered.has(event.id)) continue;
      this.#delivered.add(event.id);
      this.options.onEvent(structuredClone(event));
    }
    return snapshot;
  }

  async handle(request: CodexRequest, signal: AbortSignal, create: CodexCreateApproval,
    prepared: CodexPreparedAction): Promise<unknown> {
    signal.throwIfAborted();
    const permissions = request.method === "item/permissions/requestApproval";
    if (prepared.kind !== "action" || prepared.policyDecision.decision === "deny") {
      if (permissions) return { permissions: {}, scope: "turn" };
      const decision = nativeDenialDecision(request.params);
      if (decision && ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(request.method)) return { decision };
      throw new CodexRpcError("handler_failed");
    }
    this.#active += 1;
    try {
      if (this.#active === 1) this.options.onWaitChanged?.(true);
      signal.throwIfAborted();
      const created = create();
      for (;;) {
        signal.throwIfAborted();
        const snapshot = this.synchronize();
        signal.throwIfAborted();
        const record = snapshot.approvals.find(value => value.approval.id === created.id);
        if (!record || record.correlation.resolvedAt) throw new CodexRpcError("handler_failed");
        const approval = record.approval;
        if (approval.status === "approved" || approval.status === "denied") {
          const approved = approval.status === "approved";
          return permissions && approval.payload.type === "native_permission_request"
            ? codexPermissionResponse(approval.payload, approved)
            : { decision: approved ? "accept" : prepared.denialDecision };
        }
        if (approval.status !== "pending") throw new CodexRpcError("handler_failed");
        const remaining = Date.parse(approval.expiresAt!) - Date.parse(this.now());
        if (!Number.isFinite(remaining)) throw new CodexRpcError("handler_failed");
        await delay(Math.max(1, Math.min(this.#interval, remaining)), undefined, { signal });
      }
    } finally {
      this.#active -= 1;
      if (this.#active === 0) this.options.onWaitChanged?.(false);
    }
  }
}
