import type { ConversationActiveReplyTarget } from "../../types.js";

export type ConversationSendPhase =
  | "idle"
  | "submitting"
  | "message_accepted"
  | "reply_linked"
  | "settled"
  | "confirmation_unknown"
  | "failed_before_accept";

export interface ConversationSendOperation {
  readonly ownerKey: string;
  readonly requestId: number;
  readonly hasPendingPredecessor: boolean;
}

export interface ConversationSendLifecycleSnapshot {
  readonly ownerKey: string;
  readonly requestId: number;
  readonly phase: ConversationSendPhase;
  readonly activeReplies: readonly ConversationActiveReplyTarget[];
}

type ActiveConversationSendPhase = "submitting" | "message_accepted" | "reply_linked";

interface ConversationSendOperationState extends ConversationSendOperation {
  readonly phase: ActiveConversationSendPhase;
  readonly activeReplies: readonly ConversationActiveReplyTarget[];
}

const emptySnapshot = (ownerKey: string): ConversationSendLifecycleSnapshot => ({
  ownerKey,
  requestId: 0,
  phase: "idle",
  activeReplies: [],
});

export class ConversationSendLifecycleStore {
  #sequence = 0;
  #ownerKey: string;
  #latestRequestId = 0;
  #terminalPhase: ConversationSendPhase = "idle";
  #operations = new Map<number, ConversationSendOperationState>();
  #snapshot: ConversationSendLifecycleSnapshot;

  constructor(ownerKey = "") {
    this.#ownerKey = ownerKey;
    this.#snapshot = emptySnapshot(ownerKey);
  }

  snapshot(): ConversationSendLifecycleSnapshot {
    return this.#snapshot;
  }

  reset(ownerKey: string): void {
    this.#ownerKey = ownerKey;
    this.#latestRequestId = 0;
    this.#terminalPhase = "idle";
    this.#operations.clear();
    this.#snapshot = emptySnapshot(ownerKey);
  }

  begin(ownerKey: string): ConversationSendOperation {
    if (ownerKey !== this.#ownerKey) this.reset(ownerKey);
    const operation = {
      ownerKey,
      requestId: ++this.#sequence,
      hasPendingPredecessor: this.#operations.size > 0,
    };
    this.#latestRequestId = operation.requestId;
    this.#operations.set(operation.requestId, { ...operation, phase: "submitting", activeReplies: [] });
    this.#publish();
    return operation;
  }

  accept(operation: ConversationSendOperation): boolean {
    const state = this.#operation(operation);
    if (!state) return false;
    if (state.phase === "message_accepted" || state.phase === "reply_linked") return true;
    this.#operations.set(operation.requestId, { ...state, phase: "message_accepted" });
    this.#publish();
    return true;
  }

  link(operation: ConversationSendOperation, target: ConversationActiveReplyTarget): boolean {
    const state = this.#operation(operation);
    if (!state || (state.phase !== "message_accepted" && state.phase !== "reply_linked")) return false;
    const activeReplies = [
      ...state.activeReplies.filter((candidate) => candidate.runId !== target.runId),
      target,
    ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    this.#operations.set(operation.requestId, { ...state, phase: "reply_linked", activeReplies });
    this.#publish();
    return true;
  }

  settle(operation: ConversationSendOperation): boolean {
    if (!this.#operation(operation)) return false;
    this.#operations.delete(operation.requestId);
    this.#terminalPhase = "settled";
    this.#publish();
    return true;
  }

  defer(operation: ConversationSendOperation): boolean {
    const state = this.#operation(operation);
    if (!state || state.phase !== "submitting") return false;
    this.#operations.delete(operation.requestId);
    this.#terminalPhase = "confirmation_unknown";
    this.#publish();
    return true;
  }

  fail(operation: ConversationSendOperation): { readonly accepted: boolean; readonly restoreInput: boolean } {
    const state = this.#operation(operation);
    if (!state) return { accepted: false, restoreInput: false };
    if (state.phase === "submitting") {
      this.#operations.delete(operation.requestId);
      this.#terminalPhase = "failed_before_accept";
      this.#publish();
      return { accepted: false, restoreInput: true };
    }
    if (state.phase === "message_accepted") {
      this.#operations.delete(operation.requestId);
      this.#terminalPhase = "settled";
      this.#publish();
      return { accepted: true, restoreInput: false };
    }
    this.#operations.delete(operation.requestId);
    this.#terminalPhase = "settled";
    this.#publish();
    return { accepted: true, restoreInput: false };
  }

  #operation(operation: ConversationSendOperation): ConversationSendOperationState | undefined {
    if (operation.ownerKey !== this.#ownerKey) return undefined;
    return this.#operations.get(operation.requestId);
  }

  #publish(): void {
    const operations = [...this.#operations.values()];
    const activeRepliesByRunId = new Map<string, ConversationActiveReplyTarget>();
    for (const operation of operations) {
      for (const reply of operation.activeReplies) activeRepliesByRunId.set(reply.runId, reply);
    }
    const phase = operations.some((operation) => operation.phase === "submitting")
      ? "submitting"
      : operations.some((operation) => operation.phase === "message_accepted")
        ? "message_accepted"
        : operations.some((operation) => operation.phase === "reply_linked")
          ? "reply_linked"
          : this.#terminalPhase;
    this.#snapshot = {
      ownerKey: this.#ownerKey,
      requestId: this.#latestRequestId,
      phase,
      activeReplies: [...activeRepliesByRunId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    };
  }
}
