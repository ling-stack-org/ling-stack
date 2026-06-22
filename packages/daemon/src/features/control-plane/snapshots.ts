import type {
  ApprovalSummary,
  ApprovalsDomainSnapshot,
  ArtifactSummary,
  ArtifactsDomainSnapshot,
  McpDomainSnapshot,
  McpServerSummary,
  MemoryCandidateSummary,
  MemoryDomainSnapshot,
  ProviderSummary,
  ProvidersDomainSnapshot,
  RunnerSummary,
  RunnersDomainSnapshot,
  RunsDomainSnapshot,
  RunSummary,
  SkillRegistrySummary,
  SkillsDomainSnapshot,
  TeammateSummary,
  TeammatesDomainSnapshot,
  WorkUnitsDomainSnapshot,
  WorkUnitSummary,
} from "@ling-stack/contracts";
import type {
  ApprovalPolicy,
  ApprovalRequest,
  ControlPlaneDomain,
  MemoryObject,
  ProviderPreset,
  RunArtifact,
  RunSession,
  RunStore,
  SecretResolver,
  WorkUnit,
} from "@ling-stack/core";
import { parseSecretRef } from "@ling-stack/core";
import type { DaemonContext } from "../../context.js";
import { providerSecretStatus } from "../providers/secrets.js";
import { mcpServerSecretRefs } from "../mcp/secrets.js";
import { getSkillRegistryGeneration, listEffectiveSkillRegistryEntries } from "../skills/registry.js";
import { listActiveWorkUnits, isStuckWorkUnit } from "../../runtime/work-units.js";
import { listRunnerItems, loadWorkspaceRuntimeSettings } from "../../runtime/runner-settings.js";
import { listRunnerReadinessSummaries } from "../../runtime/runner-readiness.js";

export function readControlPlaneDomainSnapshot(
  domain: ControlPlaneDomain,
  input: {
    readonly cwd: string;
    readonly store: RunStore;
    readonly context: DaemonContext;
    readonly now: string;
  },
): ControlPlaneSnapshotData {
  switch (domain) {
    case "runs":
      return readRunsSnapshot(input.cwd, input.store);
    case "work_units":
      return readWorkUnitsSnapshot(input.store);
    case "skills":
      return readSkillsSnapshot(input.store);
    case "teammates":
      return readTeammatesSnapshot(input.store);
    case "approvals":
      return readApprovalsSnapshot(input.store, input.now);
    case "providers":
      return readProvidersSnapshot(input.store, input.context.secretResolver);
    case "memory":
      return readMemorySnapshot(input.store);
    case "mcp":
      return readMcpSnapshot(input.store, input.context.secretResolver, input.now);
    case "runners":
      return readRunnersSnapshot(input.store, input.context);
    case "artifacts":
      return readArtifactsSnapshot(input.store, input.cwd);
  }
}

type ControlPlaneSnapshotData =
  | RunsDomainSnapshot
  | WorkUnitsDomainSnapshot
  | SkillsDomainSnapshot
  | TeammatesDomainSnapshot
  | ApprovalsDomainSnapshot
  | ProvidersDomainSnapshot
  | MemoryDomainSnapshot
  | McpDomainSnapshot
  | RunnersDomainSnapshot
  | ArtifactsDomainSnapshot;

function readRunsSnapshot(cwd: string, store: RunStore): RunsDomainSnapshot {
  const recentRuns = store.listRuns({ limit: 20 });
  const activeRuns = recentRuns.filter((run) => ["queued", "running", "waiting_for_approval"].includes(run.status));
  const stuckWorkUnits = listActiveWorkUnits(store).filter((unit) => isStuckWorkUnit(unit, new Date()));
  return {
    activeRuns: activeRuns.map(toRunSummary),
    recentRuns: recentRuns.map(toRunSummary),
    stuck: {
      count: stuckWorkUnits.length,
      workUnitIds: stuckWorkUnits.map((unit) => unit.id),
    },
    links: {
      recentRuns: {
        href: `/runs?cwd=${encodeURIComponent(cwd)}`,
        label: "Recent runs",
      },
      stuckWork: {
        href: `/runtime/stuck?cwd=${encodeURIComponent(cwd)}`,
        label: "Stuck work",
      },
    },
  };
}

function toRunSummary(run: RunSession): RunSummary {
  return compact({
    id: run.id,
    status: run.status,
    taskId: run.taskId,
    channelId: run.channelId,
    teammateId: run.teammateId,
    requestedSkillId: run.selectedSkillId,
    providerPresetId: run.providerPresetId,
    workUnitId: run.workUnitId,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    terminalAt: run.endedAt,
    errorCode: run.errorMessage ? "run_error" : undefined,
  }) as RunSummary;
}

function readWorkUnitsSnapshot(store: RunStore): WorkUnitsDomainSnapshot {
  const workUnits = store.listWorkUnits({ limit: 200 });
  const active = workUnits.filter((unit) => ["claimed", "running", "waiting_for_approval", "cancelling"].includes(unit.status));
  const queued = workUnits.filter((unit) => unit.status === "queued");
  const stale = workUnits.filter((unit) => unit.status === "stale");
  return {
    counts: {
      total: workUnits.length,
      active: active.length,
      pending: queued.length,
      failed: workUnits.filter((unit) => unit.status === "failed").length,
      blocked: workUnits.filter((unit) => unit.status === "waiting_for_approval" || Boolean(unit.errorCode)).length,
    },
    active: active.slice(0, 50).map(toWorkUnitSummary),
    queued: queued.slice(0, 50).map(toWorkUnitSummary),
    stale: stale.slice(0, 50).map(toWorkUnitSummary),
  };
}

function toWorkUnitSummary(unit: WorkUnit): WorkUnitSummary {
  return compact({
    id: unit.id,
    kind: unit.kind,
    status: unit.status,
    runId: unit.linkedRunId,
    channelId: unit.channelId,
    leaseId: unit.activeAttemptId,
    createdAt: unit.createdAt,
    updatedAt: unit.updatedAt,
    lastHeartbeatAt: unit.lastHeartbeatAt,
    blockedReason: unit.errorCode,
  }) as WorkUnitSummary;
}

function readSkillsSnapshot(store: RunStore): SkillsDomainSnapshot {
  const skills = listEffectiveSkillRegistryEntries(store);
  const countByStatus = (status: string): number => skills.filter((skill) => skill.reviewStatus === status).length;
  return {
    registryGeneration: getSkillRegistryGeneration(),
    counts: {
      total: skills.length,
      builtin: countByStatus("builtin"),
      published: countByStatus("published"),
      draft: countByStatus("draft"),
      archived: countByStatus("archived"),
    },
    skills: skills.map((entry): SkillRegistrySummary => ({
      id: entry.id,
      packId: entry.packId,
      source: entry.source,
      name: entry.definition.name,
      description: entry.definition.summary,
      reviewStatus: entry.reviewStatus,
      workspaceVisible: entry.visibility.workspaceVisible,
      updatedAt: entry.updatedAt,
    })),
  };
}

function readTeammatesSnapshot(store: RunStore): TeammatesDomainSnapshot {
  const teammates = store.listAiTeammates({ includeDisabled: true, limit: 200 });
  return {
    counts: {
      total: teammates.length,
      active: teammates.filter((teammate) => teammate.status === "active").length,
      blocked: teammates.filter((teammate) => teammate.status !== "active").length,
    },
    teammates: teammates.map((teammate) => {
      const skillBindings = store.listTeammateSkillBindings(teammate.id);
      return compact({
        id: teammate.id,
        displayName: teammate.displayName,
        source: teammate.templateId ? "builtin" as const : "user" as const,
        status: teammate.status,
        defaultProviderPresetId: teammate.providerPresetId,
        effectiveSkillCount: skillBindings.filter((binding) => binding.enabled).length,
        blockedSkillCount: skillBindings.filter((binding) => !binding.enabled).length,
        memoryScopeCount: store.listTeammateMemoryScopes(teammate.id).filter((scope) => scope.enabled).length,
        mcpServerCount: store.listTeammateMcpBindings(teammate.id).filter((binding) => binding.enabled).length,
        updatedAt: teammate.updatedAt,
      }) as TeammateSummary;
    }),
  };
}

function readApprovalsSnapshot(store: RunStore, now: string): ApprovalsDomainSnapshot {
  const policy = store.getApprovalPolicy();
  const pending = store.listApprovalRequests({ status: "pending", limit: 100 });
  return {
    policy: {
      mode: approvalPolicyMode(policy),
      toolDecisionCounts: countPolicyDecisions(policy),
      allowedWritePathCount: policy.allowedWritePaths.length,
    },
    pending: pending.map(toApprovalSummary),
    counts: {
      pending: pending.length,
      highRisk: pending.filter((approval) => approval.risk === "high" || approval.risk === "critical").length,
      expired: pending.filter((approval) => approval.expiresAt !== undefined && approval.expiresAt <= now).length,
    },
  };
}

function approvalPolicyMode(policy: ApprovalPolicy): string {
  const decisions = Object.values(policy.toolDecisions);
  if (decisions.every((decision) => decision === "allow")) {
    return "permissive";
  }
  if (decisions.every((decision) => decision === "deny")) {
    return "locked_down";
  }
  return "workspace_policy";
}

function countPolicyDecisions(policy: ApprovalPolicy): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const decision of Object.values(policy.toolDecisions)) {
    counts[decision] = (counts[decision] ?? 0) + 1;
  }
  return counts;
}

function toApprovalSummary(approval: ApprovalRequest): ApprovalSummary {
  const owner = approvalOwner(approval);
  return compact({
    id: approval.id,
    ownerType: owner.type,
    ownerId: owner.id,
    actionType: approval.actionType,
    risk: approval.risk,
    status: approval.status,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
    previewArtifactId: approvalPreviewArtifactId(approval),
  }) as ApprovalSummary;
}

function approvalOwner(approval: ApprovalRequest): { readonly type: string; readonly id: string } {
  if (approval.runId) {
    return { type: "run", id: approval.runId };
  }
  if (approval.mediaJobId) {
    return { type: "media_job", id: approval.mediaJobId };
  }
  if (approval.externalWorkActionId) {
    return { type: "external_work_action", id: approval.externalWorkActionId };
  }
  if (approval.workflowStepId) {
    return { type: "workflow_step", id: approval.workflowStepId };
  }
  if (approval.taskId) {
    return { type: "task", id: approval.taskId };
  }
  return { type: "approval", id: approval.id };
}

function approvalPreviewArtifactId(approval: ApprovalRequest): string | undefined {
  const payload = approval.payload;
  if (payload.type === "workflow_step") {
    return payload.contextArtifactId ?? payload.outputArtifactId;
  }
  return undefined;
}

function readProvidersSnapshot(store: RunStore, secretResolver: SecretResolver): ProvidersDomainSnapshot {
  const providers = store.listProviderPresets();
  const summaries = providers.map((provider) => toProviderSummary(store, secretResolver, provider));
  return {
    counts: {
      total: summaries.length,
      enabled: summaries.filter((provider) => provider.enabled).length,
      runnable: summaries.filter((provider) => provider.runnable).length,
      preflightReady: summaries.filter((provider) => provider.lastCheck?.ok === true).length,
      missingSecrets: summaries.filter((provider) => provider.secretStatus === "missing" || provider.secretStatus === "unavailable").length,
    },
    providers: summaries,
  };
}

function toProviderSummary(store: RunStore, secretResolver: SecretResolver, provider: ProviderPreset): ProviderSummary {
  const blocker = providerRunBlocker(provider);
  const status = provider.apiKeyRef ? providerSecretStatus(store, provider, secretResolver) : undefined;
  const secretStatus = !provider.apiKeyRef
    ? "not_required"
    : status?.configured === true
      ? "configured"
      : status?.errorCode === "secret_store_unavailable" || status?.errorCode === "invalid_secret_ref"
        ? "unavailable"
        : "missing";
  return compact({
    id: provider.id,
    displayName: provider.displayName,
    kind: provider.kind,
    api: provider.api,
    enabled: provider.enabled,
    capabilities: provider.capabilities,
    input: provider.input,
    runnable: blocker === undefined,
    blocker,
    secretStatus,
    secretRefKind: secretRefKind(provider.apiKeyRef),
    lastCheck: provider.lastCheck ? {
      ok: provider.lastCheck.ok,
      code: provider.lastCheck.code ?? (provider.lastCheck.ok ? "ok" : "failed"),
      checkedAt: provider.lastCheck.checkedAt,
    } : undefined,
  }) as ProviderSummary;
}

function providerRunBlocker(provider: ProviderPreset): string | undefined {
  if (!provider.enabled) {
    return "provider_disabled";
  }
  if (provider.api === "media-job" || !provider.capabilities.includes("chat")) {
    return "provider_not_chat_capable";
  }
  if (!provider.input.includes("text")) {
    return "provider_text_input_missing";
  }
  return undefined;
}

function secretRefKind(ref: string | undefined): "env" | "keychain" | undefined {
  if (!ref) {
    return undefined;
  }
  try {
    const parsed = parseSecretRef(ref);
    return parsed.kind;
  } catch {
    return undefined;
  }
}

function readMemorySnapshot(store: RunStore): MemoryDomainSnapshot {
  const policy = store.getMemoryReviewPolicy();
  const promotionInbox = store.listMemoryPromotionInbox({ limit: 200 });
  const recentMemories = store.listMemoryObjects({ limit: 20 });
  return {
    reviewPolicy: {
      workspaceId: policy.workspaceId,
      mode: policy.mode,
      autoActiveSameScope: policy.autoActiveSameScope,
      autoActiveUserExplicit: policy.autoActiveUserExplicit,
      requireManualForWorkspace: policy.requireManualForWorkspace,
      requireManualForPersona: policy.requireManualForPersona,
      requireManualForCrossScope: policy.requireManualForCrossScope,
      quarantineSecretAdjacent: policy.quarantineSecretAdjacent,
      updatedAt: policy.updatedAt,
    },
    promotionInbox: {
      pending: promotionInbox.filter((item) => item.memory.reviewState === "candidate").length,
      quarantined: promotionInbox.filter((item) => item.memory.sensitivity === "secret-adjacent").length,
    },
    recentCandidates: recentMemories.map((memory) => toMemoryCandidateSummary(store, memory)),
  };
}

function toMemoryCandidateSummary(store: RunStore, memory: MemoryObject): MemoryCandidateSummary {
  const decision = store.getLatestMemoryReviewDecision(memory.id);
  return compact({
    id: memory.id,
    scopeType: memory.scopeType,
    ownerId: memory.ownerId,
    title: memory.title,
    status: memory.reviewState,
    confidence: decision?.confidence ?? "unknown",
    reasonCode: decision?.reasonCode,
    createdAt: memory.createdAt,
  }) as MemoryCandidateSummary;
}

function readMcpSnapshot(store: RunStore, secretResolver: SecretResolver, now: string): McpDomainSnapshot {
  const servers = store.listMcpServers({ limit: 200 });
  const tools = store.listMcpTools({ limit: 1000 });
  const summaries = servers.map((server) => {
    const statusSnapshot = store.getMcpStatusSnapshot(server.id, now);
    const secretRefs = mcpServerSecretRefs(server);
    const missingSecretCount = statusSnapshot?.missingSecretRefs.length ??
      secretRefs.filter((ref) => secretResolver.status(ref.ref, ref.purpose).configured !== true).length;
    return {
      id: server.id,
      displayName: server.displayName,
      enabled: server.enabled,
      status: statusSnapshot?.status ?? server.status.kind,
      toolCount: statusSnapshot?.toolCount ?? tools.filter((tool) => tool.serverId === server.id).length,
      missingSecretCount,
      legacySecretMigrationRequired: store.countLegacyMcpServerSecrets(server.id) > 0,
      updatedAt: server.updatedAt,
    } satisfies McpServerSummary;
  });
  return {
    counts: {
      total: summaries.length,
      enabled: summaries.filter((server) => server.enabled).length,
      failed: summaries.filter((server) => server.status === "failed").length,
      missingSecrets: summaries.reduce((total, server) => total + server.missingSecretCount, 0),
      syncedTools: tools.length,
    },
    servers: summaries,
  };
}

function readRunnersSnapshot(store: RunStore, context: DaemonContext): RunnersDomainSnapshot {
  const settings = loadWorkspaceRuntimeSettings(store, context.runnerRegistry);
  return {
    defaultRunnerId: settings.defaultRunnerId,
    allowedRunnerIds: settings.allowedRunnerIds,
    runners: listRunnerItems(context.runnerRegistry, {
      readinessByRunnerId: listRunnerReadinessSummaries(context.runnerRegistry, context.config),
    }).map((runner): RunnerSummary => ({
      id: runner.id,
      displayName: runner.displayName,
      enabled: runner.status === "enabled",
      available: runner.status === "enabled",
      experimental: runner.id !== "pi",
      capabilities: runner.capabilities ?? [],
      toolHydration: runner.toolHydration,
      blocker: runner.disabledReason,
      readiness: runner.readiness,
    })),
  };
}

function readArtifactsSnapshot(store: RunStore, cwd: string): ArtifactsDomainSnapshot {
  const artifacts = uniqueArtifacts([
    ...store.listRuns({ limit: 50 }).flatMap((run) => store.listArtifacts(run.id)),
    ...store.listMediaJobs({ limit: 50 }).flatMap((job) => store.listMediaJobArtifacts(job.id)),
    ...store.listExternalWorkRecords({ limit: 50 }).flatMap((record) => store.listExternalWorkArtifacts(record.id)),
  ]);
  const recent = artifacts.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 20);
  return {
    counts: {
      recent: recent.length,
      byKind: countArtifactsByKind(artifacts),
    },
    recent: recent.map((artifact) => toArtifactSummary(artifact, cwd)),
  };
}

function uniqueArtifacts(artifacts: readonly RunArtifact[]): RunArtifact[] {
  const byId = new Map<string, RunArtifact>();
  for (const artifact of artifacts) {
    byId.set(artifact.id, artifact);
  }
  return [...byId.values()];
}

function countArtifactsByKind(artifacts: readonly RunArtifact[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const artifact of artifacts) {
    counts[artifact.type] = (counts[artifact.type] ?? 0) + 1;
  }
  return counts;
}

function toArtifactSummary(artifact: RunArtifact, cwd: string): ArtifactSummary {
  return compact({
    id: artifact.id,
    runId: artifact.runId,
    mediaJobId: artifact.mediaJobId,
    externalWorkId: artifact.externalWorkId,
    title: artifact.title ?? artifact.id,
    kind: artifact.type,
    contentType: artifact.contentType ?? "application/octet-stream",
    sizeBytes: artifact.sizeBytes ?? 0,
    createdAt: artifact.createdAt,
    contentHref: `/artifacts/${encodeURIComponent(artifact.id)}/content?cwd=${encodeURIComponent(cwd)}`,
  }) as ArtifactSummary;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as T;
}
