import type {
  LingAppServerGitHubDelivery,
  LingAppServerGitHubEnqueueParams,
  LingAppServerGitHubQueueReceipt,
  LingAppServerGitHubQueueResult,
} from "@ling-stack/contracts";
import type { RunStore } from "@ling-stack/core";
import type { DaemonContext } from "../context.js";
import { HttpError } from "../errors.js";
import { isRecord } from "../shared/validation.js";
import { reconcileGitHubDelivery, readGitHubDelivery } from "./app-server-github-delivery.js";
import { commitSha, digest, gitHubReadClient, GitHubResponseError, type GitHubReadClient } from "./app-server-github-subject.js";
import { appServerRecoveryFor, type AppServerRecoveryJournal } from "./app-server-recovery.js";

type GitHubQueueContext = Pick<DaemonContext, "config" | "secretResolver" | "externalWorkFetch" | "storeRegistry" | "controlPlaneEvents">;

interface QueueIntent {
  readonly fingerprint: string;
  readonly baseRef: string;
  readonly acceptanceId: string;
  readonly receipt: LingAppServerGitHubQueueReceipt;
}

const queueSubjectQuery = `query LingQueueSubject($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    fullDatabaseId nameWithOwner
    pullRequest(number: $number) {
      id number headRefOid baseRefName closed merged isDraft isMergeQueueEnabled isInMergeQueue
      stackEntry { id }
      mergeQueueEntry { id pullRequest { number headRefOid baseRefName } }
      mergeCommit { oid }
    }
  }
}`;

const enqueueMutation = `mutation LingEnqueue($id: ID!, $head: GitObjectID!, $key: String!) {
  enqueuePullRequest(input: {pullRequestId: $id, expectedHeadOid: $head, clientMutationId: $key, jump: false}) {
    clientMutationId
    mergeQueueEntry { id pullRequest { number headRefOid baseRefName } }
  }
}`;

/** Explicit operator admission to an existing provider-enforced merge queue. */
export async function enqueueGitHubDelivery(
  context: GitHubQueueContext, store: RunStore, input: LingAppServerGitHubEnqueueParams,
): Promise<LingAppServerGitHubQueueResult> {
  const cwd = store.paths.cwd;
  const recovery = appServerRecoveryFor(context.config, store);
  if (!recovery) throw new HttpError(409, "github_queue_recovery_required", "Queue admission requires the Host recovery journal.");
  if (input.confirmed !== true || !input.idempotencyKey.trim() || input.idempotencyKey.length > 128 || /[\r\n\0]/u.test(input.idempotencyKey)) {
    throw new HttpError(400, "invalid_params", "Confirm queue admission with a request key.");
  }
  const fingerprint = digest([input.workItemId, input.deliveryId, input.expectedWorkItemRevision, input.idempotencyKey]);
  const keyed = store.findAppServerStateByIdempotencyKey("github_queue_intent", input.idempotencyKey);
  const journalEntry = keyed ? recovery.getGitHubQueueEnqueue(keyed.recordId) : recovery.findGitHubQueueEnqueue(input.idempotencyKey);
  const priorReceiptId = keyed?.recordId ?? journalEntry?.fact.id;
  let retryAfter: string | undefined;
  if (priorReceiptId) {
    if ((keyed && (keyed.payload as QueueIntent).fingerprint !== fingerprint)
      || (journalEntry && journalEntry.fact.fingerprint !== fingerprint)) throw queueKeyConflict();
    const prior = await readGitHubQueue(context, store, input.workItemId, priorReceiptId);
    retryAfter = journalEntry?.fact.rejectedHttpStatus !== undefined && !journalEntry.confirmed ? journalEntry.fact.attemptId : undefined;
    if (prior.receipt.status !== "rejected" || !retryAfter) return prior;
  }
  assertWorkItemReady(store, input.workItemId, input.expectedWorkItemRevision);
  const delivery = readGitHubDelivery(store, input.workItemId);
  const headSha = delivery?.subject.headSha;
  const baseRef = delivery?.subject.baseRef;
  if (!delivery || delivery.deliveryId !== input.deliveryId || !headSha || !baseRef || delivery.subject.state !== "open") {
    throw new HttpError(409, "stale_revision", "Queue admission requires the current delivery receipt for an open pull request.");
  }
  const client = gitHubReadClient(context, cwd, delivery.subject.repository);
  const policy = client.source.deliveryPolicies?.find(current => current.baseRef === baseRef);
  const gate = policy?.mergeQueue?.requiredGate;
  if (!policy || !gate || delivery.policyRevision !== digest([client.source.repositoryId, policy])
    || delivery.subject.repositoryId !== client.source.repositoryId) throw guardUnavailable();
  const queueReceiptId = `github_queue_${digest([delivery.subject.repositoryId, delivery.subject.number, headSha])}`;
  if (priorReceiptId && priorReceiptId !== queueReceiptId) throw queueKeyConflict();
  const receipt: LingAppServerGitHubQueueReceipt = {
    queueReceiptId, workItemId: delivery.workItemId, deliveryId: delivery.deliveryId, repository: delivery.subject.repository,
    repositoryId: delivery.subject.repositoryId, pullRequestNumber: delivery.subject.number, headSha,
    status: "pending", createdAt: journalEntry?.fact.createdAt ?? new Date().toISOString(),
  };
  const subject = await currentQueueSubject(client, receipt, baseRef);
  if (priorReceiptId && (subject?.merged === true || subject?.isInMergeQueue === true)) {
    return readGitHubQueue(context, store, input.workItemId, queueReceiptId);
  }
  if (!subject || typeof subject.id !== "string" || !subject.id || subject.closed !== false || subject.isDraft !== false
    || subject.isMergeQueueEnabled !== true || subject.stackEntry !== null || subject.isInMergeQueue !== false) throw guardUnavailable();
  await requireQueueProtection(client, delivery, gate);
  const fresh = await reconcileGitHubDelivery(context, {
    cwd, workItemId: delivery.workItemId, threadId: delivery.threadId, expectedWorkItemRevision: input.expectedWorkItemRevision,
    repository: delivery.subject.repository, pullRequestNumber: delivery.subject.number, candidateDigest: delivery.candidateDigest,
  }, "clean_checkout");
  if (fresh.deliveryId !== input.deliveryId || fresh.checks.some(({ check, outcome }) => check.basis === "head" && outcome !== "passed")) {
    throw new HttpError(409, "stale_revision", "The delivery or a required head check changed before queue admission.");
  }

  assertWorkItemReady(store, input.workItemId, input.expectedWorkItemRevision);
  if (readGitHubDelivery(store, input.workItemId)?.deliveryId !== input.deliveryId) {
    throw new HttpError(409, "stale_revision", "The delivery changed before queue admission.");
  }
  const known = recovery.getGitHubQueueEnqueue(queueReceiptId);
  if (known && known.fact.fingerprint !== fingerprint) throw queueKeyConflict();
  const intent = { fingerprint, baseRef, acceptanceId: delivery.acceptanceId, receipt };
  const retained = store.putAppServerState({
    kind: "github_queue_intent", recordId: queueReceiptId, idempotencyKey: input.idempotencyKey,
    expectedRevision: 0, replayByIdempotencyKey: true, payload: intent,
  }, receipt.createdAt);
  if (!retained || (retained.record.payload as QueueIntent).fingerprint !== fingerprint) {
    throw queueKeyConflict();
  }
  if (retained.status !== "created" && !retryAfter) return readGitHubQueue(context, store, input.workItemId, queueReceiptId);
  const attemptId = recovery.reserveGitHubQueueEnqueue({
    id: queueReceiptId, workItemId: receipt.workItemId, repository: receipt.repository, repositoryId: receipt.repositoryId, baseRef,
    pullRequestNumber: receipt.pullRequestNumber, headSha, createdAt: receipt.createdAt, deliveryId: receipt.deliveryId,
    acceptanceId: delivery.acceptanceId, fingerprint, idempotencyKey: input.idempotencyKey,
  }, retryAfter);
  if (!attemptId) return readGitHubQueue(context, store, input.workItemId, queueReceiptId);

  const observation = await client.query(enqueueMutation, { id: subject.id, head: headSha, key: queueReceiptId }).catch((error: unknown) => {
    if (error instanceof GitHubResponseError && (error.responseStatus === 401 || error.responseStatus === 429)) {
      recovery.rejectGitHubQueueEnqueue(queueReceiptId, attemptId, error.responseStatus);
    }
    return undefined;
  });
  const accepted = observation?.enqueuePullRequest;
  const entryId = isRecord(accepted) && accepted.clientMutationId === queueReceiptId
    ? readQueueEntryId(accepted.mergeQueueEntry, receipt, baseRef) : undefined;
  if (entryId) recovery.confirmGitHubQueueEnqueue(queueReceiptId);
  const latest = store.getAppServerState("github_queue_intent", queueReceiptId) ?? retained.record;
  const current = latest.payload as QueueIntent;
  if (current.receipt.status === "merged" || (!entryId && current.receipt.status === "enqueued")) {
    return { cwd, receipt: current.receipt };
  }
  return commitQueueStatus(store, current, latest.revision, entryId
    ? { ...receipt, status: "enqueued", queueEntryId: entryId }
    : unresolvedQueueReceipt(receipt, recovery));
}

export async function readGitHubQueue(
  context: GitHubQueueContext, store: RunStore, workItemId: string, queueReceiptId: string,
): Promise<LingAppServerGitHubQueueResult> {
  const recovery = appServerRecoveryFor(context.config, store);
  const fact = recovery?.getGitHubQueueEnqueue(queueReceiptId)?.fact;
  const saved = store.getAppServerState("github_queue_intent", queueReceiptId) ?? (() => {
    const accepted = store.getAppServerState("work_item_acceptance", workItemId)?.payload;
    if (fact?.workItemId !== workItemId || !store.getWorkItem(workItemId) || !isRecord(accepted) || accepted.id !== fact.acceptanceId) return undefined;
    const { repository, repositoryId, deliveryId, pullRequestNumber, headSha, createdAt } = fact;
    return store.putAppServerState({
      kind: "github_queue_intent", recordId: queueReceiptId, idempotencyKey: fact.idempotencyKey, expectedRevision: 0,
      payload: { fingerprint: fact.fingerprint, baseRef: fact.baseRef, acceptanceId: fact.acceptanceId, receipt: {
        queueReceiptId, workItemId, deliveryId, repository, repositoryId, pullRequestNumber, headSha, createdAt, status: "pending",
      } } satisfies QueueIntent,
    }, new Date().toISOString())?.record;
  })();
  const intent = saved?.payload as QueueIntent | undefined;
  if (!saved || !intent || intent.receipt.workItemId !== workItemId) {
    throw new HttpError(404, "github_queue_intent_not_found", "The GitHub queue receipt is unavailable for this Work Item.");
  }
  if (fact && fact.fingerprint !== intent.fingerprint) throw queueKeyConflict();
  if (intent.receipt.status === "merged") return { cwd: store.paths.cwd, receipt: intent.receipt };
  const { queueEntryId: _entry, mergedCommit: _merge, rejectedHttpStatus: _rejected, ...receipt } = intent.receipt;
  const observed = await observeQueueReceipt(context, store, receipt, intent.baseRef);
  if (fact && observed) recovery?.confirmGitHubQueueEnqueue(queueReceiptId);
  return commitQueueStatus(store, intent, saved.revision, observed ?? unresolvedQueueReceipt(receipt, recovery));
}

export function gitHubQueueReceiptConfirmed(store: RunStore, fact: {
  readonly id: string; readonly workItemId: string; readonly repositoryId: string;
  readonly pullRequestNumber: number; readonly headSha: string; readonly acceptanceId: string;
}): boolean {
  const intent = store.getAppServerState("github_queue_intent", fact.id)?.payload as QueueIntent | undefined;
  const receipt = intent?.receipt;
  return intent?.acceptanceId === fact.acceptanceId && receipt?.workItemId === fact.workItemId
    && receipt.repositoryId === fact.repositoryId && receipt.pullRequestNumber === fact.pullRequestNumber
    && receipt.headSha === fact.headSha && (receipt.status === "enqueued" || receipt.status === "merged");
}

async function observeQueueReceipt(
  context: GitHubQueueContext, store: RunStore, receipt: LingAppServerGitHubQueueReceipt, baseRef: string,
): Promise<LingAppServerGitHubQueueReceipt | undefined> {
  const client = gitHubReadClient(context, store.paths.cwd, receipt.repository);
  const current = await currentQueueSubject(client, receipt, baseRef).catch(() => undefined);
  const mergedCommit = current?.merged === true && isRecord(current.mergeCommit) ? commitSha(current.mergeCommit.oid) : undefined;
  if (mergedCommit) return { ...receipt, status: "merged", mergedCommit };
  const queueEntryId = current?.isInMergeQueue === true ? readQueueEntryId(current.mergeQueueEntry, receipt, baseRef) : undefined;
  if (queueEntryId) return { ...receipt, status: "enqueued", queueEntryId };
  return undefined;
}

function unresolvedQueueReceipt(
  receipt: LingAppServerGitHubQueueReceipt, recovery: AppServerRecoveryJournal | undefined,
): LingAppServerGitHubQueueReceipt {
  const entry = recovery?.getGitHubQueueEnqueue(receipt.queueReceiptId);
  const rejectedHttpStatus = entry && !entry.confirmed ? entry.fact.rejectedHttpStatus : undefined;
  return rejectedHttpStatus === undefined ? { ...receipt, status: "unknown" } : { ...receipt, status: "rejected", rejectedHttpStatus };
}

function commitQueueStatus(store: RunStore, intent: QueueIntent, revision: number, receipt: LingAppServerGitHubQueueReceipt): LingAppServerGitHubQueueResult {
  const { queueReceiptId } = receipt;
  if (JSON.stringify(receipt) === JSON.stringify(intent.receipt)) return { cwd: store.paths.cwd, receipt };
  const committed = store.putAppServerState({
    kind: "github_queue_intent", recordId: queueReceiptId, expectedRevision: revision, payload: { ...intent, receipt },
  }, new Date().toISOString());
  const latest = committed?.record ?? store.getAppServerState("github_queue_intent", queueReceiptId);
  if (!latest) throw new HttpError(409, "unknown_outcome", "The queue receipt could not be confirmed.");
  return { cwd: store.paths.cwd, receipt: (latest.payload as QueueIntent).receipt };
}

function assertWorkItemReady(store: RunStore, id: string, revision: number): void {
  const item = store.getWorkItem(id);
  if (!item || item.revision !== revision) throw new HttpError(409, "stale_revision", "The Work Item revision changed.");
  if (item.control.state !== "active" || item.control.unresolvedEffectIds.length || item.holds.some(hold => hold.blocksNewAdmission)
    || !["ready", "running", "review"].includes(item.status)) {
    throw new HttpError(409, "work_item_delivery_held", "The Work Item is holding new delivery actions.");
  }
}

async function currentQueueSubject(client: GitHubReadClient, receipt: LingAppServerGitHubQueueReceipt, baseRef: string) {
  const [owner, name] = receipt.repository.split("/");
  const facts = await client.query(queueSubjectQuery, { owner: owner!, name: name!, number: receipt.pullRequestNumber });
  const repo = facts?.repository;
  if (!isRecord(repo) || String(repo.fullDatabaseId) !== receipt.repositoryId || typeof repo.nameWithOwner !== "string"
    || repo.nameWithOwner.toLowerCase() !== receipt.repository || !isRecord(repo.pullRequest)
    || !samePullRequest(repo.pullRequest, receipt, baseRef)) return undefined;
  return repo.pullRequest;
}

function samePullRequest(data: Record<string, unknown>, receipt: LingAppServerGitHubQueueReceipt, baseRef: string): boolean {
  return data.number === receipt.pullRequestNumber && data.headRefOid === receipt.headSha && data.baseRefName === baseRef;
}

function readQueueEntryId(value: unknown, receipt: LingAppServerGitHubQueueReceipt, baseRef: string): string | undefined {
  return isRecord(value) && typeof value.id === "string" && value.id.trim() && value.id.length <= 256
    && isRecord(value.pullRequest) && samePullRequest(value.pullRequest, receipt, baseRef) ? value.id : undefined;
}

async function requireQueueProtection(
  client: GitHubReadClient, delivery: LingAppServerGitHubDelivery, gate: { readonly name: string; readonly appId: number },
): Promise<void> {
  const branch = encodeURIComponent(delivery.subject.baseRef!);
  const rules = await client.list(`/rules/branches/${branch}?per_page=100`, 100).catch(() => undefined);
  if (!rules || rules.length >= 100 || !rules.some(rule => rule.type === "merge_queue")) throw guardUnavailable();
  const checks = rules.flatMap(rule => rule.type === "required_status_checks" && isRecord(rule.parameters)
    && Array.isArray(rule.parameters.required_status_checks) ? rule.parameters.required_status_checks.filter(isRecord) : []);
  for (const { name, appId } of [gate, ...delivery.checks.map(check => check.check)]) {
    const matching = checks.filter(check => check.context === name);
    if (!matching.length || matching.some(check => check.integration_id !== appId)) throw guardUnavailable();
  }
}

function guardUnavailable(): HttpError {
  return new HttpError(409, "github_queue_guard_unavailable", "The repository has no matching provider-enforced merge queue and trusted CI gate.");
}

function queueKeyConflict(): HttpError {
  return new HttpError(409, "idempotency_conflict", "A different queue request owns this key or pull request head.");
}
