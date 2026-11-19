import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import { DEFAULT_WORKSPACE_ID, type Channel } from "./workspace-types.js";
import { isCoreOriginalLaunchRefusal } from "./original-host-process-entry.js";
import { runWorkspacePreparation, WorkspacePreparationError } from "./external-work-workspace.js";
import { getExternalSourceRegistration } from "./external-work-source-registry.js";
export { CORE_EXTERNAL_WORK_SCHEDULER_ENTRY } from "./external-work-workspace.js";
export {
  createGitHubExternalWorkAdapter, createLinearExternalWorkAdapter,
  type GitHubExternalWorkAdapterOptions, type LinearExternalWorkAdapterOptions,
} from "./external-work-source-adapters.js";
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
  renderExternalWorkflowPrompt,
  ExternalWorkflowValidationError,
} from "./external-work.js";
import type {
  ExternalWorkFetchLike as FetchLike,
  ExternalWorkItem,
  ExternalWorkPollResponse,
  ExternalWorkPollResultItem,
  ExternalWorkReconcileResponse,
  ExternalWorkSchedulerState,
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

export interface ExternalWorkPollInput {
  readonly store: ExternalWorkSchedulerStore;
  readonly cwd: string;
  readonly channelId: string;
  readonly workflowDefinition: ExternalWorkflowDefinition;
  readonly workflowDirectory: string;
  readonly token?: string;
  readonly fetch?: FetchLike;
  readonly limit?: number;
  readonly executeHooks?: boolean;
  readonly now?: string;
}

export interface ExternalWorkPollGitHubInput extends Omit<ExternalWorkPollInput, "token"> {
  readonly githubToken?: string;
}

export interface ExternalWorkPollLinearInput extends Omit<ExternalWorkPollInput, "token"> {
  readonly linearToken?: string;
}

export interface ExternalWorkReconcileInput {
  readonly store: ExternalWorkSchedulerStore;
  readonly channelId?: string;
  readonly workflowDefinition?: ExternalWorkflowDefinition;
  readonly token?: string;
  readonly githubToken?: string;
  readonly fetch?: FetchLike;
  readonly now?: string;
}

const EXTERNAL_WORK_LEASE_TTL_MS = 15 * 60 * 1000;
const INITIAL_RETRY_BACKOFF_MS = 1_000;
export async function pollGitHubExternalWork(input: ExternalWorkPollGitHubInput): Promise<ExternalWorkPollResponse> {
  if (input.workflowDefinition.config.source.kind !== "github") {
    throw new ExternalWorkflowValidationError(`Unsupported external source kind: ${input.workflowDefinition.config.source.kind}`);
  }
  return pollExternalWork({ ...input, token: input.githubToken });
}

export async function pollLinearExternalWork(input: ExternalWorkPollLinearInput): Promise<ExternalWorkPollResponse> {
  if (input.workflowDefinition.config.source.kind !== "linear") {
    throw new ExternalWorkflowValidationError(`Unsupported external source kind: ${input.workflowDefinition.config.source.kind}`);
  }
  return pollExternalWork({ ...input, token: input.linearToken });
}

export async function pollExternalWork(input: ExternalWorkPollInput): Promise<ExternalWorkPollResponse> {
  const registration = getExternalSourceRegistration(input.workflowDefinition.config.source.kind);
  const target = registration.resolveTarget(input.workflowDefinition.config.source);
  const channel = requireChannel(input.store, input.channelId);
  const now = input.now ?? new Date().toISOString();
  const sourceKey = registration.sourceKey(target);
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
    const adapter = registration.createAdapter({ fetch: input.fetch });
    const candidates = await adapter.loadCandidates({
      target,
      events: input.workflowDefinition.config.source.events,
      activeStates: input.workflowDefinition.config.source.activeStates,
      token: input.token,
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
        externalToken: input.token,
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
  const registration = input.workflowDefinition
    ? getExternalSourceRegistration(input.workflowDefinition.config.source.kind)
    : undefined;
  const target = registration?.supportsRemoteTerminalReconcile && input.workflowDefinition
    ? registration.resolveTarget(input.workflowDefinition.config.source)
    : undefined;
  const adapter = target ? registration!.createAdapter({ fetch: input.fetch }) : undefined;
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
    if (adapter && target && registration && state.sourceKey === registration.sourceKey(target)) {
      const externalWork = input.store.getExternalWorkRecord(state.externalWorkId);
      const number = externalWork ? parseIdentifierNumber(externalWork.identifier) : undefined;
      if (externalWork && number !== undefined && externalWork.sourceKind === registration.kind
        && registration.workItemKinds.includes(externalWork.workItemKind)) {
        const remote = await adapter.getWorkItem({
          target,
          kind: externalWork.workItemKind,
          number,
          token: input.token ?? input.githubToken,
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

    const hookArtifacts = await runWorkspacePreparation({
      store: input.store,
      externalWorkId: imported.externalWork.id,
      channel: input.channel,
      workspacePath: workspace.path,
      hooks: input.workflowDefinition.config.hooks,
      gitRemoteUrl: input.workflowDefinition.config.workspace.gitRemoteUrl,
      previousCheckoutFailed: existingSchedulerState?.workspacePath === workspace.path
        && existingSchedulerState.lastErrorCode?.startsWith("workspace_checkout_") === true,
      executeHooks: input.executeHooks === true,
      runAfterCreate: createdWorkspace,
      ownerId: `${input.pollOwnerId}:hooks:${hashText(imported.externalWork.id).slice(0, 12)}`,
      now: input.now,
      extraSecrets: [input.externalToken],
    });
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
    const hookArtifacts = error instanceof WorkspacePreparationError ? error.artifacts : [];
    if (hookArtifacts.length > 0) {
      input.store.updateExternalWorkArtifacts(
        externalWork.id,
        uniqueStrings([...externalWork.artifactIds, ...hookArtifacts.map((artifact) => artifact.id)]),
        new Date().toISOString(),
      );
      input.response.artifacts.push(...hookArtifacts);
    }
    const checkoutFailed = error instanceof WorkspacePreparationError && error.checkoutFailed;
    const attemptCount = (previous?.attemptCount ?? 0) + 1;
    const retryAt = addMilliseconds(input.now, retryBackoffMs(attemptCount, input.workflowDefinition.config.scheduler.maxRetryBackoffMs));
    const retryState = input.store.upsertExternalWorkSchedulerState({
      externalWorkId: externalWork.id,
      channelId: input.channelId,
      subjectKey: input.item.id,
      sourceKey: input.sourceKey,
      workflowId: externalWork.workflowId,
      workflowStepId: externalWork.workflowStepId,
      schedulerStatus: checkoutFailed ? "blocked" : "retry_wait",
      attemptCount,
      lastAttemptAt: input.now,
      nextAttemptAt: checkoutFailed ? undefined : retryAt,
      maxRetryBackoffMs: input.workflowDefinition.config.scheduler.maxRetryBackoffMs,
      lastErrorCode: checkoutFailed ? "workspace_checkout_failed" : "poll_candidate_failed",
      lastErrorMessage: error instanceof Error ? error.message : String(error),
      workspacePath: previous?.workspacePath,
      workspaceMode: previous?.workspaceMode,
      hookArtifactIds: uniqueStrings([...(previous?.hookArtifactIds ?? []), ...hookArtifacts.map((artifact) => artifact.id)]),
    }, new Date().toISOString());
    input.response[checkoutFailed ? "blocked" : "retryScheduled"] += 1;
    input.response.results.push({
      subjectKey: input.item.id,
      identifier: input.item.identifier,
      action: checkoutFailed ? "blocked" : "retry_scheduled",
      externalWorkId: externalWork.id,
      workflowId: externalWork.workflowId,
      workflowStepId: externalWork.workflowStepId,
      schedulerStatus: retryState.schedulerStatus,
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
