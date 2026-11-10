import type { RunStore } from "@ling-stack/core";
import {
  executeConversationSummaryPlan,
  type ConversationSummaryPlan,
  type CoordinateConversationSummaryResult,
  type GenerateConversationSummary,
} from "./conversation-summary-coordinator.js";

export type ConversationSummaryExecutionResult = CoordinateConversationSummaryResult | {
  readonly status: "execution_failed";
  readonly plan: ConversationSummaryPlan;
  readonly error: unknown;
};

/** Coordinates in-process maintenance only; these results are not public DTOs or recovery receipts. */
export class ConversationSummaryExecutionRegistry {
  private readonly flights = new Map<string, Promise<ConversationSummaryExecutionResult>>();

  constructor(private readonly timeoutMs = 20_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      throw new RangeError("Invalid conversation summary execution timeout.");
    }
  }

  get(store: RunStore, plan: ConversationSummaryPlan): Promise<ConversationSummaryExecutionResult> | undefined {
    return this.flights.get(executionKey(store, plan));
  }

  /** Preserve outcomes for every waiter, and retain ownership until the generator actually settles. */
  executeOnce(
    store: RunStore,
    plan: ConversationSummaryPlan,
    generate: GenerateConversationSummary | undefined,
  ): Promise<ConversationSummaryExecutionResult> {
    const key = executionKey(store, plan);
    const existing = this.flights.get(key);
    if (existing) return existing;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error("Conversation summary generation timed out."));
    }, this.timeoutMs);
    timeout.unref?.();
    // Defer entry until registration, including synchronous errors and reentrant generator calls.
    const execution: Promise<ConversationSummaryExecutionResult> = Promise.resolve()
      .then(() => executeConversationSummaryPlan({ store, plan, generate, signal: controller.signal }))
      .catch((error: unknown): ConversationSummaryExecutionResult => ({ status: "execution_failed", plan, error }))
      .finally(() => {
        clearTimeout(timeout);
        if (this.flights.get(key) === execution) this.flights.delete(key);
      });
    this.flights.set(key, execution);
    return execution;
  }
}

function executionKey(store: RunStore, plan: ConversationSummaryPlan): string {
  // Delimiters alone collide when a database path or an identifier contains a colon.
  return JSON.stringify([store.paths.databasePath, plan.projection.metadata.threadId, plan.projection.metadata.segmentId]);
}
