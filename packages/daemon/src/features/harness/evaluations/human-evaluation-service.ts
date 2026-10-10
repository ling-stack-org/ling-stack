import type {
  RunEvaluationHumanEventV1, RunEvaluationHumanHeadV1, RunEvaluationHumanIntentV1,
} from "@ling-stack/contracts";
import type { RunEvaluationHumanSettlement, RunStore } from "@ling-stack/core";
import { trimOversizedEvent, type ControlPlaneEventHub } from "../../control-plane/events.js";
import { HumanEvaluationDesktopAuthority } from "./human-evaluation-authority.js";
import { HUMAN_EVALUATION_INTENT_TTL_MS, readHumanEvaluationCommit, readHumanEvaluationIntentInput,
  readHumanEvaluationRevocation, readHumanEvaluationSnapshot,
  type HumanEvaluationHandshake } from "./human-evaluation-protocol.js";

type HumanStore = Pick<RunStore, "getRunEvaluationQaEnrollment" | "getRunEvaluationQaScope"
  | "getRunEvaluationHumanIntent" | "getRunEvaluationHumanHead" | "getRunEvaluationHumanEvent" | "listRunEvaluationHumanEvents"
  | "createRunEvaluationHumanIntent" | "commitRunEvaluationHumanIntent">;
export interface HumanEvaluationServiceOptions {
  readonly authority: HumanEvaluationDesktopAuthority;
  readonly getStore: () => HumanStore;
  readonly events: Pick<ControlPlaneEventHub, "publish">;
  readonly clock?: () => string;
}
type Rejected = { readonly accepted: false; readonly reason: string };
export type HumanEvaluationIntentResult = Rejected
  | { readonly accepted: true; readonly intent: RunEvaluationHumanIntentV1; readonly replayed: boolean };
export type HumanEvaluationCommitResult = Rejected
  | ({ readonly accepted: true; readonly replayed: boolean } & RunEvaluationHumanSettlement);
export type HumanEvaluationSnapshotResult = Rejected | {
  readonly accepted: true; readonly head?: RunEvaluationHumanHeadV1;
  readonly events: readonly RunEvaluationHumanEventV1[];
  readonly headEvent?: RunEvaluationHumanEventV1; readonly intent?: RunEvaluationHumanIntentV1;
  readonly nextAfterRevision?: number;
};

/**
 * Private terminal-QA ingress, independent of Computer Use or active Runs.
 * HMAC authenticates a Main receipt, not an OS identity by itself: production
 * Main must sign only after its exact payload-bound native confirmation path.
 * Only Core's atomic intent/head/event/audit transaction establishes a fact.
 */
export class HumanEvaluationService {
  private readonly clock: () => string;
  private clockHighWater = -Infinity;
  private committing = false;

  constructor(private readonly options: HumanEvaluationServiceOptions) {
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  handshake(value: unknown): HumanEvaluationHandshake { return this.options.authority.handshake(value); }

  createIntent(value: unknown): HumanEvaluationIntentResult {
    const input = readHumanEvaluationIntentInput(value);
    if (!this.options.authority.isCurrent(input.authority)) return rejected("human_binding_changed");
    const current = this.options.authority.capture(input.authority);
    const now = this.now();
    const store = this.options.getStore();
    if (!current()) return rejected("human_binding_changed");
    if (store.getRunEvaluationQaScope()?.canonicalWorkspaceCwd !== this.options.authority.workspaceCwd) return rejected("qa_not_enrolled");
    if (!current()) return rejected("human_binding_changed");
    const result = store.createRunEvaluationHumanIntent({ taskId: input.taskId, requestId: input.requestId,
      submission: input.submission, binding: input.authority, now,
      expiresAt: new Date(Date.parse(now) + HUMAN_EVALUATION_INTENT_TTL_MS).toISOString() });
    if (!current()) return rejected("human_binding_changed");
    return result.ok ? { accepted: true, intent: result.value, replayed: result.replayed } : rejected(result.code);
  }

  commit(value: unknown): HumanEvaluationCommitResult {
    const input = readHumanEvaluationCommit(value);
    if (this.committing) return rejected("evaluation_human_busy");
    if (!this.options.authority.verifyConfirmation(input.authority, input.intentId,
      input.confirmation, input.signature)) return rejected("human_confirmation_invalid");
    const current = this.options.authority.capture(input.authority);
    const now = this.now();
    const store = this.options.getStore();
    if (!current()) return rejected("human_binding_changed");
    if (store.getRunEvaluationQaScope()?.canonicalWorkspaceCwd !== this.options.authority.workspaceCwd) return rejected("qa_not_enrolled");
    if (!current()) return rejected("human_binding_changed");
    const intent = store.getRunEvaluationHumanIntent(input.intentId);
    if (!current()) return rejected("human_binding_changed");
    if (!intent) return rejected("not_found");
    if (intent.payload.canonicalWorkspaceCwd !== this.options.authority.workspaceCwd
      || !this.options.authority.isCurrent(intent.payload.binding)) return rejected("human_binding_changed");
    if (input.confirmation.requestId !== intent.payload.requestId
      || input.confirmation.payloadDigest !== intent.payloadDigest) return rejected("human_confirmation_invalid");
    const confirmedAt = Date.parse(input.confirmation.confirmedAt);
    if (confirmedAt < Date.parse(intent.createdAt) || confirmedAt > Date.parse(now)
      || Date.parse(now) >= Date.parse(intent.payload.expiresAt)) return rejected("human_intent_expired");
    this.committing = true;
    try {
      const result = store.commitRunEvaluationHumanIntent({ intentId: input.intentId,
        payloadDigest: intent.payloadDigest, binding: input.authority, confirmation: input.confirmation, now,
        assertAuthorityCurrent: () => {
          const liveNow = this.now();
          if (!current() || Date.parse(liveNow) >= Date.parse(intent.payload.expiresAt)) {
            throw new Error("human_binding_changed");
          }
        } });
      if (!result.ok) return rejected(result.code);
      // Core has already COMMITted. A delivery failure cannot roll back the
      // durable fact; polling/replay can recover it without a second audit row.
      if (!result.replayed) {
        try { this.options.events.publish(trimOversizedEvent(result.value.audit)); }
        catch { console.warn("evaluation_human_postcommit_publish_failed"); }
      }
      return { accepted: true, replayed: result.replayed, ...result.value };
    } finally { this.committing = false; }
  }

  snapshot(value: unknown): HumanEvaluationSnapshotResult {
    const input = readHumanEvaluationSnapshot(value);
    if (!this.options.authority.isCurrent(input.authority)) return rejected("human_binding_changed");
    const current = this.options.authority.capture(input.authority);
    const store = this.options.getStore();
    if (!current()) return rejected("human_binding_changed");
    const enrollment = store.getRunEvaluationQaEnrollment(input.taskId);
    const scope = store.getRunEvaluationQaScope();
    if (!current()) return rejected("human_binding_changed");
    if (!enrollment || scope?.canonicalWorkspaceCwd !== this.options.authority.workspaceCwd) return rejected("qa_not_enrolled");
    const head = store.getRunEvaluationHumanHead(input.taskId);
    const headEvent = head ? store.getRunEvaluationHumanEvent(head.eventId) : undefined;
    const intent = input.intentId ? store.getRunEvaluationHumanIntent(input.intentId) : undefined;
    if (input.intentId && (!intent || intent.payload.taskId !== input.taskId
      || intent.payload.enrollmentId !== enrollment.id
      || intent.payload.canonicalWorkspaceCwd !== this.options.authority.workspaceCwd)) return rejected("identity_conflict");
    if (head && (!headEvent || headEvent.taskId !== input.taskId || headEvent.revision !== head.revision)) return rejected("identity_conflict");
    const events = store.listRunEvaluationHumanEvents({ taskId: input.taskId,
      ...(input.afterRevision === undefined ? {} : { afterRevision: input.afterRevision }), limit: 100 });
    if (!current()) return rejected("human_binding_changed");
    return { accepted: true, ...(head ? { head, headEvent } : {}), ...(intent ? { intent } : {}), events,
      ...(events.length === 100 ? { nextAfterRevision: events[events.length - 1]!.revision } : {}) };
  }

  revokeAuthority(value: unknown): { readonly accepted: boolean; readonly reason?: string } {
    return this.options.authority.revoke(readHumanEvaluationRevocation(value))
      ? { accepted: true } : rejected("human_binding_changed");
  }

  close(): void { this.options.authority.close(); }

  private now(): string {
    const value = this.clock();
    const time = Date.parse(value);
    if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error("evaluation_human_clock_invalid");
    this.clockHighWater = Math.max(time, this.clockHighWater);
    return new Date(this.clockHighWater).toISOString();
  }
}

function rejected(reason: string): Rejected { return { accepted: false, reason }; }
