import type { RemoteProjectionOutboxRecord, RunStore } from "@ling-stack/core";
import type { RemoteConversationFacade, RemoteProjectedEvent } from "./conversation-facade.js";

type RemoteOutboxStore = Pick<RunStore, "listRemoteProjectionOutbox" | "markRemoteProjectionOutboxProcessed">;

export interface RemoteProjectionPublisher {
  publish(event: RemoteProjectedEvent, source: RemoteProjectionOutboxRecord): void | Promise<void>;
}

/** Startup-safe, ordered outbox drain. A row is acknowledged only after all projections publish. */
export class RemoteProjectionOutboxWorker {
  constructor(
    private readonly store: RemoteOutboxStore,
    private readonly facade: Pick<RemoteConversationFacade, "projectOutboxRecord">,
    private readonly publisher: RemoteProjectionPublisher,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async drainBatch(limit = 200): Promise<{ readonly processed: number; readonly published: number; readonly hasMore: boolean }> {
    const boundedLimit = Math.min(Math.max(limit, 1), 1_000);
    const rows = this.store.listRemoteProjectionOutbox({ unprocessedOnly: true, limit: boundedLimit });
    let processed = 0;
    let published = 0;
    for (const row of rows) {
      const events = this.facade.projectOutboxRecord(row);
      for (const event of events) {
        await this.publisher.publish(event, row);
        published += 1;
      }
      const marked = this.store.markRemoteProjectionOutboxProcessed([row.activitySeq], this.now());
      if (marked !== 1) {
        throw new Error(`Remote projection outbox acknowledgement lost for activity ${row.activitySeq}`);
      }
      processed += 1;
    }
    return { processed, published, hasMore: rows.length === boundedLimit };
  }

  async drainUntilIdle(limit = 200): Promise<{ readonly processed: number; readonly published: number }> {
    let processed = 0;
    let published = 0;
    while (true) {
      const batch = await this.drainBatch(limit);
      processed += batch.processed;
      published += batch.published;
      if (!batch.hasMore) {
        return { processed, published };
      }
    }
  }
}
