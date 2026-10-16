import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { relative, resolve as resolvePath } from "node:path";
import { normalizeGitHubExternalWorkItem } from "./external-work.js";
import { redactSecrets } from "./redaction.js";
import type {
  ExternalWorkCiTriageRecord,
  ExternalWorkCiTriageResponse,
  ExternalWorkCiTriageStatus,
  ExternalWorkCiTriageView,
  ExternalWorkItem,
  ExternalWorkRecord,
  ExternalWorkflowDefinition,
  GitHubCiFailure,
  GitHubCiFailureConclusion,
} from "./external-work-types.js";
import type {
  ExternalWorkStoreFacet,
  RunArtifact,
  RunExecutionStoreFacet,
  RunStorePathsFacet,
  RuntimeSupervisorStoreFacet,
  WorkspaceStoreFacet,
} from "./run-types.js";
import { DEFAULT_WORKSPACE_ID, type Task } from "./workspace-types.js";

type ExternalWorkCiTriageStore =
  ExternalWorkStoreFacet &
  WorkspaceStoreFacet &
  RunExecutionStoreFacet &
  RuntimeSupervisorStoreFacet &
  RunStorePathsFacet;

type FetchLike = (input: string, init?: { readonly method?: string; readonly headers?: Record<string, string> }) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface GitHubCiTriageAdapterOptions {
  readonly fetch?: FetchLike;
  readonly apiBaseUrl?: string;
}

export interface GitHubCiTriageInput {
  readonly store: ExternalWorkCiTriageStore;
  readonly cwd: string;
  readonly externalWorkId: string;
  readonly workflowDefinition: ExternalWorkflowDefinition;
  readonly githubToken?: string;
  readonly fetch?: FetchLike;
  readonly apiBaseUrl?: string;
  readonly limit?: number;
  readonly createTask?: boolean;
  readonly startRun?: boolean;
  readonly now?: string;
}

interface GitHubCiFailureCandidate extends GitHubCiFailure {
  readonly raw: unknown;
  readonly logExcerpt?: string;
}

interface GitHubCiTriageAdapter {
  getPullRequest(input: { readonly repository: string; readonly number: number; readonly token?: string }): Promise<ExternalWorkItem>;
  listFailures(input: {
    readonly repository: string;
    readonly subjectNumber: number;
    readonly headSha: string;
    readonly token?: string;
    readonly limit?: number;
  }): Promise<readonly GitHubCiFailureCandidate[]>;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 25;
const CI_TRIAGE_LEASE_TTL_MS = 5 * 60 * 1000;
const LOG_EXCERPT_LIMIT = 64_000;
const FAILING_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required"]);

export function createGitHubCiTriageAdapter(options: GitHubCiTriageAdapterOptions = {}): GitHubCiTriageAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) {
    throw new Error("A fetch implementation is required for GitHub CI triage.");
  }
  const apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");

  return {
    async getPullRequest(input): Promise<ExternalWorkItem> {
      const pullRequest = await githubJson(fetchImpl, `${apiBaseUrl}${githubRepoPath(input.repository)}/pulls/${input.number}`, input.token);
      return normalizeGitHubExternalWorkItem({
        eventType: "pull_request.opened",
        payload: { repository: githubRepositoryPayload(input.repository), pull_request: pullRequest },
        repositoryFullName: input.repository,
        payloadRef: `github:ci-triage:pull_request:${input.repository}#${input.number}`,
      });
    },
    async listFailures(input): Promise<readonly GitHubCiFailureCandidate[]> {
      const limit = clampLimit(input.limit);
      const failures: GitHubCiFailureCandidate[] = [];
      const seenCheckNames = new Set<string>();
      const runs = await githubJsonObject(fetchImpl, `${apiBaseUrl}${githubRepoPath(input.repository)}/actions/runs?head_sha=${encodeURIComponent(input.headSha)}&per_page=${limit}`, input.token);
      for (const run of readArray(runs.workflow_runs, "workflow_runs")) {
        if (failures.length >= limit) {
          break;
        }
        if (!isFailingConclusion(readOptionalString(run, "conclusion"))) {
          continue;
        }
        const runId = readRequiredNumber(run, "id");
        const jobsResponse = await githubJsonObject(fetchImpl, `${apiBaseUrl}${githubRepoPath(input.repository)}/actions/runs/${runId}/jobs?per_page=${limit}`, input.token);
        const jobs = readArray(jobsResponse.jobs, "jobs").filter((job) => isFailingConclusion(readOptionalString(job, "conclusion")));
        if (jobs.length === 0) {
          failures.push(buildWorkflowRunFailure({ repository: input.repository, subjectNumber: input.subjectNumber, headSha: input.headSha, run }));
          continue;
        }
        for (const job of jobs) {
          if (failures.length >= limit) {
            break;
          }
          const jobName = readOptionalString(job, "name") ?? `job ${readRequiredNumber(job, "id")}`;
          seenCheckNames.add(jobName);
          failures.push(await buildWorkflowJobFailure({
            fetchImpl,
            apiBaseUrl,
            repository: input.repository,
            subjectNumber: input.subjectNumber,
            headSha: input.headSha,
            run,
            job,
            token: input.token,
          }));
        }
      }

      if (failures.length < limit) {
        const checks = await githubJsonObject(fetchImpl, `${apiBaseUrl}${githubRepoPath(input.repository)}/commits/${encodeURIComponent(input.headSha)}/check-runs?per_page=${limit}`, input.token);
        for (const check of readArray(checks.check_runs, "check_runs")) {
          if (failures.length >= limit) {
            break;
          }
          const name = readOptionalString(check, "name") ?? `check ${readRequiredNumber(check, "id")}`;
          if (seenCheckNames.has(name) || !isFailingConclusion(readOptionalString(check, "conclusion"))) {
            continue;
          }
          failures.push(buildCheckRunFailure({ repository: input.repository, subjectNumber: input.subjectNumber, headSha: input.headSha, check, token: input.token }));
        }
      }

      return failures.slice(0, limit);
    },
  };
}

export async function triageGitHubExternalWorkCi(input: GitHubCiTriageInput): Promise<ExternalWorkCiTriageResponse> {
  if (input.startRun) {
    throw new Error("startRun is not supported by Phase 4.0 CI triage; create the task first, then run it explicitly.");
  }
  const now = input.now ?? new Date().toISOString();
  const externalWork = requirePullRequestExternalWork(input.store, input.externalWorkId);
  const repository = requireRepository(externalWork, input.workflowDefinition);
  const subjectNumber = readSubjectNumber(externalWork);
  const adapter = createGitHubCiTriageAdapter({ fetch: input.fetch, apiBaseUrl: input.apiBaseUrl });
  const current = await adapter.getPullRequest({ repository, number: subjectNumber, token: input.githubToken });
  if (!current.headSha) {
    throw new Error(`GitHub pull request head SHA is missing: ${externalWork.identifier}`);
  }
  if (externalWork.item.headSha && current.headSha !== externalWork.item.headSha) {
    const record = createOrReuseStaleRecord({
      store: input.store,
      externalWork,
      repository,
      subjectNumber,
      expectedHeadSha: externalWork.item.headSha,
      current,
      now,
    });
    return responseForRecords(input.store, input.cwd, { stale: 1, records: [record] });
  }

  const leaseOwnerId = `external_work_ci:${externalWork.id}:${Date.parse(now) || Date.now()}`;
  const subjectLease = input.store.acquireResourceLease({
    workspaceId: DEFAULT_WORKSPACE_ID,
    resourceType: "external_subject",
    resourceKey: `github_pr:${repository}#${subjectNumber}`,
    ownerType: "system",
    ownerId: leaseOwnerId,
    acquiredAt: now,
    expiresAt: addMilliseconds(now, CI_TRIAGE_LEASE_TTL_MS),
  });
  if (!subjectLease) {
    const blocker = input.store.getBlockingResourceLease("external_subject", `github_pr:${repository}#${subjectNumber}`);
    throw new Error(blocker ? `External subject is locked by ${blocker.ownerType}:${blocker.ownerId}` : `External subject is locked: ${repository}#${subjectNumber}`);
  }

  try {
    const failures = await adapter.listFailures({
      repository,
      subjectNumber,
      headSha: current.headSha,
      token: input.githubToken,
      limit: input.limit,
    });
    let triaged = 0;
    let taskCreated = 0;
    let duplicates = 0;
    const records: ExternalWorkCiTriageRecord[] = [];
    for (const failure of failures) {
      const existing = input.store.getExternalWorkCiTriageByFailureKey("github", failure.failureKey);
      if (existing) {
        const ensured = ensureTaskForExistingTriage({
          store: input.store,
          externalWork,
          record: existing,
          createTask: input.createTask !== false,
          now,
        });
        duplicates += 1;
        taskCreated += ensured.taskCreated ? 1 : 0;
        records.push(ensured.record);
        continue;
      }
      const result = createTriageRecordForFailure({
        store: input.store,
        externalWork,
        failure,
        token: input.githubToken,
        createTask: input.createTask !== false,
        now,
      });
      triaged += 1;
      taskCreated += result.taskCreated ? 1 : 0;
      records.push(result.record);
    }
    return responseForRecords(input.store, input.cwd, { triaged, taskCreated, duplicates, records });
  } finally {
    input.store.releaseResourceLeasesForOwner("system", subjectLease.ownerId, new Date().toISOString());
  }
}

export function buildExternalWorkCiTriageView(store: ExternalWorkCiTriageStore, triage: ExternalWorkCiTriageRecord): ExternalWorkCiTriageView {
  const externalWork = store.getExternalWorkRecord(triage.externalWorkId);
  const task = triage.taskId ? store.getTask(triage.taskId) : undefined;
  const run = triage.runId ? store.getRun(triage.runId) : undefined;
  return {
    triage,
    ...(externalWork ? { externalWork } : {}),
    ...(task ? { task } : {}),
    ...(run ? { run } : {}),
    artifacts: triage.artifactIds
      .map((artifactId) => store.getArtifact(artifactId))
      .filter((artifact): artifact is RunArtifact => artifact !== undefined),
  };
}

function ensureTaskForExistingTriage(input: {
  readonly store: ExternalWorkCiTriageStore;
  readonly externalWork: ExternalWorkRecord;
  readonly record: ExternalWorkCiTriageRecord;
  readonly createTask: boolean;
  readonly now: string;
}): { readonly record: ExternalWorkCiTriageRecord; readonly taskCreated: boolean } {
  if (!input.createTask || input.record.taskId || input.record.status === "stale") {
    return { record: input.record, taskCreated: false };
  }
  const artifacts = input.record.artifactIds
    .map((artifactId) => input.store.getArtifact(artifactId))
    .filter((artifact): artifact is RunArtifact => artifact !== undefined);
  const prompt = buildCiFixTaskPrompt(input.externalWork, input.record, artifacts);
  const promptArtifact = createTextArtifact({
    store: input.store,
    externalWorkId: input.externalWork.id,
    directoryParts: ["ci-triage", input.record.id],
    fileName: "task-prompt.md",
    title: "CI fix task prompt",
    type: "markdown",
    contentType: "text/markdown; charset=utf-8",
    content: `${prompt.trim()}\n`,
    createdAt: input.now,
  });
  const task = input.store.createTask({
    channelId: input.externalWork.channelId,
    title: `Fix failing CI: ${input.record.checkName} on ${input.record.repository}#${input.record.subjectNumber}`,
    prompt,
    status: "todo",
  }, input.now);
  const updated = input.store.updateExternalWorkCiTriage(input.record.id, {
    status: "task_created",
    taskId: task.id,
    artifactIds: [...input.record.artifactIds, promptArtifact.id],
  }, input.now);
  return { record: updated ?? input.record, taskCreated: true };
}

function createTriageRecordForFailure(input: {
  readonly store: ExternalWorkCiTriageStore;
  readonly externalWork: ExternalWorkRecord;
  readonly failure: GitHubCiFailureCandidate;
  readonly token?: string;
  readonly createTask: boolean;
  readonly now: string;
}): { readonly record: ExternalWorkCiTriageRecord; readonly taskCreated: boolean } {
  const artifacts = createCiFailureArtifacts(input.store, input.externalWork, input.failure, input.token, input.now);
  const logArtifact = artifacts.find((artifact) => artifact.title === "GitHub CI log excerpt");
  const failure = logArtifact ? { ...input.failure, logExcerptArtifactId: logArtifact.id } : input.failure;
  let record = input.store.createExternalWorkCiTriage({
    channelId: input.externalWork.channelId,
    externalWorkId: input.externalWork.id,
    sourceKind: "github",
    repository: failure.repository,
    subjectKind: failure.subjectKind,
    subjectNumber: failure.subjectNumber,
    headSha: failure.headSha,
    failureKey: failure.failureKey,
    status: "triaged",
    checkName: failure.checkName,
    workflowName: failure.workflowName,
    jobName: failure.jobName,
    conclusion: failure.conclusion,
    htmlUrl: failure.htmlUrl,
    firstFailingCommand: failure.firstFailingCommand,
    reproductionCommand: failure.reproductionCommand,
    suspectedSourcePath: failure.suspectedSourcePath,
    artifactIds: artifacts.map((artifact) => artifact.id),
    failure,
    lastErrorCode: failure.logErrorMessage ? "ci_log_unavailable" : undefined,
    lastErrorMessage: failure.logErrorMessage,
  }, input.now);
  let taskCreated = false;
  if (input.createTask) {
    const prompt = buildCiFixTaskPrompt(input.externalWork, record, artifacts);
    const promptArtifact = createTextArtifact({
      store: input.store,
      externalWorkId: input.externalWork.id,
      directoryParts: ["ci-triage", record.id],
      fileName: "task-prompt.md",
      title: "CI fix task prompt",
      type: "markdown",
      contentType: "text/markdown; charset=utf-8",
      content: `${prompt.trim()}\n`,
      createdAt: input.now,
    });
    const task = input.store.createTask({
      channelId: input.externalWork.channelId,
      title: `Fix failing CI: ${record.checkName} on ${record.repository}#${record.subjectNumber}`,
      prompt,
      status: "todo",
    }, input.now);
    record = input.store.updateExternalWorkCiTriage(record.id, {
      status: "task_created",
      taskId: task.id,
      artifactIds: [...record.artifactIds, promptArtifact.id],
    }, input.now) ?? record;
    taskCreated = true;
  }
  return { record, taskCreated };
}

function createOrReuseStaleRecord(input: {
  readonly store: ExternalWorkCiTriageStore;
  readonly externalWork: ExternalWorkRecord;
  readonly repository: string;
  readonly subjectNumber: number;
  readonly expectedHeadSha: string;
  readonly current: ExternalWorkItem;
  readonly now: string;
}): ExternalWorkCiTriageRecord {
  const currentHeadSha = input.current.headSha ?? "unknown";
  const failureKey = [
    "github:ci:stale",
    input.repository,
    String(input.subjectNumber),
    input.expectedHeadSha,
    currentHeadSha,
  ].join(":");
  const existing = input.store.getExternalWorkCiTriageByFailureKey("github", failureKey);
  if (existing) {
    return existing;
  }
  const failure: GitHubCiFailure = {
    repository: input.repository,
    subjectKind: "github_pull_request",
    subjectNumber: input.subjectNumber,
    headSha: input.expectedHeadSha,
    checkName: "PR head changed",
    conclusion: "stale",
    htmlUrl: input.current.url,
    failureKey,
    logErrorMessage: `Stored PR head SHA ${input.expectedHeadSha} no longer matches current head SHA ${currentHeadSha}.`,
  };
  const artifact = createTextArtifact({
    store: input.store,
    externalWorkId: input.externalWork.id,
    directoryParts: ["ci-triage", hashText(failureKey).slice(0, 16)],
    fileName: "stale-target.json",
    title: "GitHub CI stale target",
    type: "json",
    contentType: "application/json; charset=utf-8",
    content: `${JSON.stringify({ failure, current: input.current }, null, 2)}\n`,
    createdAt: input.now,
  });
  return input.store.createExternalWorkCiTriage({
    channelId: input.externalWork.channelId,
    externalWorkId: input.externalWork.id,
    sourceKind: "github",
    repository: input.repository,
    subjectKind: "github_pull_request",
    subjectNumber: input.subjectNumber,
    headSha: input.expectedHeadSha,
    failureKey,
    status: "stale",
    checkName: failure.checkName,
    conclusion: failure.conclusion,
    htmlUrl: failure.htmlUrl,
    artifactIds: [artifact.id],
    failure,
    lastErrorCode: "stale_pr_head",
    lastErrorMessage: failure.logErrorMessage,
  }, input.now);
}

function createCiFailureArtifacts(
  store: ExternalWorkCiTriageStore,
  externalWork: ExternalWorkRecord,
  failure: GitHubCiFailureCandidate,
  token: string | undefined,
  createdAt: string,
): RunArtifact[] {
  const dir = ["ci-triage", hashText(failure.failureKey).slice(0, 16)];
  const normalized = createTextArtifact({
    store,
    externalWorkId: externalWork.id,
    directoryParts: dir,
    fileName: "normalized-ci-failure.json",
    title: "Normalized GitHub CI failure",
    type: "json",
    contentType: "application/json; charset=utf-8",
    content: `${JSON.stringify(redactSecrets({ failure, raw: failure.raw }, [token]), null, 2)}\n`,
    createdAt,
  });
  const artifacts = [normalized];
  if (failure.logExcerpt) {
    artifacts.push(createTextArtifact({
      store,
      externalWorkId: externalWork.id,
      directoryParts: dir,
      fileName: "log-excerpt.txt",
      title: "GitHub CI log excerpt",
      type: "log",
      contentType: "text/plain; charset=utf-8",
      content: `${failure.logExcerpt.trim()}\n`,
      createdAt,
    }));
  }
  artifacts.push(createTextArtifact({
    store,
    externalWorkId: externalWork.id,
    directoryParts: dir,
    fileName: "triage-summary.md",
    title: "GitHub CI triage summary",
    type: "markdown",
    contentType: "text/markdown; charset=utf-8",
    content: `${buildCiTriageSummary(failure, artifacts).trim()}\n`,
    createdAt,
  }));
  return artifacts;
}

function createTextArtifact(input: {
  readonly store: ExternalWorkCiTriageStore;
  readonly externalWorkId: string;
  readonly directoryParts: readonly string[];
  readonly fileName: string;
  readonly title: string;
  readonly type: RunArtifact["type"];
  readonly contentType: string;
  readonly content: string;
  readonly createdAt: string;
}): RunArtifact {
  const artifactDir = resolvePath(input.store.paths.artifactsDir, "external-work", input.externalWorkId, ...input.directoryParts);
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = resolvePath(artifactDir, input.fileName);
  writeFileSync(artifactPath, input.content, "utf8");
  return input.store.createArtifact({
    externalWorkId: input.externalWorkId,
    type: input.type,
    path: normalizeArtifactPath(relative(input.store.paths.artifactsDir, artifactPath)),
    title: input.title,
    contentType: input.contentType,
    sizeBytes: Buffer.byteLength(input.content, "utf8"),
    createdAt: input.createdAt,
  });
}

function buildCiFixTaskPrompt(externalWork: ExternalWorkRecord, record: ExternalWorkCiTriageRecord, artifacts: readonly RunArtifact[]): string {
  const artifactLines = artifacts.map((artifact) => `- ${artifact.title ?? artifact.id}: ${artifact.id}`).join("\n");
  return [
    `Fix failing CI for ${record.repository}#${record.subjectNumber}.`,
    "",
    `External work: ${externalWork.id}`,
    `PR identifier: ${externalWork.identifier}`,
    `Expected head SHA: ${record.headSha}`,
    `Check: ${record.checkName}`,
    record.workflowName ? `Workflow: ${record.workflowName}` : undefined,
    record.jobName ? `Job: ${record.jobName}` : undefined,
    `Conclusion: ${record.conclusion}`,
    record.htmlUrl ? `GitHub URL: ${record.htmlUrl}` : undefined,
    "",
    "Evidence artifacts:",
    artifactLines || "- No artifacts were captured.",
    "",
    record.firstFailingCommand
      ? `First likely failing command: ${record.firstFailingCommand}`
      : "First likely failing command: not identified; inspect the log excerpt before changing code.",
    record.reproductionCommand ? `Suggested reproduction command: ${record.reproductionCommand}` : undefined,
    record.suspectedSourcePath ? `Suspected source path: ${record.suspectedSourcePath}` : undefined,
    "",
    "Instructions:",
    "- Inspect the evidence artifacts and reproduce the failure locally before editing code.",
    "- Keep the fix scoped to this CI failure.",
    "- Record local verification evidence in the task/run output.",
    "- Do not push commits, comment on GitHub, label, review, merge, or otherwise mutate GitHub from this task unless a separate approval-gated external action is created and approved.",
  ].filter((line): line is string => line !== undefined).join("\n");
}

function buildCiTriageSummary(failure: GitHubCiFailureCandidate, artifacts: readonly RunArtifact[]): string {
  const lines = [
    `# GitHub CI Triage: ${failure.checkName}`,
    "",
    `Repository: ${failure.repository}`,
    `PR: #${failure.subjectNumber}`,
    `Head SHA: ${failure.headSha}`,
    `Conclusion: ${failure.conclusion}`,
    failure.workflowName ? `Workflow: ${failure.workflowName}` : undefined,
    failure.jobName ? `Job: ${failure.jobName}` : undefined,
    failure.htmlUrl ? `URL: ${failure.htmlUrl}` : undefined,
    "",
    failure.firstFailingCommand ? `First likely failing command: ${failure.firstFailingCommand}` : "First likely failing command: not identified.",
    failure.reproductionCommand ? `Suggested reproduction command: ${failure.reproductionCommand}` : undefined,
    failure.suspectedSourcePath ? `Suspected source path: ${failure.suspectedSourcePath}` : undefined,
    failure.logErrorMessage ? `Log note: ${failure.logErrorMessage}` : undefined,
    "",
    "Artifacts:",
    ...artifacts.map((artifact) => `- ${artifact.title ?? artifact.id}: ${artifact.id}`),
  ];
  return lines.filter((line): line is string => line !== undefined).join("\n");
}

function responseForRecords(
  store: ExternalWorkCiTriageStore,
  cwd: string,
  input: {
    readonly triaged?: number;
    readonly taskCreated?: number;
    readonly duplicates?: number;
    readonly blocked?: number;
    readonly stale?: number;
    readonly failed?: number;
    readonly records: readonly ExternalWorkCiTriageRecord[];
  },
): ExternalWorkCiTriageResponse {
  return {
    cwd,
    triaged: input.triaged ?? 0,
    taskCreated: input.taskCreated ?? 0,
    duplicates: input.duplicates ?? 0,
    blocked: input.blocked ?? 0,
    stale: input.stale ?? 0,
    failed: input.failed ?? 0,
    records: input.records.map((record) => buildExternalWorkCiTriageView(store, record)),
  };
}

async function buildWorkflowJobFailure(input: {
  readonly fetchImpl: FetchLike;
  readonly apiBaseUrl: string;
  readonly repository: string;
  readonly subjectNumber: number;
  readonly headSha: string;
  readonly run: Record<string, unknown>;
  readonly job: Record<string, unknown>;
  readonly token?: string;
}): Promise<GitHubCiFailureCandidate> {
  const jobId = readRequiredNumber(input.job, "id");
  const workflowName = readOptionalString(input.run, "name") ?? readOptionalString(input.run, "display_title");
  const jobName = readOptionalString(input.job, "name") ?? `job ${jobId}`;
  const conclusion = readOptionalString(input.job, "conclusion") ?? readOptionalString(input.run, "conclusion") ?? "failure";
  let logExcerpt: string | undefined;
  let logErrorMessage: string | undefined;
  try {
    const rawLog = await githubText(input.fetchImpl, `${input.apiBaseUrl}${githubRepoPath(input.repository)}/actions/jobs/${jobId}/logs`, input.token);
    logExcerpt = redactLogExcerpt(rawLog, input.token);
  } catch (error) {
    logErrorMessage = error instanceof Error ? error.message : String(error);
  }
  const parsed = parseLogEvidence(logExcerpt);
  return {
    repository: input.repository,
    subjectKind: "github_pull_request",
    subjectNumber: input.subjectNumber,
    headSha: input.headSha,
    checkName: jobName,
    workflowName,
    jobName,
    conclusion,
    htmlUrl: readOptionalString(input.job, "html_url") ?? readOptionalString(input.run, "html_url"),
    failureKey: createFailureKey({
      repository: input.repository,
      subjectNumber: input.subjectNumber,
      headSha: input.headSha,
      kind: "workflow_job",
      id: String(jobId),
      conclusion,
      updatedAt: readOptionalString(input.job, "completed_at") ?? readOptionalString(input.run, "updated_at"),
    }),
    firstFailingCommand: parsed.firstFailingCommand,
    reproductionCommand: parsed.reproductionCommand,
    suspectedSourcePath: parsed.suspectedSourcePath,
    logErrorMessage,
    raw: { workflowRun: input.run, job: input.job },
    logExcerpt,
  };
}

function buildWorkflowRunFailure(input: {
  readonly repository: string;
  readonly subjectNumber: number;
  readonly headSha: string;
  readonly run: Record<string, unknown>;
}): GitHubCiFailureCandidate {
  const runId = readRequiredNumber(input.run, "id");
  const workflowName = readOptionalString(input.run, "name") ?? readOptionalString(input.run, "display_title") ?? `workflow run ${runId}`;
  const conclusion = readOptionalString(input.run, "conclusion") ?? "failure";
  return {
    repository: input.repository,
    subjectKind: "github_pull_request",
    subjectNumber: input.subjectNumber,
    headSha: input.headSha,
    checkName: workflowName,
    workflowName,
    conclusion,
    htmlUrl: readOptionalString(input.run, "html_url"),
    failureKey: createFailureKey({
      repository: input.repository,
      subjectNumber: input.subjectNumber,
      headSha: input.headSha,
      kind: "workflow_run",
      id: String(runId),
      conclusion,
      updatedAt: readOptionalString(input.run, "updated_at"),
    }),
    raw: { workflowRun: input.run },
  };
}

function buildCheckRunFailure(input: {
  readonly repository: string;
  readonly subjectNumber: number;
  readonly headSha: string;
  readonly check: Record<string, unknown>;
  readonly token?: string;
}): GitHubCiFailureCandidate {
  // All parsed metadata and raw evidence must share the same safe projection.
  const check = redactSecrets(input.check, [input.token]) as Record<string, unknown>;
  const checkId = readRequiredNumber(check, "id");
  const checkName = readOptionalString(check, "name") ?? `check ${checkId}`;
  const conclusion = readOptionalString(check, "conclusion") ?? "failure";
  const output = readOptionalRecord(check, "output");
  const text = [
    readOptionalString(output, "title"),
    readOptionalString(output, "summary"),
    readOptionalString(output, "text"),
  ].filter(Boolean).join("\n");
  const parsed = parseLogEvidence(text || undefined);
  return {
    repository: input.repository,
    subjectKind: "github_pull_request",
    subjectNumber: input.subjectNumber,
    headSha: input.headSha,
    checkName,
    conclusion,
    htmlUrl: readOptionalString(check, "html_url") ?? readOptionalString(check, "details_url"),
    failureKey: createFailureKey({
      repository: input.repository,
      subjectNumber: input.subjectNumber,
      headSha: input.headSha,
      kind: "check_run",
      id: String(checkId),
      conclusion,
      updatedAt: readOptionalString(check, "completed_at") ?? readOptionalString(check, "started_at"),
    }),
    firstFailingCommand: parsed.firstFailingCommand,
    reproductionCommand: parsed.reproductionCommand,
    suspectedSourcePath: parsed.suspectedSourcePath,
    raw: { checkRun: check },
    logExcerpt: text ? redactLogExcerpt(text, input.token) : undefined,
  };
}

function requirePullRequestExternalWork(store: ExternalWorkCiTriageStore, externalWorkId: string): ExternalWorkRecord {
  const externalWork = store.getExternalWorkRecord(externalWorkId);
  if (!externalWork) {
    throw new Error(`External work item not found: ${externalWorkId}`);
  }
  if (externalWork.sourceKind !== "github" || externalWork.workItemKind !== "github_pull_request") {
    throw new Error(`CI triage only supports GitHub pull request external work items: ${externalWork.workItemKind}`);
  }
  return externalWork;
}

function requireRepository(externalWork: ExternalWorkRecord, workflowDefinition: ExternalWorkflowDefinition): string {
  const repository = externalWork.item.repository?.fullName;
  if (!repository) {
    throw new Error("External work item repository is required for CI triage.");
  }
  if (workflowDefinition.config.source.kind !== "github") {
    throw new Error(`Unsupported external source kind for CI triage: ${workflowDefinition.config.source.kind}`);
  }
  if (workflowDefinition.config.source.repository && workflowDefinition.config.source.repository !== repository) {
    throw new Error(`WORKFLOW.md source.repository (${workflowDefinition.config.source.repository}) does not match external work repository (${repository}).`);
  }
  return repository;
}

function readSubjectNumber(externalWork: ExternalWorkRecord): number {
  const match = /#(\d+)$/.exec(externalWork.identifier);
  if (!match) {
    throw new Error(`External work identifier does not include a GitHub number: ${externalWork.identifier}`);
  }
  return Number.parseInt(match[1], 10);
}

function createFailureKey(input: {
  readonly repository: string;
  readonly subjectNumber: number;
  readonly headSha: string;
  readonly kind: string;
  readonly id: string;
  readonly conclusion: GitHubCiFailureConclusion;
  readonly updatedAt?: string;
}): string {
  return [
    "github:ci",
    input.repository,
    String(input.subjectNumber),
    input.headSha,
    input.kind,
    input.id,
    input.conclusion,
    input.updatedAt ?? "unknown-updated-at",
  ].join(":");
}

function parseLogEvidence(logExcerpt: string | undefined): {
  readonly firstFailingCommand?: string;
  readonly reproductionCommand?: string;
  readonly suspectedSourcePath?: string;
} {
  if (!logExcerpt) {
    return {};
  }
  const lines = logExcerpt.split(/\r?\n/);
  const firstFailingCommand = findFirstFailingCommand(lines);
  return {
    ...(firstFailingCommand ? { firstFailingCommand, reproductionCommand: firstFailingCommand } : {}),
    ...findSuspectedSourcePath(lines),
  };
}

function findFirstFailingCommand(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const cleaned = stripGitHubLogPrefix(line).trim();
    const groupRun = cleaned.match(/^##\[group\]Run\s+(.+)$/);
    if (groupRun?.[1]) {
      return groupRun[1].trim();
    }
    const run = cleaned.match(/^Run\s+(.+)$/);
    if (run?.[1] && looksLikeCommand(run[1])) {
      return run[1].trim();
    }
    const shell = cleaned.match(/^(?:\$|\+)\s+(.+)$/);
    if (shell?.[1] && looksLikeCommand(shell[1])) {
      return shell[1].trim();
    }
    if (looksLikeCommand(cleaned)) {
      return cleaned;
    }
  }
  return undefined;
}

function findSuspectedSourcePath(lines: readonly string[]): { readonly suspectedSourcePath?: string } {
  const pattern = /(?:^|\s)([\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|css|scss|md|json|yaml|yml))(?::\d+)?/;
  for (const line of lines) {
    const match = stripGitHubLogPrefix(line).match(pattern);
    if (match?.[1] && !match[1].includes("node_modules/")) {
      return { suspectedSourcePath: match[1] };
    }
  }
  return {};
}

function stripGitHubLogPrefix(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/, "");
}

function looksLikeCommand(value: string): boolean {
  return /^(corepack\s+)?(pnpm|npm|yarn|bun|node|npx|tsc|eslint|vitest|jest|playwright|pytest|python|go\s+test|cargo|swift|xcodebuild|make)\b/.test(value.trim());
}

function redactLogExcerpt(log: string, token: string | undefined): string {
  const bounded = log.length > LOG_EXCERPT_LIMIT ? log.slice(-LOG_EXCERPT_LIMIT) : log;
  return String(redactSecrets(bounded, [token]));
}

async function githubJsonObject(fetchImpl: FetchLike, url: string, token: string | undefined): Promise<Record<string, unknown>> {
  const value = await githubJson(fetchImpl, url, token);
  if (!isRecord(value)) {
    throw new Error(`GitHub response must be an object: ${url}`);
  }
  return value;
}

async function githubJson(fetchImpl: FetchLike, url: string, token: string | undefined): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    throw new Error(await githubErrorMessage(response));
  }
  return await response.json();
}

async function githubText(fetchImpl: FetchLike, url: string, token: string | undefined): Promise<string> {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    throw new Error(await githubErrorMessage(response));
  }
  return await response.text();
}

function githubHeaders(token: string | undefined): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "ling-stack-external-work",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function githubErrorMessage(response: { readonly status: number; readonly statusText: string; text(): Promise<string> }): Promise<string> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }
  return `GitHub read-only request failed: ${response.status} ${response.statusText}${body ? ` ${body.slice(0, 300)}` : ""}`;
}

function githubRepoPath(repository: string): string {
  const [owner, name] = repository.split("/");
  if (!owner || !name) {
    throw new Error(`Invalid GitHub repository full name: ${repository}`);
  }
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function githubRepositoryPayload(fullName: string): Record<string, unknown> {
  const [owner, name] = fullName.split("/");
  return {
    name,
    full_name: fullName,
    default_branch: "main",
    owner: { login: owner },
  };
}

function isFailingConclusion(conclusion: string | undefined): boolean {
  return conclusion !== undefined && FAILING_CONCLUSIONS.has(conclusion);
}

function readArray(value: unknown, field: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
    throw new Error(`GitHub response field must be an object array: ${field}`);
  }
  return value as Record<string, unknown>[];
}

function readRequiredNumber(value: Record<string, unknown>, field: string): number {
  const entry = value[field];
  if (typeof entry !== "number") {
    throw new Error(`GitHub response field must be a number: ${field}`);
  }
  return entry;
}

function readOptionalString(value: Record<string, unknown> | undefined, field: string): string | undefined {
  const entry = value?.[field];
  return typeof entry === "string" ? entry : undefined;
}

function readOptionalRecord(value: Record<string, unknown> | undefined, field: string): Record<string, unknown> | undefined {
  const entry = value?.[field];
  return isRecord(entry) ? entry : undefined;
}

function clampLimit(value: number | undefined): number {
  return Math.min(Math.max(value ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}

function addMilliseconds(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

function normalizeArtifactPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
