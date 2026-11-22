import type { LingAppServerGitHubDelivery, LingAppServerReconcileGitHubDeliveryParams } from "@ling-stack/contracts";
import type { RunStore, WorkItemAcceptanceReceipt } from "@ling-stack/core";
import type { DaemonContext } from "../context.js";
import { HttpError } from "../errors.js";
import { captureCodeAssessmentSnapshot } from "../features/code-assessments/snapshot.js";
import { trimOversizedEvent } from "../features/control-plane/events.js";
import { observeGitHubDelivery } from "./app-server-github-ci.js";
import { digest, gitHubReadClient, gitHubWorkItemTargetKey } from "./app-server-github-subject.js";
import { appServerRecoveryFor } from "./app-server-recovery.js";

export function readGitHubDelivery(store: RunStore, workItemId: string, deliveryId?: string): LingAppServerGitHubDelivery | undefined {
  const record = deliveryId
    ? store.getAppServerState("github_delivery", deliveryId)
    : store.getAppServerState("github_delivery_current", workItemId);
  const delivery = record?.payload as LingAppServerGitHubDelivery | undefined;
  return delivery?.workItemId === workItemId ? delivery : undefined;
}

export async function reconcileGitHubDelivery(
  context: Pick<DaemonContext, "storeRegistry" | "config" | "externalWorkFetch" | "secretResolver" | "controlPlaneEvents">,
  params: LingAppServerReconcileGitHubDeliveryParams & { readonly cwd: string },
): Promise<LingAppServerGitHubDelivery> {
  const { cwd, threadId, workItemId, expectedWorkItemRevision, candidateDigest, repository, pullRequestNumber } = params;
  const store = context.storeRegistry.getStore(cwd);
  const workItem = store.getWorkItem(workItemId);
  const acceptance = store.getAppServerState("work_item_acceptance", workItemId)?.payload as WorkItemAcceptanceReceipt | undefined;
  const thread = store.getLingThread(threadId);
  if (!workItem || !acceptance || !thread || thread.archivedAt || thread.workspaceId !== workItem.workspaceId) {
    throw new HttpError(404, "github_delivery_binding_unavailable", "Delivery requires an accepted Work Item and a current Thread.");
  }
  if (workItem.revision !== expectedWorkItemRevision) {
    throw new HttpError(409, "stale_revision", "The Work Item revision changed before delivery reconciliation.");
  }
  const client = gitHubReadClient(context, cwd, repository);
  const previous = store.getAppServerState("github_delivery_current", workItemId);
  const capture = () => captureCodeAssessmentSnapshot(cwd, { type: "working_tree" });
  const candidate = await capture();
  if (candidate.coverage !== "complete" || candidate.totalFileCount !== 0 || candidate.digest !== candidateDigest) {
    throw new HttpError(409, "candidate_stale", "Delivery requires the current committed candidate with full capture coverage.");
  }
  const observation = await observeGitHubDelivery(client, pullRequestNumber, previous?.payload as LingAppServerGitHubDelivery | undefined);
  if (observation.subject.headSha !== candidate.headSha || (await capture()).digest !== candidateDigest) {
    throw new HttpError(409, "candidate_stale", "The committed candidate differs from the observed pull request head.");
  }
  const frozen = { workItemId, threadId, acceptanceId: acceptance.id, candidateDigest, ...observation };
  const delivery = { ...frozen, deliveryId: `github_delivery_${digest(frozen)}`, observedAt: new Date().toISOString() };
  const recovery = appServerRecoveryFor(context.config, store);
  try {
    const result = store.commitWorkItemGitHubDelivery({
      delivery, targetKey: gitHubWorkItemTargetKey(observation.subject), expectedWorkItemRevision,
      expectedDeliveryRevision: previous?.revision ?? 0,
    }, cwd, recovery && (receipt => recovery.recordGitHubDelivery(receipt)));
    if (result.event) context.controlPlaneEvents.publish(trimOversizedEvent(result.event));
    return result.delivery;
  } catch (error) {
    if (error instanceof Error && error.message === "github_delivery_stale") {
      throw new HttpError(409, "stale_revision", "Delivery or Work Item revision changed during reconciliation.");
    }
    if (error instanceof Error && error.message === "github_delivery_binding_conflict") {
      throw new HttpError(409, "github_delivery_binding_conflict", "The pull request or Thread has a different delivery owner.");
    }
    throw error;
  }
}
