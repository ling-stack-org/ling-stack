import type {
  LingAppServerGitHubIntakePolicy,
  LingAppServerGitHubIntakePolicyList,
  LingAppServerGitHubIntakePollResult,
  LingAppServerGitHubIntakeReceipt,
  LingAppServerGitHubSubject,
  LingAppServerGitHubIntakeQuietHours,
} from "@ling-stack/contracts";
import { LING_AGENT_ID, type AutomationEventEnvelope, type AutomationEventSource, type AutomationGitHubIntakePending,
  type AutomationGitHubIntakeTarget, type GitHubIntakeDispatchIntent, type GitHubIntakeOccurrence, type RunStore,
  type WorkItemAcceptanceReceipt } from "@ling-stack/core";
import type { DaemonContext } from "../context.js";
import { HttpError } from "../errors.js";
import { prepareConversationSubmission, publishPreparedConversationTurn } from "../features/conversations/conversation-submission.js";
import { trimOversizedEvent } from "../features/control-plane/events.js";
import type { RunRequest } from "../features/runs/schemas.js";
import { isRecord } from "../shared/validation.js";
import { assertGitHubRepository, digest, gitHubReadClient, gitHubWorkItemTargetKey, readAppServerGitHubSubject } from "./app-server-github-subject.js";
import { githubRepositoryPattern, type AppServerGitHubSourceConfig } from "./app-server-github-sources.js";

type IntakeContext = Pick<DaemonContext, "config" | "secretResolver" | "externalWorkFetch" | "controlPlaneEvents">;
type IntakeSubject = Pick<LingAppServerGitHubSubject, "githubInstanceId" | "repository" | "repositoryId" | "kind" | "number" | "title" | "state" | "labels">;
type ReceiptBasis = Omit<LingAppServerGitHubIntakeReceipt, "outcome" | "reasonCode" | "workItemId">;
const defaultPolicy: LingAppServerGitHubIntakePolicy = { mode: "manual", enabled: true };
const pageSize = 20;

function policyRevision(source: AppServerGitHubSourceConfig): string {
  return digest([source.repositoryId, source.intake ?? defaultPolicy]);
}

export function gitHubWebhookIntakeTarget(
  context: Pick<DaemonContext, "config">, cwd: string, source: AutomationEventSource,
  envelope: Pick<AutomationEventEnvelope, "type" | "payload">,
): AutomationGitHubIntakeTarget | undefined {
  if (source.adapter !== "github") return undefined;
  const configured = context.config.appServerGitHubSources.find(item => item.workspaceRoot === cwd
    && item.repository === source.repository?.toLowerCase() && item.intake?.webhookSourceId === source.id);
  if (!configured) return undefined;
  const repository = envelope.payload.repository;
  if (!isRecord(repository) || String(repository.id) !== configured.repositoryId) {
    throw new HttpError(403, "github_intake_repository_mismatch", "The signed event repository differs from the configured identity.");
  }
  const pr = envelope.payload.pull_request;
  const issue = envelope.payload.issue;
  const item = isRecord(pr) ? pr : issue;
  if (!isRecord(item) || typeof item.number !== "number" || !Number.isSafeInteger(item.number) || item.number < 1) return undefined;
  return { repository: configured.repository, kind: isRecord(pr) || isRecord(item.pull_request) ? "pull_request" : "issue",
    number: item.number, policyRevision: policyRevision(configured) };
}

export function gitHubIntakeReceiptId(origin: LingAppServerGitHubIntakeReceipt["origin"], sourceEventId: string): string {
  return `github_intake_${digest([origin, sourceEventId])}`;
}

export function listGitHubIntakePolicies(
  context: Pick<IntakeContext, "config">, store: RunStore,
): LingAppServerGitHubIntakePolicyList {
  const cwd = store.paths.cwd;
  return { cwd, sources: context.config.appServerGitHubSources.filter(source => source.workspaceRoot === cwd).map(source => {
    const policy = source.intake ?? defaultPolicy;
    return { repository: source.repository, revision: policyRevision(source), policy,
      ...(policy.mode === "auto_start" ? { providerAvailable: store.getProviderPreset(policy.providerPresetId)?.enabled === true } : {}) };
  }) };
}

export async function pollGitHubIntake(context: IntakeContext, store: RunStore, input: Record<string, unknown>): Promise<LingAppServerGitHubIntakePollResult> {
  const { repository, page = 1, retryKey } = input;
  if (typeof repository !== "string" || !githubRepositoryPattern.test(repository)
    || typeof page !== "number" || !Number.isSafeInteger(page) || page < 1 || page > 500
    || retryKey !== undefined && (typeof retryKey !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/u.test(retryKey))) {
    throw new HttpError(400, "invalid_params", "Supply a registered GitHub repository and a positive page.");
  }
  const cwd = store.paths.cwd;
  const client = gitHubReadClient(context, cwd, repository.toLowerCase());
  const { source } = client;
  const policy = source.intake ?? defaultPolicy;
  const revision = policyRevision(source);
  const [repo, items] = await Promise.all([client.get(""), client.list(`/issues?state=open&per_page=${pageSize}&page=${page}`, pageSize)]);
  assertGitHubRepository(client, repo);
  const receipts = items.map(item => {
    if (typeof item.number !== "number" || !Number.isSafeInteger(item.number) || item.number < 1
      || typeof item.title !== "string" || !item.title.trim() || item.state !== "open" && item.state !== "closed") {
      throw new HttpError(502, "github_observation_invalid", "GitHub returned an invalid issue or pull request.");
    }
    const subject: IntakeSubject = {
      githubInstanceId: "github.com", repositoryId: source.repositoryId, repository: source.repository,
      kind: isRecord(item.pull_request) ? "pull_request" : "issue", number: item.number, title: item.title,
      state: item.state,
      labels: Array.isArray(item.labels) ? item.labels.slice(0, 100).flatMap(label =>
        isRecord(label) && typeof label.name === "string" ? [label.name.slice(0, 80)] : []) : [],
    };
    const sourceEventId = `poll_${digest([subject, item.updated_at, revision])}`;
    let basis = receiptBasis("poll", sourceEventId, subject, revision);
    const prior = retryKey ? readReceipt(store, basis.receiptId) : undefined;
    if (prior && ["quiet_hours", "start_budget_exhausted", "concurrency_limit", "work_item_held"].includes(prior.reasonCode)) {
      basis = receiptBasis("poll", `poll_${digest([sourceEventId, retryKey])}`, subject, revision);
    }
    return evaluateGitHubIntake(context, store, basis, policy, subject);
  });
  return { cwd, receipts, ...(items.length === pageSize && page < 500 ? { nextPage: page + 1 } : {}) };
}

export function readGitHubIntake(store: RunStore, receiptId: unknown): LingAppServerGitHubIntakeReceipt {
  if (typeof receiptId !== "string" || !/^github_intake_[a-f0-9]{64}$/u.test(receiptId)) {
    throw new HttpError(400, "invalid_params", "Supply a valid GitHub intake receipt ID.");
  }
  const result = readReceipt(store, receiptId);
  if (!result) throw new HttpError(404, "intake_receipt_not_found", "The GitHub intake receipt is unavailable.");
  return result;
}

export async function processGitHubWebhookIntake(context: IntakeContext, store: RunStore, signal: AbortSignal): Promise<void> {
  const now = Date.now();
  const pending = store.listAppServerState("github_intake_pending").reverse().filter(record =>
    record.revision === 1 || Date.parse(record.updatedAt) + 2000 * 2 ** (record.revision - 1) <= now).slice(0, 4);
  for (const record of pending) {
    signal.throwIfAborted();
    const target = record.payload as AutomationGitHubIntakePending;
    const basis = receiptBasis("webhook", target.sourceEventId, target, target.policyRevision);
    if (!readReceipt(store, basis.receiptId)) {
      const source = context.config.appServerGitHubSources.find(item => item.workspaceRoot === store.paths.cwd
        && item.repository === target.repository && item.intake?.webhookSourceId === target.sourceId);
      const current = () => {
        const eventSource = store.getAutomationEventSource(target.sourceId);
        return source && policyRevision(source) === target.policyRevision && eventSource?.enabled && eventSource.revision === target.sourceRevision;
      };
      if (!current()) {
        saveReceipt(store, { ...basis, outcome: "paused", reasonCode: "source_authority_changed" });
      } else {
        try {
          const client = gitHubReadClient(context, store.paths.cwd, target.repository);
          const subject = await readAppServerGitHubSubject(client, target);
          signal.throwIfAborted();
          if (!current()) saveReceipt(store, { ...basis, outcome: "paused", reasonCode: "source_authority_changed" });
          else evaluateGitHubIntake(context, store, basis, source?.intake ?? defaultPolicy, subject,
            { sourceId: target.sourceId, sourceRevision: target.sourceRevision });
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof HttpError && error.statusCode === 404) {
            saveReceipt(store, { ...basis, outcome: "suppressed", reasonCode: "subject_unavailable" });
          } else if (record.revision >= 5) {
            saveReceipt(store, { ...basis, outcome: "paused", reasonCode: "github_observation_unavailable" });
          } else {
            store.putAppServerState({ kind: "github_intake_pending", recordId: record.recordId,
              expectedRevision: record.revision, payload: target }, new Date().toISOString());
            continue;
          }
        }
      }
    }
    store.deleteAppServerState("github_intake_pending", record.recordId);
  }
}

function receiptBasis(
  origin: ReceiptBasis["origin"], sourceEventId: string,
  { repository, kind, number }: Pick<IntakeSubject, "repository" | "kind" | "number">, policyRevision: string,
): ReceiptBasis {
  return { receiptId: gitHubIntakeReceiptId(origin, sourceEventId), sourceEventId, origin, repository,
    policyRevision, subject: { kind, number }, evaluatedAt: new Date().toISOString() };
}

function evaluateGitHubIntake(context: IntakeContext, store: RunStore, basis: ReceiptBasis,
  policy: LingAppServerGitHubIntakePolicy, subject: IntakeSubject,
  webhook?: NonNullable<GitHubIntakeOccurrence["automatic"]>["webhook"],
): LingAppServerGitHubIntakeReceipt {
  const retained = readReceipt(store, basis.receiptId);
  if (retained) return retained;
  if (!policy.enabled) return saveReceipt(store, { ...basis, outcome: "paused", reasonCode: "policy_disabled" });
  if (subject.state !== "open") return saveReceipt(store, { ...basis, outcome: "suppressed", reasonCode: "subject_closed" });
  if (policy.requiredLabel && !subject.labels?.includes(policy.requiredLabel)) {
    return saveReceipt(store, { ...basis, outcome: "suppressed", reasonCode: "required_label_missing" });
  }
  if (policy.mode === "manual") return saveReceipt(store, { ...basis, outcome: "manual", reasonCode: "manual_intake" });
  if (policy.mode === "auto_start" && isQuiet(policy.quietHours, new Date(basis.evaluatedAt))) {
    return saveReceipt(store, { ...basis, outcome: "suppressed", reasonCode: "quiet_hours" });
  }
  const result = store.createWorkItem({
    sourceType: "external_work", sourceId: basis.receiptId, title: subject.title.slice(0, 500), initialStatus: "intake",
    priority: policy.priority ?? "normal", verifiedTargetKey: gitHubWorkItemTargetKey(subject),
    description: `GitHub ${subject.kind} ${subject.repository}#${subject.number}`,
    gitHubIntake: { ...basis, ...(policy.mode === "auto_start" ? { automatic: {
      repositoryId: subject.repositoryId, budget: policy.budget, webhook,
    } } : {}) },
  }, basis.evaluatedAt, store.paths.cwd);
  if (result.event) context.controlPlaneEvents.publish(trimOversizedEvent(result.event));
  if (!result.gitHubIntakeReceipt) throw new HttpError(409, "intake_conflict", "The GitHub intake receipt was not committed.");
  return result.gitHubIntakeReceipt;
}

function isQuiet(quiet: LingAppServerGitHubIntakeQuietHours | undefined, now: Date): boolean {
  if (!quiet) return false;
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: quiet.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  return quiet.start < quiet.end ? time >= quiet.start && time < quiet.end : time >= quiet.start || time < quiet.end;
}

export async function dispatchGitHubIntake(
  context: Pick<DaemonContext, "config" | "controlPlaneEvents" | "runnerRegistry" | "imageVisionSummarizer">,
  store: RunStore, signal: AbortSignal,
  startRun: (request: RunRequest, admission: { readonly receiptId: string; readonly assertCurrent: () => void }) => Promise<string | undefined>,
): Promise<void> {
  const eligibleBefore = new Date(Date.now() - 4_000).toISOString();
  for (const record of store.listPendingGitHubIntakeDispatches(eligibleBefore, 4)) {
    signal.throwIfAborted();
    const intent = record.payload as GitHubIntakeDispatchIntent;
    const complete = (status: GitHubIntakeDispatchIntent["status"], reasonCode?: string, runId?: string) => {
      const publication = status === intent.status && reasonCode === intent.reasonCode ? undefined : {
        workspaceId: record.workspaceId, cwd: store.paths.cwd, domain: "work_items" as const,
        entityType: "work_item", entityId: intent.workItemId, action: "work_item.intake.dispatch.updated",
        data: { workItemId: intent.workItemId, receiptId: intent.receiptId, status, reasonCode },
      };
      const saved = store.putAppServerState({ kind: "github_intake_dispatch", recordId: record.recordId, expectedRevision: record.revision,
        payload: { ...intent, status, reasonCode, runId } }, new Date().toISOString(), publication);
      if (saved?.event) context.controlPlaneEvents.publish(trimOversizedEvent(saved.event));
    };
    const workItem = store.getWorkItem(intent.workItemId);
    if (workItem?.runId) {
      complete("admitted", undefined, workItem.runId);
      continue;
    }
    const source = context.config.appServerGitHubSources.find(source => source.workspaceRoot === store.paths.cwd
      && source.repository === intent.repository && source.repositoryId === intent.repositoryId);
    const policy = source?.intake;
    const sourceIsCurrent = () => {
      if (!source || policy?.mode !== "auto_start" || !policy.enabled || policyRevision(source) !== intent.policyRevision) return false;
      if (!intent.webhook) return true;
      const webhook = store.getAutomationEventSource(intent.webhook.sourceId);
      return webhook?.enabled === true && webhook.revision === intent.webhook.sourceRevision;
    };
    if (!workItem || !sourceIsCurrent() || policy?.mode !== "auto_start"
      || ["done", "cancelled", "superseded", "archived"].includes(workItem.status)) {
      complete("held", "intake_authority_changed");
      continue;
    }
    if (isQuiet(policy.quietHours, new Date()) || workItem.control.state !== "active" || workItem.holds.some(hold => hold.blocksNewAdmission)) {
      complete("pending", "intake_temporarily_held");
      continue;
    }
    if (!store.getProviderPreset(policy.providerPresetId)?.enabled) {
      complete("pending", "intake_provider_unavailable");
      continue;
    }
    const receipt = readReceipt(store, intent.receiptId);
    if (!receipt || receipt.outcome !== "accepted" || receipt.workItemId !== workItem.id) {
      complete("held", "intake_receipt_unavailable");
      continue;
    }
    try {
      const assertCurrent = () => {
        signal.throwIfAborted();
        if (!sourceIsCurrent() || isQuiet(policy.quietHours, new Date())) {
          throw new HttpError(409, "intake_authority_changed", "GitHub intake authority changed before Run admission.");
        }
      };
      assertCurrent();
      const original = store.getAppServerState("work_item_acceptance", workItem.id)?.payload as WorkItemAcceptanceReceipt | undefined;
      if (original && original.idempotencyKey !== receipt.receiptId) {
        complete("held", "work_item_already_assigned");
        continue;
      }
      const { kind, number } = receipt.subject;
      const title = `GitHub ${receipt.repository}#${number}`;
      const threadId = original?.dispatch?.threadId ?? `thread_github_${digest(workItem.id)}`;
      const thread = store.getLingThread(threadId) ?? store.createLingThread({
        id: threadId, kind: "conversation", status: "open", title, objective: title,
      }, receipt.evaluatedAt);
      const message = `Review the authorized GitHub ${kind} ${receipt.repository}#${number} for this project. Use its title `
        + `${JSON.stringify(workItem.title)} as source data. Check the requirements against the repository and propose a scoped plan or ask for clarification.`;
      const acceptance = store.acceptWorkItem(workItem.id, {
        expectedRevision: original?.acceptedRevision ?? workItem.revision, actorId: LING_AGENT_ID, idempotencyKey: receipt.receiptId,
        dispatch: original?.dispatch ?? { threadId, message, providerPresetId: policy.providerPresetId },
      }, new Date().toISOString());
      if (!acceptance?.receipt.dispatch || acceptance.receipt.idempotencyKey !== receipt.receiptId) {
        complete("pending", "work_item_admission_changed");
        continue;
      }
      if (acceptance.event) context.controlPlaneEvents.publish(trimOversizedEvent(acceptance.event));
      const dispatch = acceptance.receipt.dispatch;
      const prepared = await prepareConversationSubmission({ store, workspaceCwd: store.paths.cwd, runnerRegistry: context.runnerRegistry,
        resolveThread: () => thread, input: { threadId, providerPresetId: dispatch.providerPresetId, message: dispatch.message,
          idempotencyKey: dispatch.submissionKey, workspaceAccessMode: "read_only", tools: ["read", "grep", "find", "ls"] },
        automaticIntakeReceiptId: receipt.receiptId, imageVisionSummarizer: context.imageVisionSummarizer, now: new Date().toISOString() });
      assertCurrent();
      publishPreparedConversationTurn(store, context.controlPlaneEvents, prepared.turn);
      const runId = prepared.turn.activeRunId ?? prepared.turn.lastRunId ?? await startRun(prepared.runRequest, { receiptId: receipt.receiptId, assertCurrent });
      if (runId) complete("admitted", undefined, runId);
      else complete("pending", "work_item_admission_pending");
    } catch (error) {
      signal.throwIfAborted();
      const reason = error instanceof HttpError ? error.code : "work_item_admission_pending";
      if (reason === "duplicate_work_unit") complete("held", "intake_dispatch_reconciliation_required");
      else complete("pending", reason);
    }
  }
}

function readReceipt(store: RunStore, receiptId: string): LingAppServerGitHubIntakeReceipt | undefined {
  return store.getAppServerState("github_intake_receipt", receiptId)?.payload as LingAppServerGitHubIntakeReceipt | undefined;
}

function saveReceipt(store: RunStore, receipt: LingAppServerGitHubIntakeReceipt): LingAppServerGitHubIntakeReceipt {
  const saved = store.putAppServerState({
    kind: "github_intake_receipt", recordId: receipt.receiptId, expectedRevision: 0, payload: receipt,
  }, receipt.evaluatedAt);
  const retained = saved ? receipt : readReceipt(store, receipt.receiptId);
  if (!retained) throw new HttpError(409, "intake_conflict", "The GitHub intake receipt changed during evaluation.");
  return retained;
}
