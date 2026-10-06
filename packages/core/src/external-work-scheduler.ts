import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import { DEFAULT_WORKSPACE_ID, type Channel } from "./workspace-types.js";
import { redactSecrets } from "./redaction.js";
import { createCoreOriginalProcessEntry, isCoreOriginalLaunchRefusal } from "./original-host-process-entry.js";
import type {
  ChannelStoreFacet,
  ExternalWorkStoreFacet,
  RunArtifact,
  RunExecutionStoreFacet,
  RunStorePathsFacet,
  RuntimeSupervisorStoreFacet,
  WorkspaceStoreFacet,
} from "./run-types.js";
import {
  normalizeGitHubExternalWorkItem,
  normalizeLinearExternalWorkItem,
  renderExternalWorkflowPrompt,
  ExternalWorkflowValidationError,
} from "./external-work.js";
import type {
  ExternalWorkGetItemInput,
  ExternalWorkItem,
  ExternalWorkLoadCandidatesInput,
  ExternalWorkPollResponse,
  ExternalWorkPollResultItem,
  ExternalWorkReconcileResponse,
  ExternalWorkSchedulerStatus,
  ExternalWorkSchedulerState,
  ExternalWorkSourceAdapter,
  ExternalWorkflowDefinition,
  ExternalWorkspaceMode,
} from "./external-work-types.js";

type ExternalWorkSchedulerStore =
  ExternalWorkStoreFacet &
  WorkspaceStoreFacet &
  ChannelStoreFacet &
  RunExecutionStoreFacet &
  RuntimeSupervisorStoreFacet &
  RunStorePathsFacet;

type FetchLike = (input: string, init?: { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: string }) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface GitHubExternalWorkAdapterOptions {
  readonly fetch?: FetchLike;
  readonly apiBaseUrl?: string;
}

export interface LinearExternalWorkAdapterOptions {
  readonly fetch?: FetchLike;
  readonly apiBaseUrl?: string;
}

export interface ExternalWorkPollGitHubInput {
  readonly store: ExternalWorkSchedulerStore;
  readonly cwd: string;
  readonly channelId: string;
  readonly workflowDefinition: ExternalWorkflowDefinition;
  readonly workflowDirectory: string;
  readonly githubToken?: string;
  readonly fetch?: FetchLike;
  readonly limit?: number;
  readonly executeHooks?: boolean;
  readonly now?: string;
}

export interface ExternalWorkPollLinearInput {
  readonly store: ExternalWorkSchedulerStore;
  readonly cwd: string;
  readonly channelId: string;
  readonly workflowDefinition: ExternalWorkflowDefinition;
  readonly workflowDirectory: string;
  readonly linearToken?: string;
  readonly fetch?: FetchLike;
  readonly limit?: number;
  readonly executeHooks?: boolean;
  readonly now?: string;
}

export interface ExternalWorkReconcileInput {
  readonly store: ExternalWorkSchedulerStore;
  readonly channelId?: string;
  readonly workflowDefinition?: ExternalWorkflowDefinition;
  readonly githubToken?: string;
  readonly fetch?: FetchLike;
  readonly now?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const EXTERNAL_WORK_LEASE_TTL_MS = 15 * 60 * 1000;
const originalSchedulerSpawn = spawn;
const originalExternalWorkHook = createCoreOriginalProcessEntry("external_work_scheduler", (input: {
  readonly command: string; readonly cwd: string;
}) => originalSchedulerSpawn(input.command, { cwd: input.cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] }));
export const CORE_EXTERNAL_WORK_SCHEDULER_ENTRY = originalExternalWorkHook.entry;
const INITIAL_RETRY_BACKOFF_MS = 1_000;
const ACTIVE_SCHEDULER_STATUSES = new Set<ExternalWorkSchedulerStatus>([
  "discovered",
  "claimed",
  "workspace_preparing",
  "ready",
  "retry_wait",
]);

export function createGitHubExternalWorkAdapter(options: GitHubExternalWorkAdapterOptions = {}): ExternalWorkSourceAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) {
    throw new Error("A fetch implementation is required for GitHub external work polling.");
  }
  const apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");

  return {
    id: "github-readonly",
    kind: "github",
    async loadCandidates(input: ExternalWorkLoadCandidatesInput): Promise<readonly ExternalWorkItem[]> {
      const limit = clampLimit(input.limit);
      const repository = parseRepositoryFullName(input.repository);
      const candidates: ExternalWorkItem[] = [];
      const repositoryPayload = githubRepositoryPayload(input.repository, repository);
      if (shouldLoadGitHubKind(input.events, "pull_request")) {
        const pulls = await githubJsonArray(fetchImpl, `${apiBaseUrl}/repos/${input.repository}/pulls?state=open&per_page=${limit}`, input.token);
        for (const pullRequest of pulls) {
          candidates.push(normalizeGitHubExternalWorkItem({
            eventType: pickGitHubEvent(input.events, "pull_request", "pull_request.opened"),
            payload: { repository: repositoryPayload, pull_request: pullRequest },
            repositoryFullName: input.repository,
            payloadRef: `github:poll:pull_request:${input.repository}#${readGitHubNumber(pullRequest)}`,
          }));
        }
      }
      if (shouldLoadGitHubKind(input.events, "issue")) {
        const issues = await githubJsonArray(fetchImpl, `${apiBaseUrl}/repos/${input.repository}/issues?state=open&per_page=${limit}`, input.token);
        for (const issue of issues) {
          if (isRecord(issue) && isRecord(issue.pull_request)) {
            continue;
          }
          candidates.push(normalizeGitHubExternalWorkItem({
            eventType: pickGitHubEvent(input.events, "issue", "issue.opened"),
            payload: { repository: repositoryPayload, issue },
            repositoryFullName: input.repository,
            payloadRef: `github:poll:issue:${input.repository}#${readGitHubNumber(issue)}`,
          }));
        }
      }
      return candidates.slice(0, limit);
    },
    async getWorkItem(input: ExternalWorkGetItemInput): Promise<ExternalWorkItem | undefined> {
      const repository = parseRepositoryFullName(input.repository);
      const repositoryPayload = githubRepositoryPayload(input.repository, repository);
      if (input.kind === "github_pull_request") {
        const pullRequest = await githubJson(fetchImpl, `${apiBaseUrl}/repos/${input.repository}/pulls/${input.number}`, input.token);
        return normalizeGitHubExternalWorkItem({
          eventType: "pull_request.opened",
          payload: { repository: repositoryPayload, pull_request: pullRequest },
          repositoryFullName: input.repository,
          payloadRef: `github:reconcile:pull_request:${input.repository}#${input.number}`,
        });
      }
      const issue = await githubJson(fetchImpl, `${apiBaseUrl}/repos/${input.repository}/issues/${input.number}`, input.token);
      if (isRecord(issue) && isRecord(issue.pull_request)) {
        return undefined;
      }
      return normalizeGitHubExternalWorkItem({
        eventType: "issue.opened",
        payload: { repository: repositoryPayload, issue },
        repositoryFullName: input.repository,
        payloadRef: `github:reconcile:issue:${input.repository}#${input.number}`,
      });
    },
  };
}

export function createLinearExternalWorkAdapter(options: LinearExternalWorkAdapterOptions = {}): ExternalWorkSourceAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) {
    throw new Error("A fetch implementation is required for Linear external work polling.");
  }
  const apiBaseUrl = options.apiBaseUrl ?? "https://api.linear.app/graphql";

  return {
    id: "linear-readonly",
    kind: "linear",
    async loadCandidates(input: ExternalWorkLoadCandidatesInput): Promise<readonly ExternalWorkItem[]> {
      const limit = clampLimit(input.limit);
      const projectSlug = input.repository;
      const value = await linearGraphQL(fetchImpl, apiBaseUrl, input.token, LINEAR_ISSUES_QUERY, { first: limit });
      const issues = readLinearIssueNodes(value);
      return issues
        .filter((issue) => matchesLinearProject(issue, projectSlug))
        .map((issue) => normalizeLinearExternalWorkItem({
          eventType: pickLinearEvent(input.events, "issue.created"),
          payload: issue,
          projectSlug,
          payloadRef: `linear:poll:issue:${projectSlug}:${readLinearIdentifier(issue)}`,
        }))
        .slice(0, limit);
    },
    async getWorkItem(): Promise<ExternalWorkItem | undefined> {
      return undefined;
    },
  };
}

export async function pollGitHubExternalWork(input: ExternalWorkPollGitHubInput): Promise<ExternalWorkPollResponse> {
  if (input.workflowDefinition.config.source.kind !== "github") {
    throw new ExternalWorkflowValidationError(`Unsupported external source kind: ${input.workflowDefinition.config.source.kind}`);
  }
  const repository = input.workflowDefinition.config.source.repository;
  if (!repository) {
    throw new ExternalWorkflowValidationError("WORKFLOW.md source.repository is required.");
  }
  const channel = requireChannel(input.store, input.channelId);
  const now = input.now ?? new Date().toISOString();
  const sourceKey = `github:${repository}`;
  const pollOwnerId = `external_work_poll:${sourceKey}:${Date.parse(now) || Date.now()}`;
  const sourceLease = input.store.acquireResourceLease({
    workspaceId: DEFAULT_WORKSPACE_ID,
    resourceType: "external_source",
    resourceKey: sourceKey,
    ownerType: "system",
    ownerId: pollOwnerId,
    acquiredAt: now,
    expiresAt: addMilliseconds(now, EXTERNAL_WORK_LEASE_TTL_MS),
  });
  if (!sourceLease) {
    const blocker = input.store.getBlockingResourceLease("external_source", sourceKey);
    return emptyPollResponse({
      blocked: 1,
      results: [{
        action: "blocked",
        message: blocker ? `External source is locked by ${blocker.ownerType}:${blocker.ownerId}` : `External source is locked: ${sourceKey}`,
      }],
    });
  }

  try {
    const adapter = createGitHubExternalWorkAdapter({ fetch: input.fetch });
    const candidates = await adapter.loadCandidates({
      repository,
      events: input.workflowDefinition.config.source.events,
      activeStates: input.workflowDefinition.config.source.activeStates,
      token: input.githubToken,
      limit: input.limit,
    });
    const response = emptyPollResponse({ candidates: candidates.length });
    for (const item of candidates) {
      await processCandidate({
        ...input,
        store: input.store,
        channel,
        item,
        sourceKey,
        pollOwnerId,
        now,
        externalToken: input.githubToken,
        response,
      });
    }
    return response;
  } finally {
    input.store.releaseResourceLeasesForOwner("system", pollOwnerId, new Date().toISOString());
  }
}

export async function pollLinearExternalWork(input: ExternalWorkPollLinearInput): Promise<ExternalWorkPollResponse> {
  if (input.workflowDefinition.config.source.kind !== "linear") {
    throw new ExternalWorkflowValidationError(`Unsupported external source kind: ${input.workflowDefinition.config.source.kind}`);
  }
  const projectSlug = input.workflowDefinition.config.source.projectSlug;
  if (!projectSlug) {
    throw new ExternalWorkflowValidationError("WORKFLOW.md source.projectSlug is required.");
  }
  const channel = requireChannel(input.store, input.channelId);
  const now = input.now ?? new Date().toISOString();
  const sourceKey = `linear:${projectSlug}`;
  const pollOwnerId = `external_work_poll:${sourceKey}:${Date.parse(now) || Date.now()}`;
  const sourceLease = input.store.acquireResourceLease({
    workspaceId: DEFAULT_WORKSPACE_ID,
    resourceType: "external_source",
    resourceKey: sourceKey,
    ownerType: "system",
    ownerId: pollOwnerId,
    acquiredAt: now,
    expiresAt: addMilliseconds(now, EXTERNAL_WORK_LEASE_TTL_MS),
  });
  if (!sourceLease) {
    const blocker = input.store.getBlockingResourceLease("external_source", sourceKey);
    return emptyPollResponse({
      blocked: 1,
      results: [{
        action: "blocked",
        message: blocker ? `External source is locked by ${blocker.ownerType}:${blocker.ownerId}` : `External source is locked: ${sourceKey}`,
      }],
    });
  }

  try {
    const adapter = createLinearExternalWorkAdapter({ fetch: input.fetch });
    const candidates = await adapter.loadCandidates({
      repository: projectSlug,
      events: input.workflowDefinition.config.source.events,
      activeStates: input.workflowDefinition.config.source.activeStates,
      token: input.linearToken,
      limit: input.limit,
    });
    const response = emptyPollResponse({ candidates: candidates.length });
    for (const item of candidates) {
      await processCandidate({
        ...input,
        store: input.store,
        channel,
        item,
        sourceKey,
        pollOwnerId,
        now,
        externalToken: input.linearToken,
        response,
      });
    }
    return response;
  } finally {
    input.store.releaseResourceLeasesForOwner("system", pollOwnerId, new Date().toISOString());
  }
}

export async function reconcileExternalWork(input: ExternalWorkReconcileInput): Promise<ExternalWorkReconcileResponse> {
  const now = input.now ?? new Date().toISOString();
  const expiredLeases = input.store.expireResourceLeases(now);
  const states = input.store.listExternalWorkSchedulerStates({ channelId: input.channelId, limit: 500 });
  const adapter = input.workflowDefinition?.config.source.kind === "github"
    ? createGitHubExternalWorkAdapter({ fetch: input.fetch })
    : undefined;
  const repository = input.workflowDefinition?.config.source.repository;
  const terminalStates = new Set((input.workflowDefinition?.config.source.terminalStates ?? []).map((state) => state.toLowerCase()));
  let checked = 0;
  let blocked = 0;
  let retryReady = 0;
  let terminal = 0;
  const changed: ExternalWorkSchedulerState[] = [];

  for (const state of states) {
    checked += 1;
    const workflow = input.store.getChannelWorkflow(state.workflowId);
    const step = input.store.getChannelWorkflowStep(state.workflowStepId);
    if (!workflow || !step) {
      const updated = input.store.updateExternalWorkSchedulerState(state.externalWorkId, {
        schedulerStatus: "blocked",
        lastErrorCode: "missing_workflow_state",
        lastErrorMessage: `Workflow or workflow step is missing for external work: ${state.externalWorkId}`,
        lastReconciledAt: now,
      }, now);
      if (updated) {
        changed.push(updated);
      }
      blocked += 1;
      continue;
    }
    if (isTerminalWorkflowStatus(workflow.status) || isTerminalWorkflowStepStatus(step.status)) {
      const updated = input.store.updateExternalWorkSchedulerState(state.externalWorkId, {
        schedulerStatus: "terminal",
        lastReconciledAt: now,
      }, now);
      if (updated) {
        changed.push(updated);
      }
      terminal += 1;
      continue;
    }
    if (state.schedulerStatus === "retry_wait" && state.nextAttemptAt && state.nextAttemptAt <= now) {
      const updated = input.store.updateExternalWorkSchedulerState(state.externalWorkId, {
        schedulerStatus: "blocked",
        nextAttemptAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        lastReconciledAt: now,
      }, now);
      if (updated) {
        changed.push(updated);
      }
      retryReady += 1;
      continue;
    }
    if (adapter && repository) {
      const externalWork = input.store.getExternalWorkRecord(state.externalWorkId);
      const number = externalWork ? parseIdentifierNumber(externalWork.identifier) : undefined;
      if (externalWork && number !== undefined && (externalWork.workItemKind === "github_pull_request" || externalWork.workItemKind === "github_issue")) {
        const remote = await adapter.getWorkItem({
          repository,
          kind: externalWork.workItemKind,
          number,
          token: input.githubToken,
        });
        if (remote && terminalStates.has(remote.state.toLowerCase())) {
          const updated = input.store.updateExternalWorkSchedulerState(state.externalWorkId, {
            schedulerStatus: "terminal",
            lastReconciledAt: now,
          }, now);
          if (updated) {
            changed.push(updated);
          }
          terminal += 1;
          continue;
        }
      }
    }
    const updated = input.store.updateExternalWorkSchedulerState(state.externalWorkId, { lastReconciledAt: now }, now);
    if (updated) {
      changed.push(updated);
    }
  }

  return { expiredLeases, checked, blocked, retryReady, terminal, schedulerStates: changed };
}

async function processCandidate(input: {
  readonly store: ExternalWorkSchedulerStore;
  readonly cwd: string;
  readonly channel: Channel;
  readonly channelId: string;
  readonly workflowDefinition: ExternalWorkflowDefinition;
  readonly workflowDirectory: string;
  readonly externalToken?: string;
  readonly item: ExternalWorkItem;
  readonly sourceKey: string;
  readonly pollOwnerId: string;
  readonly now: string;
  readonly executeHooks?: boolean;
  readonly response: MutablePollResponse;
}): Promise<void> {
  const activeStates = new Set(input.workflowDefinition.config.source.activeStates.map((state) => state.toLowerCase()));
  const terminalStates = new Set(input.workflowDefinition.config.source.terminalStates.map((state) => state.toLowerCase()));
  const state = input.item.state.toLowerCase();
  if (!activeStates.has(state)) {
    input.response.terminalIgnored += terminalStates.has(state) ? 1 : 0;
    input.response.results.push({
      subjectKey: input.item.id,
      identifier: input.item.identifier,
      action: "terminal_ignored",
      message: `External work item state is not active: ${input.item.state}`,
    });
    return;
  }

  const subjectLease = input.store.acquireResourceLease({
    workspaceId: DEFAULT_WORKSPACE_ID,
    resourceType: "external_subject",
    resourceKey: input.item.id,
    ownerType: "system",
    ownerId: `${input.pollOwnerId}:${hashText(input.item.id).slice(0, 12)}`,
    acquiredAt: input.now,
    expiresAt: addMilliseconds(input.now, EXTERNAL_WORK_LEASE_TTL_MS),
  });
  if (!subjectLease) {
    input.response.blocked += 1;
    input.response.results.push({
      subjectKey: input.item.id,
      identifier: input.item.identifier,
      action: "blocked",
      message: `External subject is locked: ${input.item.id}`,
    });
    return;
  }

  try {
    const active = input.store.findActiveExternalWorkSchedulerState(input.sourceKey, input.item.id);
    const activeRecord = active ? input.store.getExternalWorkRecord(active.externalWorkId) : undefined;
    const retryDue = active?.schedulerStatus === "retry_wait" && active.nextAttemptAt !== undefined && active.nextAttemptAt <= input.now;
    if (active && !(retryDue && activeRecord?.idempotencyKey === input.item.idempotencyKey)) {
      const duplicate = activeRecord?.idempotencyKey === input.item.idempotencyKey;
      input.response[duplicate ? "duplicates" : "blocked"] += 1;
      input.response.results.push({
        subjectKey: input.item.id,
        identifier: input.item.identifier,
        action: duplicate ? "duplicate" : "blocked",
        externalWorkId: active.externalWorkId,
        workflowId: active.workflowId,
        workflowStepId: active.workflowStepId,
        schedulerStatus: active.schedulerStatus,
        message: duplicate ? "External subject already has active scheduler state." : "External subject has active scheduler state for another idempotency key.",
      });
      input.response.schedulerStates.push(active);
      return;
    }

    const renderedPrompt = renderExternalWorkflowPrompt(input.workflowDefinition.promptTemplate, { item: input.item });
    const imported = input.store.createOrReuseExternalWorkWorkflow({
      channelId: input.channelId,
      externalWorkItem: input.item,
      workflowDefinition: input.workflowDefinition,
      renderedPrompt,
    }, input.now);
    const existingSchedulerState = input.store.getExternalWorkSchedulerState(imported.externalWork.id);
    const attemptCount = retryDue ? (existingSchedulerState?.attemptCount ?? 0) + 1 : existingSchedulerState?.attemptCount ?? 0;
    const workspace = allocateExternalWorkspace({
      cwd: input.cwd,
      channel: input.channel,
      workflowDirectory: input.workflowDirectory,
      workflowDefinition: input.workflowDefinition,
      subjectKey: input.item.id,
      attemptCount,
    });
    mkdirSync(workspace.root, { recursive: true });
    const createdWorkspace = !existsSync(workspace.path);
    mkdirSync(workspace.path, { recursive: true });
    const evidenceArtifacts = imported.duplicate
      ? input.store.listExternalWorkArtifacts(imported.externalWork.id)
      : createExternalWorkEvidenceArtifacts(input.store, imported.externalWork.id, input.item, renderedPrompt, input.now);
    const evidenceIds = evidenceArtifacts.map((artifact) => artifact.id);
    const schedulerState = input.store.upsertExternalWorkSchedulerState({
      externalWorkId: imported.externalWork.id,
      channelId: input.channelId,
      subjectKey: input.item.id,
      sourceKey: input.sourceKey,
      workflowId: imported.workflow.id,
      workflowStepId: imported.workflowStep.id,
      schedulerStatus: "workspace_preparing",
      attemptCount,
      lastAttemptAt: input.now,
      maxRetryBackoffMs: input.workflowDefinition.config.scheduler.maxRetryBackoffMs,
      workspacePath: workspace.path,
      workspaceMode: workspace.mode,
      hookArtifactIds: existingSchedulerState?.hookArtifactIds ?? [],
    }, input.now);

    const hookArtifacts = input.executeHooks
      ? await runWorkspaceHooks({
        store: input.store,
        externalWorkId: imported.externalWork.id,
        channel: input.channel,
        workspacePath: workspace.path,
        hooks: input.workflowDefinition.config.hooks,
        runAfterCreate: createdWorkspace,
        ownerId: `${input.pollOwnerId}:hooks:${hashText(imported.externalWork.id).slice(0, 12)}`,
        now: input.now,
        extraSecrets: [input.externalToken],
      })
      : [];
    const allArtifactIds = uniqueStrings([...imported.externalWork.artifactIds, ...evidenceIds, ...hookArtifacts.map((artifact) => artifact.id)]);
    input.store.updateExternalWorkArtifacts(imported.externalWork.id, allArtifactIds, new Date().toISOString());
    const ready = input.store.updateExternalWorkSchedulerState(imported.externalWork.id, {
      schedulerStatus: "ready",
      hookArtifactIds: uniqueStrings([...schedulerState.hookArtifactIds, ...hookArtifacts.map((artifact) => artifact.id)]),
      lastErrorCode: null,
      lastErrorMessage: null,
      nextAttemptAt: null,
    }, new Date().toISOString());
    input.response.artifacts.push(...evidenceArtifacts, ...hookArtifacts);
    input.response[imported.duplicate ? "duplicates" : "claimed"] += 1;
    input.response.results.push({
      subjectKey: input.item.id,
      identifier: input.item.identifier,
      action: imported.duplicate ? "duplicate" : "claimed",
      externalWorkId: imported.externalWork.id,
      workflowId: imported.workflow.id,
      workflowStepId: imported.workflowStep.id,
      schedulerStatus: ready?.schedulerStatus ?? "ready",
    });
    if (ready) {
      input.response.schedulerStates.push(ready);
    }
  } catch (error) {
    if (isCoreOriginalLaunchRefusal(error)) throw error;
    const externalWork = input.store.getExternalWorkRecordByIdempotency(input.item.sourceKind, input.item.idempotencyKey);
    if (!externalWork) {
      input.response.blocked += 1;
      input.response.results.push({
        subjectKey: input.item.id,
        identifier: input.item.identifier,
        action: "blocked",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const previous = input.store.getExternalWorkSchedulerState(externalWork.id);
    const hookArtifacts = error instanceof WorkspaceHookExecutionError ? error.artifacts : [];
    if (hookArtifacts.length > 0) {
      input.store.updateExternalWorkArtifacts(
        externalWork.id,
        uniqueStrings([...externalWork.artifactIds, ...hookArtifacts.map((artifact) => artifact.id)]),
        new Date().toISOString(),
      );
      input.response.artifacts.push(...hookArtifacts);
    }
    const attemptCount = (previous?.attemptCount ?? 0) + 1;
    const retryAt = addMilliseconds(input.now, retryBackoffMs(attemptCount, input.workflowDefinition.config.scheduler.maxRetryBackoffMs));
    const retryState = input.store.upsertExternalWorkSchedulerState({
      externalWorkId: externalWork.id,
      channelId: input.channelId,
      subjectKey: input.item.id,
      sourceKey: input.sourceKey,
      workflowId: externalWork.workflowId,
      workflowStepId: externalWork.workflowStepId,
      schedulerStatus: "retry_wait",
      attemptCount,
      lastAttemptAt: input.now,
      nextAttemptAt: retryAt,
      maxRetryBackoffMs: input.workflowDefinition.config.scheduler.maxRetryBackoffMs,
      lastErrorCode: "poll_candidate_failed",
      lastErrorMessage: error instanceof Error ? error.message : String(error),
      workspacePath: previous?.workspacePath,
      workspaceMode: previous?.workspaceMode,
      hookArtifactIds: uniqueStrings([...(previous?.hookArtifactIds ?? []), ...hookArtifacts.map((artifact) => artifact.id)]),
    }, new Date().toISOString());
    input.response.retryScheduled += 1;
    input.response.results.push({
      subjectKey: input.item.id,
      identifier: input.item.identifier,
      action: "retry_scheduled",
      externalWorkId: externalWork.id,
      workflowId: externalWork.workflowId,
      workflowStepId: externalWork.workflowStepId,
      schedulerStatus: "retry_wait",
      message: retryState.lastErrorMessage,
    });
    input.response.schedulerStates.push(retryState);
  } finally {
    input.store.releaseResourceLeasesForOwner("system", subjectLease.ownerId, new Date().toISOString());
  }
}

function createExternalWorkEvidenceArtifacts(
  store: ExternalWorkSchedulerStore,
  externalWorkId: string,
  externalWorkItem: ExternalWorkItem,
  renderedPrompt: string,
  createdAt: string,
): RunArtifact[] {
  const artifactDir = resolvePath(store.paths.artifactsDir, "external-work", externalWorkId);
  mkdirSync(artifactDir, { recursive: true });
  const itemJson = `${JSON.stringify(externalWorkItem, null, 2)}\n`;
  const itemPath = resolvePath(artifactDir, "normalized-item.json");
  writeFileSync(itemPath, itemJson, "utf8");
  const promptText = `${renderedPrompt.trim()}\n`;
  const promptPath = resolvePath(artifactDir, "rendered-prompt.md");
  writeFileSync(promptPath, promptText, "utf8");
  return [
    store.createArtifact({
      externalWorkId,
      type: "json",
      path: normalizeArtifactPath(relative(store.paths.artifactsDir, itemPath)),
      title: "Normalized external work item",
      contentType: "application/json; charset=utf-8",
      sizeBytes: Buffer.byteLength(itemJson, "utf8"),
      createdAt,
    }),
    store.createArtifact({
      externalWorkId,
      type: "markdown",
      path: normalizeArtifactPath(relative(store.paths.artifactsDir, promptPath)),
      title: "Rendered workflow prompt",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: Buffer.byteLength(promptText, "utf8"),
      createdAt,
    }),
  ];
}

async function runWorkspaceHooks(input: {
  readonly store: ExternalWorkSchedulerStore;
  readonly externalWorkId: string;
  readonly channel: Channel;
  readonly workspacePath: string;
  readonly hooks: ExternalWorkflowDefinition["config"]["hooks"];
  readonly runAfterCreate: boolean;
  readonly ownerId: string;
  readonly now: string;
  readonly extraSecrets: readonly (string | undefined)[];
}): Promise<RunArtifact[]> {
  const leases = [
    input.store.acquireResourceLease({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "external_workspace",
      resourceKey: input.workspacePath,
      ownerType: "system",
      ownerId: input.ownerId,
      acquiredAt: input.now,
      expiresAt: addMilliseconds(input.now, EXTERNAL_WORK_LEASE_TTL_MS),
    }),
    input.store.acquireResourceLease({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "bound_path",
      resourceKey: input.channel.boundPath ?? input.workspacePath,
      ownerType: "system",
      ownerId: input.ownerId,
      acquiredAt: input.now,
      expiresAt: addMilliseconds(input.now, EXTERNAL_WORK_LEASE_TTL_MS),
    }),
  ];
  if (leases.some((lease) => lease === undefined)) {
    input.store.releaseResourceLeasesForOwner("system", input.ownerId, new Date().toISOString());
    throw new Error("Workspace hook lease conflict.");
  }
  try {
    const artifacts: RunArtifact[] = [];
    if (input.runAfterCreate && input.hooks.afterCreate) {
      const result = await runWorkspaceHookCommand({ ...input, name: "afterCreate", command: input.hooks.afterCreate });
      artifacts.push(result.artifact);
      if (result.errorMessage) {
        throw new WorkspaceHookExecutionError(result.errorMessage, artifacts);
      }
    }
    if (input.hooks.beforeRun) {
      const result = await runWorkspaceHookCommand({ ...input, name: "beforeRun", command: input.hooks.beforeRun });
      artifacts.push(result.artifact);
      if (result.errorMessage) {
        throw new WorkspaceHookExecutionError(result.errorMessage, artifacts);
      }
    }
    return artifacts;
  } finally {
    input.store.releaseResourceLeasesForOwner("system", input.ownerId, new Date().toISOString());
  }
}

async function runWorkspaceHookCommand(input: {
  readonly store: ExternalWorkSchedulerStore;
  readonly externalWorkId: string;
  readonly workspacePath: string;
  readonly hooks: ExternalWorkflowDefinition["config"]["hooks"];
  readonly name: "afterCreate" | "beforeRun";
  readonly command: string;
  readonly now: string;
  readonly extraSecrets: readonly (string | undefined)[];
}): Promise<{ readonly artifact: RunArtifact; readonly errorMessage?: string }> {
  const startedAt = Date.now();
  const result = await runShellCommand(input.command, input.workspacePath, input.hooks.timeoutMs);
  const durationMs = Date.now() - startedAt;
  const payload = redactSecrets({
    hook: input.name,
    command: input.command,
    cwd: input.workspacePath,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
  }, input.extraSecrets);
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  const artifactDir = resolvePath(input.store.paths.artifactsDir, "external-work", input.externalWorkId, "hooks");
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = resolvePath(artifactDir, `${Date.now()}-${input.name}.json`);
  writeFileSync(artifactPath, content, "utf8");
  const artifact = input.store.createArtifact({
    externalWorkId: input.externalWorkId,
    type: "json",
    path: normalizeArtifactPath(relative(input.store.paths.artifactsDir, artifactPath)),
    title: `External work hook: ${input.name}`,
    contentType: "application/json; charset=utf-8",
    sizeBytes: Buffer.byteLength(content, "utf8"),
    createdAt: new Date().toISOString(),
  });
  const errorMessage = result.timedOut
    ? `Workspace hook timed out: ${input.name}`
    : result.exitCode !== 0
      ? `Workspace hook failed: ${input.name} exited ${result.exitCode}`
      : undefined;
  return { artifact, errorMessage };
}

class WorkspaceHookExecutionError extends Error {
  constructor(message: string, readonly artifacts: readonly RunArtifact[]) {
    super(message);
    this.name = "WorkspaceHookExecutionError";
  }
}

function runShellCommand(command: string, cwd: string, timeoutMs: number): Promise<{ readonly exitCode: number | null; readonly timedOut: boolean; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolveRun) => {
    const record = originalExternalWorkHook.capture(Object.freeze({ command, cwd }));
    const child = CORE_EXTERNAL_WORK_SCHEDULER_ENTRY.invoke(record);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout = appendLimited(stdout, String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendLimited(stderr, String(chunk));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveRun({ exitCode: 1, timedOut, stdout, stderr: appendLimited(stderr, error.message) });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolveRun({ exitCode, timedOut, stdout, stderr });
    });
  });
}

function allocateExternalWorkspace(input: {
  readonly cwd: string;
  readonly channel: Channel;
  readonly workflowDirectory: string;
  readonly workflowDefinition: ExternalWorkflowDefinition;
  readonly subjectKey: string;
  readonly attemptCount: number;
}): { readonly root: string; readonly path: string; readonly mode: ExternalWorkspaceMode } {
  const mode = input.workflowDefinition.config.workspace.mode;
  const root = input.workflowDefinition.config.workspace.root
    ? resolvePath(input.workflowDirectory, input.workflowDefinition.config.workspace.root)
    : resolvePath(input.channel.boundPath ?? input.cwd, ".ling-stack", "external-workspaces", input.workflowDefinition.config.source.kind);
  const subjectDir = hashText(input.subjectKey).slice(0, 24);
  const path = mode === "per_attempt"
    ? resolvePath(root, subjectDir, `attempt-${input.attemptCount + 1}`)
    : resolvePath(root, subjectDir);
  if (!isPathInsideRoot(root, path)) {
    throw new Error("External work workspace path must stay inside workspace.root.");
  }
  return { root, path, mode };
}

function emptyPollResponse(input: Partial<MutablePollResponse> = {}): MutablePollResponse {
  return {
    candidates: input.candidates ?? 0,
    claimed: input.claimed ?? 0,
    duplicates: input.duplicates ?? 0,
    blocked: input.blocked ?? 0,
    retryScheduled: input.retryScheduled ?? 0,
    terminalIgnored: input.terminalIgnored ?? 0,
    artifacts: [...(input.artifacts ?? [])],
    results: [...(input.results ?? [])],
    schedulerStates: [...(input.schedulerStates ?? [])],
  };
}

type MutablePollResponse = {
  candidates: number;
  claimed: number;
  duplicates: number;
  blocked: number;
  retryScheduled: number;
  terminalIgnored: number;
  artifacts: RunArtifact[];
  results: ExternalWorkPollResultItem[];
  schedulerStates: ExternalWorkSchedulerState[];
};

const LINEAR_ISSUES_QUERY = `
query LingStackExternalWorkIssues($first: Int!) {
  issues(first: $first) {
    nodes {
      id
      identifier
      title
      description
      url
      priority
      branchName
      updatedAt
      state {
        name
        type
      }
      labels {
        nodes {
          name
        }
      }
      project {
        name
        slug
      }
      team {
        key
        name
      }
    }
  }
}
`;

async function linearGraphQL(
  fetchImpl: FetchLike,
  url: string,
  token: string | undefined,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "ling-stack-external-work",
      ...(token ? { Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      body = "";
    }
    throw new Error(`Linear read-only request failed: ${response.status} ${response.statusText}${body ? ` ${body.slice(0, 300)}` : ""}`);
  }
  const value = await response.json();
  if (isRecord(value) && Array.isArray(value.errors) && value.errors.length > 0) {
    throw new Error(`Linear read-only request failed: ${JSON.stringify(value.errors).slice(0, 300)}`);
  }
  return value;
}

function readLinearIssueNodes(value: unknown): readonly Record<string, unknown>[] {
  const root = readRecord(value, "Linear response");
  const data = readRecord(root.data, "Linear response data");
  const issues = readRecord(data.issues, "Linear issues");
  if (!Array.isArray(issues.nodes)) {
    throw new Error("Linear issues response must include nodes.");
  }
  return issues.nodes.map((node, index) => readRecord(node, `Linear issue node ${index}`));
}

function matchesLinearProject(issue: Record<string, unknown>, projectSlug: string): boolean {
  const project = isRecord(issue.project) ? issue.project : undefined;
  const slug = typeof project?.slug === "string" ? project.slug : undefined;
  const name = typeof project?.name === "string" ? project.name : undefined;
  return !projectSlug || slug === projectSlug || name === projectSlug;
}

function readLinearIdentifier(issue: Record<string, unknown>): string {
  const identifier = issue.identifier;
  if (typeof identifier !== "string" || !identifier.trim()) {
    throw new Error("Linear issue identifier is required.");
  }
  return identifier.trim();
}

function pickLinearEvent(events: readonly string[], fallback: string): string {
  return events.find((event) => event === "issue" || event.startsWith("issue.")) ?? fallback;
}

async function githubJsonArray(fetchImpl: FetchLike, url: string, token: string | undefined): Promise<readonly unknown[]> {
  const value = await githubJson(fetchImpl, url, token);
  if (!Array.isArray(value)) {
    throw new Error(`GitHub response must be an array: ${url}`);
  }
  return value;
}

async function githubJson(fetchImpl: FetchLike, url: string, token: string | undefined): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "ling-stack-external-work",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      body = "";
    }
    throw new Error(`GitHub read-only request failed: ${response.status} ${response.statusText}${body ? ` ${body.slice(0, 300)}` : ""}`);
  }
  return await response.json();
}

function shouldLoadGitHubKind(events: readonly string[], kind: "pull_request" | "issue"): boolean {
  return events.length === 0 || events.some((event) => event === `${kind}.*` || event === kind || event.startsWith(`${kind}.`));
}

function pickGitHubEvent(events: readonly string[], kind: "pull_request" | "issue", fallback: string): string {
  return events.find((event) => event === kind || event.startsWith(`${kind}.`)) ?? fallback;
}

function parseRepositoryFullName(fullName: string): { readonly owner: string; readonly name: string } {
  const [owner, name] = fullName.split("/");
  if (!owner || !name) {
    throw new ExternalWorkflowValidationError(`Invalid GitHub repository full name: ${fullName}`);
  }
  return { owner, name };
}

function githubRepositoryPayload(fullName: string, repository: { readonly owner: string; readonly name: string }): Record<string, unknown> {
  return {
    name: repository.name,
    full_name: fullName,
    default_branch: "main",
    owner: { login: repository.owner },
  };
}

function readGitHubNumber(value: unknown): number {
  if (!isRecord(value) || typeof value.number !== "number") {
    throw new Error("GitHub candidate number is required.");
  }
  return value.number;
}

function requireChannel(store: ExternalWorkSchedulerStore, channelId: string): Channel {
  const channel = store.getChannel(channelId);
  if (!channel) {
    throw new Error(`Channel not found: ${channelId}`);
  }
  return channel;
}

function addMilliseconds(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

function retryBackoffMs(attemptCount: number, maxRetryBackoffMs: number): number {
  return Math.min(maxRetryBackoffMs, INITIAL_RETRY_BACKOFF_MS * (2 ** Math.max(0, attemptCount - 1)));
}

function clampLimit(value: number | undefined): number {
  return Math.min(Math.max(value ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isPathInsideRoot(root: string, path: string): boolean {
  const relativePath = relative(resolvePath(root), resolvePath(path));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function normalizeArtifactPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function appendLimited(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-64_000);
}

function parseIdentifierNumber(identifier: string): number | undefined {
  const match = identifier.match(/#(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

function isTerminalWorkflowStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function isTerminalWorkflowStepStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "skipped" || status === "cancelled";
}

function readRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
