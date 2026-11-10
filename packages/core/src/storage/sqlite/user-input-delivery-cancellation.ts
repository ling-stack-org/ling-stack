import type { UserInputRequest } from "../../user-input-store-types.js";
import { UserInputStoreError } from "../../user-input-store-types.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { SqliteControlPlaneStore } from "./control-plane-store.js";
import { mapUserInputDelivery } from "./user-input-delivery-records.js";

/** Called only by the logical-wait cancellation writer; never owns/commits its transaction. */
export function obsoleteUserInputDeliveriesForCancelledWait(
  context: SqliteStoreContext, events: SqliteControlPlaneStore, request: UserInputRequest, now: string,
): void {
  const { database } = context;
  const rows = database.prepare("SELECT d.*, a.request_id, a.request_version, ? AS thread_id FROM user_input_deliveries d"
    + " JOIN user_input_answers a ON a.answer_id=d.answer_id WHERE a.request_id=?")
    .all(request.source.threadId, request.requestId);
  for (const row of rows) {
    // Existing malformed claimed rows and applied receipts stay blocked. No compatibility release.
    if (row.consumer_work_unit_id !== request.source.fence.workUnitId || row.status === "applied"
      || (row.status === "claimed" && (!row.claim_token || !row.successor_run_id))) throw new UserInputStoreError("source_conflict");
    const delivery = mapUserInputDelivery(row);
    if (delivery.successorRunId && database.prepare("SELECT 1 FROM run_sessions WHERE id=?").get(delivery.successorRunId)) {
      throw new UserInputStoreError("source_conflict");
    }
    if (delivery.status === "obsolete") continue;
    if (Date.parse(now) < Date.parse(delivery.updatedAt)) throw new UserInputStoreError("source_conflict");
    const changed = database.prepare("UPDATE user_input_deliveries SET status='obsolete',status_revision=status_revision+1,updated_at=?,"
      + " claim_owner_id=NULL,claim_token=NULL,claim_expires_at=NULL,retry_at=NULL WHERE delivery_id=? AND status_revision=?")
      .run(now, delivery.deliveryId, delivery.revision);
    if (Number(changed.changes) !== 1) throw new UserInputStoreError("source_conflict");
    events.appendControlPlaneEventWithinTransaction({
      workspaceId: request.source.workspaceId, cwd: request.source.cwd, domain: "runs", entityType: "user_input_delivery",
      entityId: delivery.deliveryId, action: "obsolete",
      idempotencyKey: "user-input-delivery:" + delivery.deliveryId + ":" + (delivery.revision + 1),
      data: { threadId: request.source.threadId, requestId: request.requestId, deliveryId: delivery.deliveryId,
        revision: delivery.revision + 1, reason: "user_input_wait_cancelled" },
    }, now);
  }
}
