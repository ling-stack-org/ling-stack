import type {
  LingAppServerGitHubIntakePolicy,
  LingAppServerGitHubIntakePollResult,
  LingAppServerGitHubIntakeReceipt,
  LingAppServerGitHubSubject,
} from "@ling-stack/contracts";
import type { AutomationEventEnvelope, AutomationEventSource, AutomationGitHubIntakePending, AutomationGitHubIntakeTarget, RunStore } from "@ling-stack/core";
import type { DaemonContext } from "../context.js";
import { HttpError } from "../errors.js";
import { trimOversizedEvent } from "../features/control-plane/events.js";
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

export async function pollGitHubIntake(context: IntakeContext, store: RunStore, input: Record<string, unknown>): Promise<LingAppServerGitHubIntakePollResult> {
  const { repository, page = 1 } = input;
  if (typeof repository !== "string" || !githubRepositoryPattern.test(repository)
    || typeof page !== "number" || !Number.isSafeInteger(page) || page < 1 || page > 500) {
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
    const basis = receiptBasis("poll", sourceEventId, subject, revision);
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
          else evaluateGitHubIntake(context, store, basis, source?.intake ?? defaultPolicy, subject);
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
  policy: LingAppServerGitHubIntakePolicy, subject: IntakeSubject): LingAppServerGitHubIntakeReceipt {
  const retained = readReceipt(store, basis.receiptId);
  if (retained) return retained;
  if (!policy.enabled) return saveReceipt(store, { ...basis, outcome: "paused", reasonCode: "policy_disabled" });
  if (subject.state !== "open") return saveReceipt(store, { ...basis, outcome: "suppressed", reasonCode: "subject_closed" });
  if (policy.requiredLabel && !subject.labels?.includes(policy.requiredLabel)) {
    return saveReceipt(store, { ...basis, outcome: "suppressed", reasonCode: "required_label_missing" });
  }
  if (policy.mode === "manual") return saveReceipt(store, { ...basis, outcome: "manual", reasonCode: "manual_intake" });
  const result = store.createWorkItem({
    sourceType: "external_work", sourceId: basis.receiptId, title: subject.title.slice(0, 500), initialStatus: "intake",
    priority: policy.priority ?? "normal", verifiedTargetKey: gitHubWorkItemTargetKey(subject),
    description: `GitHub ${subject.kind} ${subject.repository}#${subject.number}`, gitHubIntake: basis,
  }, basis.evaluatedAt, store.paths.cwd);
  if (result.event) context.controlPlaneEvents.publish(trimOversizedEvent(result.event));
  if (!result.gitHubIntakeReceipt) throw new HttpError(409, "intake_conflict", "The GitHub intake receipt was not committed.");
  return result.gitHubIntakeReceipt;
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
