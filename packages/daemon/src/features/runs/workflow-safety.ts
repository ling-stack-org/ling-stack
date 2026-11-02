import { lstatSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  createSqliteWorkflowIsolationStore, isWorkflowStepSafetyPlanV1, workflowStepSafetyPlanDigest,
  type ChannelWorkflowStep, type RunSession, type RunStore, type RunTool,
  type RuntimeAttemptFenceV1, type WorkflowStepSafetyPlanV1,
  type WorkflowStepAdmissionPlan,
} from "@ling-stack/core";
import { parseWorkflowStepExecutionSafety } from "@ling-stack/contracts";
import { PiRunnerAdapter, type PiRunnerRunOptions } from "@ling-stack/runner-pi";
import { HttpError } from "../../errors.js";
import { isRecord } from "../../shared/validation.js";
import { resolveCurrentRunSkill } from "./skill-selection.js";
import { captureSkillDefinitionSnapshot } from "./prepared-runner-input.js";
import { mergeRunTools } from "./run-approval-profile.js";
import type { RunRequest } from "./schemas.js";
import type { ResolveWorkflowParallelCapability } from "../channels/smart-scheduler.js";
import { assertChannelWorkspaceReady } from "../channels/workspace.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import { loadWorkspaceRuntimeSettings } from "../../runtime/runner-settings.js";
import { resolveAiTeammateReference } from "../teammates/identity.js";
import type { WorkflowGitWorktreeScope } from "../workspaces/workflow-git-repository.js";

export interface WorkflowSafetySnapshotV1 {
  readonly schemaVersion: 1;
  readonly plan: WorkflowStepSafetyPlanV1;
}

export interface WorkflowSafetyRejection {
  readonly status: "blocked";
  readonly code: "workflow_safety_mismatch" | "workflow_safety_effect_denied";
  readonly reason: string;
}

const readTools = new Set(["read", "grep", "find", "ls"]);
const isolatedTools = new Set([...readTools, "write", "edit"]);

/** A template can request a profile, but only this Host producer freezes it. */
export function createWorkflowSafetyPlan(input: {
  readonly store: RunStore;
  readonly step: ChannelWorkflowStep;
  readonly workspaceCwd: string;
  readonly executionCwd: string;
  readonly runnerId?: string;
  readonly runnerRegistry?: RunnerRegistry;
  /** Only the Host planner supplies an unpersisted scope, before any approval/start. */
  readonly isolatedScope?: WorkflowGitWorktreeScope;
}): WorkflowStepSafetyPlanV1 | undefined {
  const { store, step } = input;
  const safety = parseWorkflowStepExecutionSafety(step.metadata);
  if (!safety) return undefined;
  if (safety.sideEffectClass === "test_artifact_only") {
    throw new HttpError(409, "workflow_safety_profile_unavailable", "This executor has no verified artifact-only workflow profile.");
  }
  const channel = store.getChannel(step.channelId);
  if (!channel) throw mismatch("Workflow channel is missing.");
  const selected = resolveCurrentRunSkill(store, { requestedSkillId: step.metadata?.skillId,
    teammateId: step.toParticipantId, providerPresetId: step.metadata?.providerPresetId ?? channel.defaultProviderPresetId,
    task: { channelId: step.channelId } });
  const tools = [...mergeRunTools(step.metadata?.requiredTools ?? [], selected?.requiredTools ?? [])].sort();
  const readonly = safety.sideEffectClass === "analysis_readonly";
  const isolationPin = step.metadata?.isolationScopePlan;
  const isolatedPlan = isolationPin ? createSqliteWorkflowIsolationStore(store).getScopePlan(isolationPin.planId) : undefined;
  if (isolationPin && (!isolatedPlan || isolatedPlan.planDigest !== isolationPin.planDigest
    || isolatedPlan.workflowId !== step.workflowId || isolatedPlan.workflowStepId !== step.id)) {
    throw mismatch("The isolated workflow scope pin cannot be verified.");
  }
  const isolated = Boolean(input.isolatedScope || isolatedPlan);
  let runnerId = input.runnerId ?? step.metadata?.requestedRunnerId;
  if (!readonly && !isolated && !runnerId && input.runnerRegistry) {
    const settings = loadWorkspaceRuntimeSettings(store, input.runnerRegistry);
    const teammate = resolveAiTeammateReference(store, step.toParticipantId);
    runnerId = input.runnerRegistry.resolve({ requestedRunnerId: teammate?.runnerId ?? settings.defaultRunnerId,
      allowedRunnerIds: settings.allowedRunnerIds, allowFallback: false,
      providerApi: store.getProviderPreset(step.metadata?.providerPresetId ?? channel.defaultProviderPresetId ?? "")?.api as PiRunnerRunOptions["provider"]["api"],
      tools }).effectiveRunnerId;
  }
  if (readonly && (tools.some(tool => !readTools.has(tool)) || runnerId !== undefined && runnerId !== "pi")) {
    throw mismatch("Read-only workflow requires the Pi Host read profile and cannot include mutating skill tools.");
  }
  if (isolated && (safety.sideEffectClass !== "workspace_write" || tools.some(tool => !isolatedTools.has(tool))
    || runnerId !== undefined && runnerId !== "pi")) {
    throw mismatch("Isolated workflow requires the Pi Host file profile and cannot include shell or external tools.");
  }
  let workspaceRoot: string, executionRoot: string;
  try {
    workspaceRoot = realpathSync.native(input.workspaceCwd);
    if (isolated) {
      executionRoot = isolatedPlan?.executionRoot ?? input.isolatedScope!.executionRoot;
      if (executionRoot !== input.executionCwd || resolve(executionRoot) !== executionRoot
        || realpathSync.native(dirname(executionRoot)) !== dirname(executionRoot)
        || isolatedPlan && isolatedPlan.canonicalWorkspaceRoot !== workspaceRoot
        || input.isolatedScope && (input.isolatedScope.repository.root !== workspaceRoot
          || input.isolatedScope.worktreeRoot !== dirname(executionRoot))) throw new Error("scope_mismatch");
      try {
        const stat = lstatSync(executionRoot);
        if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync.native(executionRoot) !== executionRoot) throw new Error("root_changed");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    } else executionRoot = realpathSync.native(input.executionCwd);
  } catch { throw mismatch("Workflow execution roots cannot be verified."); }
  const plan: Omit<WorkflowStepSafetyPlanV1, "digest"> = {
    schemaVersion: 1, profile: readonly ? "pi_host_readonly_v1" : isolated ? "pi_host_isolated_files_v1" : "serial_v1",
    workflowId: step.workflowId, workflowStepId: step.id, workspaceRoot, executionRoot, safety, tools,
    ...(selected ? { skillFingerprint: captureSkillDefinitionSnapshot(store, selected.skill).definitionHash } : {}),
    ...(readonly || isolated ? { runnerId: "pi" } : runnerId ? { runnerId } : {}),
    networkAccess: readonly || isolated ? false : "session_policy", writeRoots: readonly ? [] : [executionRoot],
  };
  return { ...plan, digest: workflowStepSafetyPlanDigest(plan) };
}

export function workflowSafetySnapshot(plan: WorkflowStepSafetyPlanV1 | undefined): WorkflowSafetySnapshotV1 | undefined {
  return plan ? { schemaVersion: 1, plan: structuredClone(plan) } : undefined;
}

/** Call before asking for approval; never overwrite an accepted plan after drift. */
export function freezeWorkflowSafetyPlan(input: Parameters<typeof createWorkflowSafetyPlan>[0]): ChannelWorkflowStep {
  const plan = createWorkflowSafetyPlan(input);
  const prior = input.step.metadata?.safetyPlan;
  if (prior && !isDeepStrictEqual(prior, plan)) throw mismatch("Workflow scope or skill changed. Recompile or explicitly retry with a new approval.");
  if (prior || !plan) return input.step;
  if (input.step.taskId || input.step.runId || input.step.metadata?.startOwner) {
    throw mismatch("An already admitted workflow cannot acquire a new safety profile.");
  }
  return input.store.updateChannelWorkflowStep(input.step.id, { metadata: { ...input.step.metadata, safetyPlan: plan } }, new Date().toISOString())!;
}

/** Internal snapshots are required even when an external caller supplies a real step id. */
export function assertWorkflowSafetyRequest(store: RunStore, request: RunRequest): WorkflowStepSafetyPlanV1 | undefined {
  const step = request.workflowStepId ? store.getChannelWorkflowStep(request.workflowStepId) : undefined;
  const snapshot = request.workflowSafetySnapshot;
  if (!step) {
    if (snapshot || request.workflowIsolationPlan) throw mismatch("Safety snapshot has no workflow owner.");
    return undefined;
  }
  const safety = parseWorkflowStepExecutionSafety(step.metadata);
  if (!safety && !snapshot && !step.metadata?.safetyPlan && !request.workflowIsolationPlan && !step.metadata?.isolationScopePlan) return undefined;
  const plan = step.metadata?.safetyPlan;
  if (!plan || !isWorkflowStepSafetyPlanV1(plan) || !snapshot || snapshot.schemaVersion !== 1
    || !isDeepStrictEqual(snapshot.plan, plan) || request.task.channelId !== step.channelId
    || request.teammateId !== step.toParticipantId) throw mismatch("Workflow safety snapshot is missing, replaced, or owned by another participant.");
  if (plan.profile === "pi_host_isolated_files_v1"
    ? !isDeepStrictEqual(request.workflowIsolationPlan, step.metadata?.isolationScopePlan) || !request.workflowIsolationPlan
    : request.workflowIsolationPlan !== undefined || step.metadata?.isolationScopePlan !== undefined) {
    throw mismatch("The isolated scope and Host tool profile must be bound together.");
  }
  const current = createWorkflowSafetyPlan({ store, step, workspaceCwd: request.workspaceCwd ?? request.cwd,
    executionCwd: request.cwd, runnerId: request.runnerId });
  if (!isDeepStrictEqual(plan, current)) throw mismatch("Workflow safety scope, tools, or skill changed after approval.");
  return plan;
}

export function assertWorkflowSafetyRunner(store: RunStore, request: RunRequest, input: {
  readonly adapter: unknown; readonly runnerId: string; readonly tools?: readonly RunTool[];
}): WorkflowStepSafetyPlanV1 | undefined {
  const plan = assertWorkflowSafetyRequest(store, request);
  if (plan?.runnerId && input.runnerId !== plan.runnerId) throw mismatch("The actual Runner differs from the approved profile.");
  if (plan?.profile !== "pi_host_readonly_v1" && plan?.profile !== "pi_host_isolated_files_v1") return plan;
  if (!(input.adapter instanceof PiRunnerAdapter) || input.runnerId !== "pi"
    || !isDeepStrictEqual([...(input.tools ?? [])].sort(), plan.tools)) {
    throw mismatch("The actual Runner/tool inventory cannot enforce the approved Host tool profile.");
  }
  return plan;
}

/** Drop optional plugin surfaces; required core/skill tools were checked, never silently narrowed. */
export function restrictWorkflowSafetyTools<T extends PiRunnerRunOptions>(options: T, plan: WorkflowStepSafetyPlanV1 | undefined): T {
  if (plan?.profile === "pi_host_isolated_files_v1") return { ...options, readonlyToolsProfile: undefined,
    isolatedToolsProfile: "host_isolated_files_v1", mcpTools: [], hostCapabilityTools: [], mediaGenerationTools: [],
    onMcpToolCall: undefined, onHostCapabilityCall: undefined, onMediaGenerationToolCall: undefined,
    onToolHydrationRequest: undefined, onDelegationToolCall: undefined, onUserInputRequest: undefined, onPermissionRequired: undefined,
    runtimeToolFeatures: { requestPermissions: false, unifiedExec: false, shellSnapshot: false },
    initialToolSurface: { mediaGeneration: false, toolHydration: false, nativeFileCreate: false, userInput: false, delegation: false } };
  if (plan?.profile !== "pi_host_readonly_v1") return options;
  return { ...options, readonlyToolsProfile: "host_readonly_v1", mcpTools: [], hostCapabilityTools: [], mediaGenerationTools: [],
    runtimeToolFeatures: { ...options.runtimeToolFeatures, requestPermissions: false },
    initialToolSurface: { ...options.initialToolSurface, mediaGeneration: false, toolHydration: false, delegation: false } };
}

export function workflowSafetyEffectRejection(input: {
  readonly store: RunStore; readonly run: RunSession;
  readonly request: { readonly toolName: string; readonly input: unknown; readonly cwd: string };
}): WorkflowSafetyRejection | undefined {
  const persisted = input.store.getRun(input.run.id);
  const raw = isRecord(persisted?.requestSnapshot) ? persisted.requestSnapshot : undefined;
  const requested = isRecord(input.run.requestSnapshot) ? input.run.requestSnapshot : undefined;
  const stepId = persisted?.workflowStepId ?? input.run.workflowStepId;
  const step = stepId ? input.store.getChannelWorkflowStep(stepId) : undefined;
  if (!raw?.workflowSafetySnapshot && !requested?.workflowSafetySnapshot && !step?.metadata?.sideEffectClass && !step?.metadata?.safetyPlan) return undefined;
  try {
    if (!persisted || !raw || !isDeepStrictEqual(raw.workflowSafetySnapshot, requested?.workflowSafetySnapshot)) throw mismatch("Safety snapshot was removed or changed.");
    const plan = assertWorkflowSafetyRequest(input.store, raw as unknown as RunRequest);
    if (!plan || persisted.cwd !== plan.executionRoot || input.request.cwd !== persisted.cwd) throw mismatch("Actual tool execution root differs from the approved scope.");
    if (plan.profile === "pi_host_readonly_v1" && !readTools.has(input.request.toolName) && input.request.toolName !== "request_user_input") {
      return { status: "blocked", code: "workflow_safety_effect_denied", reason: "The approved read-only profile does not allow this effect: " + input.request.toolName };
    }
    if (plan.profile === "pi_host_isolated_files_v1" && !isolatedTools.has(input.request.toolName)) {
      return { status: "blocked", code: "workflow_safety_effect_denied", reason: "The approved isolated-files profile does not allow this effect: " + input.request.toolName };
    }
    return undefined;
  } catch (error) {
    return { status: "blocked", code: "workflow_safety_mismatch", reason: error instanceof Error ? error.message : "Workflow safety scope cannot be verified." };
  }
}

export function assertWorkflowSafetyAttempt(input: {
  readonly store: RunStore; readonly run: RunSession; readonly sourceFence: RuntimeAttemptFenceV1;
}): void {
  const raw = isRecord(input.run.requestSnapshot) ? input.run.requestSnapshot : undefined;
  if (!raw?.workflowSafetySnapshot) return;
  if (!input.store.isCurrentRunExecutionOwner(input.run.id, input.sourceFence)) throw mismatch("Workflow safety Attempt fence is stale.");
  const rejection = workflowSafetyEffectRejection({ ...input, request: { toolName: "read", input: {}, cwd: input.run.cwd } });
  if (rejection) throw mismatch(rejection.reason);
}

export function assertWorkflowSafetyEffectByRunId(store: RunStore, runId: string | undefined, toolName: string): void {
  if (!runId) return;
  const run = store.getRun(runId);
  if (!run) throw mismatch("Effect owner Run is missing.");
  const rejection = workflowSafetyEffectRejection({ store, run, request: { toolName, input: {}, cwd: run.cwd } });
  if (rejection) throw new HttpError(409, rejection.code, rejection.reason);
}

function mismatch(reason: string): HttpError { return new HttpError(409, "workflow_safety_mismatch", reason); }

/** Only the registered, enabled Pi adapter can produce this capability. */
export function createWorkflowParallelCapabilityResolver(runnerRegistry: RunnerRegistry): ResolveWorkflowParallelCapability {
  return input => {
    try {
      if (input.step.metadata?.sideEffectClass !== "analysis_readonly"
        || input.step.metadata.parallelPolicy?.autoParallel !== true) return undefined;
      const workspace = assertChannelWorkspaceReady(input.channel, input.store.paths.cwd);
      if (!workspace.ok) return undefined;
      const plan = createWorkflowSafetyPlan({ store: input.store, step: input.step,
        workspaceCwd: input.store.paths.cwd, executionCwd: workspace.executionCwd,
        runnerId: input.runRequest?.runnerId });
      if (!plan || plan.profile !== "pi_host_readonly_v1" || !isDeepStrictEqual(plan.tools, [...input.tools].sort())) return undefined;
      if (input.step.metadata.safetyPlan && !isDeepStrictEqual(input.step.metadata.safetyPlan, plan)) return undefined;
      const settings = loadWorkspaceRuntimeSettings(input.store, runnerRegistry);
      const resolution = runnerRegistry.resolve({ requestedRunnerId: "pi", allowFallback: false,
        allowedRunnerIds: settings.allowedRunnerIds, tools: input.tools });
      if (!(resolution.runner.adapter instanceof PiRunnerAdapter) || resolution.effectiveRunnerId !== "pi") return undefined;
      if (input.runRequest) assertWorkflowSafetyRunner(input.store, input.runRequest,
        { adapter: resolution.runner.adapter, runnerId: resolution.effectiveRunnerId, tools: input.tools });
      if (input.run) {
        const raw = input.run.requestSnapshot;
        if (!isRecord(raw) || !isDeepStrictEqual(assertWorkflowSafetyRequest(input.store, raw as unknown as RunRequest), plan)) return undefined;
      }
      return { verified: true, resourceKeys: [], parallelLimit: 4 };
    } catch { return undefined; }
  };
}

/** The same semantic plan is derived before begin and from the actual prepared Run. */
export function createWorkflowSafetyAdmission(store: RunStore, step: ChannelWorkflowStep, request: Pick<RunRequest,
  "workflowSafetySnapshot" | "providerPresetId" | "provider" | "runnerId" | "executionBinding">): WorkflowStepAdmissionPlan | undefined {
  const plan = request.workflowSafetySnapshot?.plan;
  if (!plan) return undefined;
  const channel = store.getChannel(step.channelId), workflow = store.getChannelWorkflow(step.workflowId);
  if (!channel || !workflow || !isWorkflowStepSafetyPlanV1(plan)
    || !isDeepStrictEqual(plan, step.metadata?.safetyPlan)) throw mismatch("Admission has no current Host safety plan.");
  const providerKey = request.executionBinding?.kind === "native_profile"
    ? `native:${request.executionBinding.profileId}:${request.executionBinding.profileRevision}`
    : request.providerPresetId ?? (request.provider ? `${request.provider.provider}:${request.provider.model}` : undefined);
  const runnerId = request.runnerId ?? plan.runnerId;
  if (!providerKey || !runnerId) {
    if (step.metadata?.parallelPolicy?.autoParallel) throw mismatch("Parallel admission requires resolved Provider and Runner identities.");
    return undefined;
  }
  const parallel = plan.profile === "pi_host_readonly_v1" && plan.safety.parallelPolicy?.autoParallel === true
    && channel.runtimePolicy.allowReadOnlyParallel;
  const limit = parallel ? Math.min(4, positiveLimit(channel.runtimePolicy.maxConcurrentRuns),
    positiveLimit(workflow.metadata?.maxParallelSteps ?? channel.runtimePolicy.maxConcurrentRuns),
    positiveLimit(plan.safety.parallelPolicy?.maxParallelSiblings ?? 1),
    positiveLimit(step.metadata?.maxParallelSiblings ?? plan.safety.parallelPolicy?.maxParallelSiblings ?? 1)) : 1;
  const entries: WorkflowStepAdmissionPlan["entries"][number][] = [
    { resourceType: "provider", resourceKey: providerKey, limit: 4 },
    { resourceType: "runner", resourceKey: runnerId, limit: 4 },
    { resourceType: "channel_parallel", resourceKey: channel.id, limit },
    { resourceType: "channel_parallel", resourceKey: `workflow:${workflow.id}`, limit },
    { resourceType: "channel_parallel", resourceKey: `workspace:${plan.workspaceRoot}`, limit },
  ];
  entries.sort((a, b) => JSON.stringify([a.resourceType, a.resourceKey]).localeCompare(JSON.stringify([b.resourceType, b.resourceKey]), "en"));
  return { entries, resourceKeys: [...new Set([...(plan.safety.parallelPolicy?.resourceKeys ?? []),
    ...(plan.profile === "pi_host_isolated_files_v1" ? [`workflow:${workflow.id}`, `workspace:${plan.workspaceRoot}`] : [])])].sort() };
}

function positiveLimit(value: number): number { return Number.isSafeInteger(value) && value > 0 ? value : 1; }
