import {
  REMOTE_CONVERSATION_AUTHORITY_CONTEXT,
  type RemoteDispatchIntent,
  type RunStore,
} from "@ling-stack/core";

type RemoteDispatchStore = Pick<
  RunStore,
  | "listRemoteDispatchIntents"
  | "claimRemoteDispatchIntent"
  | "completeRemoteDispatchIntent"
  | "failRemoteDispatchIntent"
>;

export interface RemoteReplyDispatcher {
  /** Must be idempotent by intent.id and enforce the supplied server-owned authority. */
  dispatch(intent: RemoteDispatchIntent): void | Promise<void>;
}

export interface RemoteDispatchWorkerOptions {
  readonly store: RemoteDispatchStore;
  readonly dispatcher: RemoteReplyDispatcher;
  readonly workerId: string;
  readonly now?: () => string;
  readonly claimTtlMs?: number;
  readonly retryDelayMs?: number;
}

/** Claims durable intents in order and reconciles them after daemon restarts. */
export class RemoteDispatchWorker {
  private readonly now: () => string;
  private readonly claimTtlMs: number;
  private readonly retryDelayMs: number;

  constructor(private readonly options: RemoteDispatchWorkerOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.claimTtlMs = Math.min(Math.max(options.claimTtlMs ?? 60_000, 5_000), 5 * 60_000);
    this.retryDelayMs = Math.min(Math.max(options.retryDelayMs ?? 5_000, 1_000), 5 * 60_000);
  }

  async drainBatch(limit = 50): Promise<{ readonly dispatched: number; readonly failed: number; readonly skipped: number }> {
    const intents = this.options.store.listRemoteDispatchIntents({
      statuses: ["pending", "failed", "claimed"],
      limit: Math.min(Math.max(limit, 1), 200),
    });
    let dispatched = 0;
    let failed = 0;
    let skipped = 0;
    for (const intent of intents) {
      assertRemoteAuthority(intent);
      const claimNow = this.now();
      const claimed = this.options.store.claimRemoteDispatchIntent(intent.id, {
        workerId: this.options.workerId,
        claimExpiresAt: new Date(Date.parse(claimNow) + this.claimTtlMs).toISOString(),
      }, claimNow);
      if (!claimed) {
        skipped += 1;
        continue;
      }
      try {
        await this.options.dispatcher.dispatch(claimed);
        const completed = this.options.store.completeRemoteDispatchIntent(claimed.id, this.now());
        if (!completed) {
          throw new Error(`Remote dispatch completion lost for intent: ${claimed.id}`);
        }
        dispatched += 1;
      } catch (error) {
        const failureNow = this.now();
        const retryAt = new Date(Date.parse(failureNow) + this.retryDelayMs).toISOString();
        this.options.store.failRemoteDispatchIntent(
          claimed.id,
          error instanceof Error ? error.message : String(error),
          retryAt,
          failureNow,
        );
        failed += 1;
      }
    }
    return { dispatched, failed, skipped };
  }
}

function assertRemoteAuthority(intent: RemoteDispatchIntent): void {
  const authority = intent.authority;
  const expected = REMOTE_CONVERSATION_AUTHORITY_CONTEXT;
  if (
    authority.sourceSurface !== expected.sourceSurface
    || authority.authorityCeiling !== expected.authorityCeiling
    || authority.allowAiReply !== expected.allowAiReply
    || authority.allowToolCalls !== expected.allowToolCalls
    || authority.allowWorkflowAutoStart !== expected.allowWorkflowAutoStart
    || authority.allowExecutionProposal !== expected.allowExecutionProposal
  ) {
    throw new Error(`Remote dispatch authority drift detected for intent: ${intent.id}`);
  }
}
