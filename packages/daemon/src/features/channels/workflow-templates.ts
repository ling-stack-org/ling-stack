import {
  approvalActionTypes,
  buildEffectiveTeammateSkills,
  channelWorkflowStepStatuses,
  createBuiltinAiTeammateId,
  getBuiltinSkillPack,
  getEffectiveTeammateSkill,
  GSTACK_DEFAULT_SKILL_PACK_ID,
  isRiskyRunTool,
  type ChannelWorkflow,
  type ChannelWorkflowStep,
  type ChannelWorkflowStepMetadata,
  type ChannelWorkflowStepStatus,
  type RunStore,
  type RunTool,
  type SkillApprovalProfile,
  type WorkflowStepPolicy,
  type WorkflowStepFailurePolicy,
  type WorkflowStepGate,
  type WorkflowStepTemplate,
  type WorkflowGraph,
} from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import { loadWorkspaceRuntimeSettings } from "../../runtime/runner-settings.js";
import { isRecord, readOptionalBoolean, readOptionalNumber, readOptionalString, readOptionalStringArray, readString } from "../../shared/validation.js";
import { listExecutableSkillDefinitions } from "../skills/registry.js";
import { compileWorkflowGraph, readOptionalWorkflowGraph } from "./workflow-graph.js";

export interface CompileWorkflowTemplateInput {
  readonly channelId: string;
  readonly templateId?: string;
  readonly customTemplate?: CustomWorkflowTemplate;
  readonly customTemplateId?: string;
  readonly workflowGraph?: WorkflowGraph;
  readonly title?: string;
  readonly objective: string;
  readonly createdBy?: string;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly autoStart?: boolean;
  readonly confirmUnsafeAutoStart?: boolean;
}

export interface CustomWorkflowTemplate {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly maxParallelSteps?: number;
  readonly autoStartDefault?: boolean;
  readonly steps: readonly CustomWorkflowTemplateStep[];
}

export interface CustomWorkflowTemplateStep {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly teammateTemplateId?: string;
  readonly teammateId?: string;
  readonly skillId?: string;
  readonly providerPresetId?: string;
  readonly requestedRunnerId?: string;
  readonly dependsOn?: readonly string[];
  readonly branchGroupId?: string;
  readonly joinGroupId?: string;
  readonly dependencyMode?: ChannelWorkflowStepMetadata["dependencyMode"];
  readonly maxParallelSiblings?: number;
  readonly policy?: WorkflowStepPolicy;
  readonly gates?: readonly WorkflowStepGate[];
  readonly autoStart?: boolean;
}

export function isWorkflowTemplateCompileRequest(value: unknown): boolean {
  return isRecord(value) && (
    typeof value.templateId === "string" ||
    typeof value.customTemplateId === "string" ||
    isRecord(value.customTemplate) ||
    isRecord(value.workflowGraph)
  );
}

export function parseWorkflowTemplateCompileRequest(value: unknown, channelId: string): CompileWorkflowTemplateInput {
  if (!isRecord(value)) {
    throw new Error("Workflow template request must be a JSON object");
  }
  const templateId = readOptionalString(value, "templateId");
  const customTemplateId = readOptionalString(value, "customTemplateId");
  const customTemplate = readOptionalCustomWorkflowTemplate(value, "customTemplate");
  const workflowGraph = readOptionalWorkflowGraph(value, "workflowGraph");
  const templateKinds = [templateId, customTemplateId, customTemplate, workflowGraph].filter((item) => item !== undefined).length;
  if (templateKinds !== 1) {
    throw new Error("Workflow template request must include exactly one of templateId, customTemplateId, customTemplate, or workflowGraph");
  }
  return {
    channelId,
    templateId,
    customTemplateId,
    customTemplate,
    workflowGraph,
    title: readOptionalString(value, "title"),
    objective: readString(value, "objective"),
    createdBy: readOptionalString(value, "createdBy"),
    providerPresetId: readOptionalString(value, "providerPresetId"),
    runnerId: readOptionalString(value, "runnerId"),
    autoStart: readOptionalBoolean(value, "autoStart"),
    confirmUnsafeAutoStart: readOptionalBoolean(value, "confirmUnsafeAutoStart"),
  };
}

export function compileWorkflowTemplate(store: RunStore, input: CompileWorkflowTemplateInput, now = new Date().toISOString(), runnerRegistry?: RunnerRegistry): {
  readonly workflow: ChannelWorkflow;
  readonly workflowSteps: readonly ChannelWorkflowStep[];
} {
  const channel = store.getChannel(input.channelId);
  if (!channel) {
    throw new HttpError(404, "channel_not_found", `Channel not found: ${input.channelId}`);
  }
  if (input.customTemplateId) {
    throw new HttpError(400, "custom_workflow_template_not_found", `Custom workflow template registry lookup is not implemented: ${input.customTemplateId}`);
  }
  if (input.customTemplate) {
    return compileCustomWorkflowTemplate(store, input, input.customTemplate, now, runnerRegistry);
  }
  if (input.workflowGraph) {
    return compileWorkflowGraph(store, { ...input, workflowGraph: input.workflowGraph }, now, runnerRegistry);
  }
  if (!input.templateId) {
    throw new HttpError(400, "workflow_template_required", "templateId, customTemplate, or workflowGraph is required");
  }
  const skillPack = getBuiltinSkillPack(GSTACK_DEFAULT_SKILL_PACK_ID);
  if (!skillPack) {
    throw new HttpError(500, "builtin_skill_pack_missing", `Builtin skill pack missing: ${GSTACK_DEFAULT_SKILL_PACK_ID}`);
  }
  const template = skillPack.workflowTemplates.find((candidate) => candidate.id === input.templateId);
  if (!template) {
    throw new HttpError(400, "workflow_template_not_found", `Workflow template not found: ${input.templateId}`);
  }
  const teammateTemplates = new Map(skillPack.teammateTemplates.map((teammate) => [teammate.id, teammate]));
  const workflow = store.createChannelWorkflow(
    {
      channelId: channel.id,
      title: input.title ?? template.name,
      objective: input.objective,
      status: "ready",
      createdBy: input.createdBy ?? "local-user",
    },
    now,
  );
  const steps: ChannelWorkflowStep[] = [];
  const byTemplateStepId = new Map<string, ChannelWorkflowStep>();
  for (const [index, templateStep] of template.steps.entries()) {
    const teammateTemplate = teammateTemplates.get(templateStep.teammateTemplateId);
    const teammateId = createBuiltinAiTeammateId(templateStep.teammateTemplateId);
    const step = store.createChannelWorkflowStep(
      {
        workflowId: workflow.id,
        position: index + 1,
        title: templateStep.name,
        prompt: renderTemplateStepPrompt(templateStep, input.objective),
        toParticipantId: teammateId,
        toParticipantLabel: teammateTemplate?.name ?? templateStep.teammateTemplateId,
        metadata: {
          workflowTemplateId: template.id,
          templateVersion: skillPack.version,
          templateStepId: templateStep.id,
          teammateTemplateId: templateStep.teammateTemplateId,
          skillId: templateStep.skillId,
          requestedRunnerId: input.runnerId,
          providerPresetId: input.providerPresetId,
          autoStart: input.autoStart ?? true,
          approvalGate: templateStep.approvalGate,
          policy: defaultWorkflowStepPolicy(templateStep),
        },
      },
      now,
    );
    steps.push(step);
    byTemplateStepId.set(templateStep.id, step);
  }

  const updatedSteps = steps.map((step) => {
    const templateStepId = step.metadata?.templateStepId;
    const templateStep = template.steps.find((candidate) => candidate.id === templateStepId);
    const dependsOnStepIds = templateStep?.dependsOn?.map((dependencyId) => byTemplateStepId.get(dependencyId)?.id).filter(isString);
    if (!dependsOnStepIds || dependsOnStepIds.length === 0) {
      return step;
    }
    return store.updateChannelWorkflowStep(
      step.id,
      {
        metadata: {
          ...step.metadata,
          dependsOnStepIds,
        },
      },
      now,
    ) ?? step;
  });

  return {
    workflow,
    workflowSteps: updatedSteps,
  };
}

function compileCustomWorkflowTemplate(
  store: RunStore,
  input: CompileWorkflowTemplateInput,
  template: CustomWorkflowTemplate,
  now: string,
  runnerRegistry?: RunnerRegistry,
): {
  readonly workflow: ChannelWorkflow;
  readonly workflowSteps: readonly ChannelWorkflowStep[];
} {
  const channel = store.getChannel(input.channelId);
  if (!channel) {
    throw new HttpError(404, "channel_not_found", `Channel not found: ${input.channelId}`);
  }
  validateCustomWorkflowTemplate(store, input, template, runnerRegistry);
  const workflow = store.createChannelWorkflow(
    {
      channelId: channel.id,
      title: input.title ?? template.name,
      objective: input.objective,
      status: "ready",
      createdBy: input.createdBy ?? "local-user",
    },
    now,
  );
  const steps: ChannelWorkflowStep[] = [];
  const byTemplateStepId = new Map<string, ChannelWorkflowStep>();
  const templateBudget = template.maxParallelSteps;
  for (const [index, templateStep] of template.steps.entries()) {
    const resolved = resolveCustomTemplateStepParticipant(store, templateStep);
    const stepAutoStart = templateStep.autoStart ?? input.autoStart ?? template.autoStartDefault ?? false;
    const requestedRunnerId = templateStep.requestedRunnerId ?? input.runnerId;
    const providerPresetId = templateStep.providerPresetId ?? input.providerPresetId;
    const metadata: ChannelWorkflowStepMetadata = {
      workflowTemplateId: template.id,
      templateVersion: `custom:${template.schemaVersion}`,
      templateStepId: templateStep.id,
      teammateTemplateId: templateStep.teammateTemplateId,
      skillId: templateStep.skillId,
      requestedRunnerId,
      providerPresetId,
      autoStart: stepAutoStart,
      branchGroupId: templateStep.branchGroupId,
      joinGroupId: templateStep.joinGroupId,
      dependencyMode: templateStep.dependencyMode,
      maxParallelSiblings: templateStep.maxParallelSiblings ?? templateBudget,
      policy: templateStep.policy ?? defaultCustomWorkflowStepPolicy(templateStep),
      gates: templateStep.gates,
    };
    const step = store.createChannelWorkflowStep(
      {
        workflowId: workflow.id,
        position: index + 1,
        title: templateStep.name,
        prompt: renderCustomTemplateStepPrompt(templateStep, input.objective),
        toParticipantId: resolved.toParticipantId,
        toParticipantLabel: resolved.toParticipantLabel,
        metadata: omitUndefined(metadata),
      },
      now,
    );
    steps.push(step);
    byTemplateStepId.set(templateStep.id, step);
  }

  const updatedSteps = steps.map((step) => {
    const templateStepId = step.metadata?.templateStepId;
    const templateStep = template.steps.find((candidate) => candidate.id === templateStepId);
    const dependsOnStepIds = templateStep?.dependsOn?.map((dependencyId) => byTemplateStepId.get(dependencyId)?.id).filter(isString);
    if (!dependsOnStepIds || dependsOnStepIds.length === 0) {
      return step;
    }
    return store.updateChannelWorkflowStep(
      step.id,
      {
        metadata: {
          ...step.metadata,
          dependsOnStepIds,
        },
      },
      now,
    ) ?? step;
  });

  return {
    workflow,
    workflowSteps: updatedSteps,
  };
}

function defaultWorkflowStepPolicy(templateStep: WorkflowStepTemplate): WorkflowStepPolicy {
  return {
    onRunFailed: templateStep.id === "implementation" || templateStep.id === "ship" ? "fail_workflow" : "block_for_user",
    onRunCancelled: "block_for_user",
    onApprovalDenied: "block_for_user",
    retryable: true,
  };
}

function renderTemplateStepPrompt(templateStep: WorkflowStepTemplate, objective: string): string {
  return [
    `Workflow objective:\n${objective}`,
    `Current step: ${templateStep.name}`,
    `Phase: ${templateStep.phase}`,
    `Skill: ${templateStep.skillId}`,
    "Complete this step only. Do not start or approve later workflow steps.",
    "Return a concise terminal summary and any artifacts or follow-up decisions needed by later steps.",
  ].join("\n\n");
}

function renderCustomTemplateStepPrompt(templateStep: CustomWorkflowTemplateStep, objective: string): string {
  return [
    `Workflow objective:\n${objective}`,
    `Current step: ${templateStep.name}`,
    templateStep.skillId ? `Skill: ${templateStep.skillId}` : undefined,
    templateStep.prompt,
    "Complete this step only. Do not start or approve later workflow steps.",
    "Return a concise terminal summary and any artifacts or follow-up decisions needed by later steps.",
  ].filter(isString).join("\n\n");
}

function validateCustomWorkflowTemplate(
  store: RunStore,
  input: CompileWorkflowTemplateInput,
  template: CustomWorkflowTemplate,
  runnerRegistry?: RunnerRegistry,
): void {
  const channel = store.getChannel(input.channelId);
  if (!channel) {
    throw new HttpError(404, "channel_not_found", `Channel not found: ${input.channelId}`);
  }
  if (template.steps.length === 0) {
    throw new HttpError(400, "custom_workflow_template_invalid", "Custom workflow template must include at least one step");
  }
  const stepIds = new Set<string>();
  for (const step of template.steps) {
    if (stepIds.has(step.id)) {
      throw new HttpError(400, "custom_workflow_template_invalid", `Duplicate custom workflow step id: ${step.id}`);
    }
    stepIds.add(step.id);
  }
  for (const step of template.steps) {
    for (const dependencyId of step.dependsOn ?? []) {
      if (!stepIds.has(dependencyId)) {
        throw new HttpError(400, "custom_workflow_template_invalid", `Unknown dependency ${dependencyId} for step ${step.id}`);
      }
    }
  }
  assertTemplateDependencyDag(template);
  const maxParallelSteps = template.maxParallelSteps ?? Math.max(1, ...template.steps.map((step) => step.maxParallelSiblings ?? 1));
  const channelMaxConcurrentRuns = channel.runtimePolicy?.maxConcurrentRuns ?? 1;
  if (maxParallelSteps > channelMaxConcurrentRuns) {
    throw new HttpError(
      400,
      "custom_workflow_template_parallel_limit",
      `Custom template maxParallelSteps ${maxParallelSteps} exceeds channel limit ${channelMaxConcurrentRuns}`,
    );
  }
  for (const step of template.steps) {
    validateCustomTemplateStepParticipantAndSkill(store, step);
    validateCustomTemplateStepRunner(store, step.requestedRunnerId ?? input.runnerId, runnerRegistry);
  }
  const unsafeAutoStartSteps = template.steps.filter((step) => {
    const autoStart = step.autoStart ?? input.autoStart ?? template.autoStartDefault ?? false;
    return autoStart && customTemplateStepHasSideEffects(store, step);
  });
  if (unsafeAutoStartSteps.length > 0 && !input.confirmUnsafeAutoStart) {
    throw new HttpError(
      400,
      "custom_workflow_template_unsafe_autostart",
      `Custom template autoStart requires confirmUnsafeAutoStart for side-effectful steps: ${unsafeAutoStartSteps.map((step) => step.id).join(", ")}`,
    );
  }
}

function assertTemplateDependencyDag(template: CustomWorkflowTemplate): void {
  const byId = new Map(template.steps.map((step) => [step.id, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(stepId: string, path: readonly string[]): void {
    if (visited.has(stepId)) {
      return;
    }
    if (visiting.has(stepId)) {
      throw new HttpError(400, "custom_workflow_template_cycle", `Custom workflow template has a dependency cycle: ${[...path, stepId].join(" -> ")}`);
    }
    const step = byId.get(stepId);
    if (!step) {
      return;
    }
    visiting.add(stepId);
    for (const dependencyId of step.dependsOn ?? []) {
      visit(dependencyId, [...path, stepId]);
    }
    visiting.delete(stepId);
    visited.add(stepId);
  }
  for (const step of template.steps) {
    visit(step.id, []);
  }
}

function validateCustomTemplateStepParticipantAndSkill(store: RunStore, step: CustomWorkflowTemplateStep): void {
  const resolved = resolveCustomTemplateStepParticipant(store, step);
  if (!step.skillId) {
    return;
  }
  const executableSkills = listExecutableSkillDefinitions(store);
  const skill = executableSkills.find((candidate) => candidate.id === step.skillId);
  if (!skill) {
    throw new HttpError(400, "skill_not_found", `Skill definition not found: ${step.skillId}`);
  }
  const teammate = store.getAiTeammate(resolved.toParticipantId);
  if (!teammate) {
    throw new HttpError(400, "teammate_not_found", `AI teammate not found: ${resolved.toParticipantId}`);
  }
  const effective = getEffectiveTeammateSkill(buildEffectiveTeammateSkills({
    teammate,
    bindings: store.listTeammateSkillBindings(teammate.id),
    skills: executableSkills,
  }), step.skillId);
  if (!effective) {
    throw new HttpError(400, "skill_not_executable", `Skill is not bound to teammate ${teammate.id}: ${step.skillId}`);
  }
  if (!effective.executable) {
    throw new HttpError(
      400,
      "skill_not_executable",
      `Skill is not executable for teammate ${teammate.id}: ${effective.blockedReasons.map((reason) => reason.code).join(", ")}`,
    );
  }
}

function validateCustomTemplateStepRunner(store: RunStore, requestedRunnerId: string | undefined, runnerRegistry: RunnerRegistry | undefined): void {
  if (!requestedRunnerId || !runnerRegistry) {
    return;
  }
  const settings = loadWorkspaceRuntimeSettings(store, runnerRegistry);
  runnerRegistry.resolve({
    requestedRunnerId,
    defaultRunnerId: settings.defaultRunnerId,
    allowedRunnerIds: settings.allowedRunnerIds,
    requestSource: "workflow_step",
    explicitFallbackPolicy: settings.explicitRunnerFallback,
    implicitFallbackPolicy: settings.implicitRunnerFallback,
  });
}

function resolveCustomTemplateStepParticipant(store: RunStore, step: CustomWorkflowTemplateStep): {
  readonly toParticipantId: string;
  readonly toParticipantLabel: string;
} {
  if (step.teammateId && step.teammateTemplateId) {
    throw new HttpError(400, "custom_workflow_template_invalid", `Step ${step.id} must use teammateId or teammateTemplateId, not both`);
  }
  if (step.teammateId) {
    const teammate = store.getAiTeammate(step.teammateId);
    if (!teammate) {
      throw new HttpError(400, "teammate_not_found", `AI teammate not found: ${step.teammateId}`);
    }
    return {
      toParticipantId: teammate.id,
      toParticipantLabel: teammate.displayName,
    };
  }
  if (step.teammateTemplateId) {
    const skillPack = getBuiltinSkillPack(GSTACK_DEFAULT_SKILL_PACK_ID);
    const teammateTemplate = skillPack?.teammateTemplates.find((candidate) => candidate.id === step.teammateTemplateId);
    if (!teammateTemplate) {
      throw new HttpError(400, "teammate_template_not_found", `AI teammate template not found: ${step.teammateTemplateId}`);
    }
    const teammateId = createBuiltinAiTeammateId(step.teammateTemplateId);
    if (!store.getAiTeammate(teammateId)) {
      throw new HttpError(400, "teammate_not_found", `AI teammate not found for template: ${step.teammateTemplateId}`);
    }
    return {
      toParticipantId: teammateId,
      toParticipantLabel: teammateTemplate.name,
    };
  }
  throw new HttpError(400, "custom_workflow_template_invalid", `Step ${step.id} must resolve to teammateId or teammateTemplateId`);
}

function customTemplateStepHasSideEffects(store: RunStore, step: CustomWorkflowTemplateStep): boolean {
  if (step.gates && step.gates.length > 0) {
    return false;
  }
  const skillTools = step.skillId
    ? listExecutableSkillDefinitions(store).find((skill) => skill.id === step.skillId)?.requiredTools ?? []
    : [];
  return skillTools.some(isRiskyRunTool);
}

function defaultCustomWorkflowStepPolicy(_templateStep: CustomWorkflowTemplateStep): WorkflowStepPolicy {
  return {
    onRunFailed: "block_for_user",
    onRunCancelled: "block_for_user",
    onApprovalDenied: "block_for_user",
    retryable: true,
  };
}

function readOptionalCustomWorkflowTemplate(record: Record<string, unknown>, key: string): CustomWorkflowTemplate | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== 1) {
    throw new Error(`${key}.schemaVersion must be 1`);
  }
  const stepsValue = value.steps;
  if (!Array.isArray(stepsValue)) {
    throw new Error(`${key}.steps must be an array`);
  }
  const maxParallelSteps = readOptionalPositiveInteger(value, "maxParallelSteps");
  return {
    schemaVersion,
    id: readString(value, "id"),
    name: readString(value, "name"),
    description: readOptionalString(value, "description"),
    maxParallelSteps,
    autoStartDefault: readOptionalBoolean(value, "autoStartDefault"),
    steps: stepsValue.map((step, index) => readCustomWorkflowTemplateStep(step, `${key}.steps[${index}]`)),
  };
}

function readCustomWorkflowTemplateStep(value: unknown, location: string): CustomWorkflowTemplateStep {
  if (!isRecord(value)) {
    throw new Error(`${location} must be an object`);
  }
  return {
    id: readString(value, "id"),
    name: readString(value, "name"),
    prompt: readString(value, "prompt"),
    teammateTemplateId: readOptionalString(value, "teammateTemplateId"),
    teammateId: readOptionalString(value, "teammateId"),
    skillId: readOptionalString(value, "skillId"),
    providerPresetId: readOptionalString(value, "providerPresetId"),
    requestedRunnerId: readOptionalString(value, "requestedRunnerId"),
    dependsOn: readOptionalStringArray(value, "dependsOn"),
    branchGroupId: readOptionalString(value, "branchGroupId"),
    joinGroupId: readOptionalString(value, "joinGroupId"),
    dependencyMode: readOptionalDependencyMode(value, "dependencyMode"),
    maxParallelSiblings: readOptionalPositiveInteger(value, "maxParallelSiblings"),
    policy: readOptionalWorkflowStepPolicy(value, "policy"),
    gates: readOptionalWorkflowStepGates(value, "gates"),
    autoStart: readOptionalBoolean(value, "autoStart"),
  };
}

function readOptionalWorkflowStepPolicy(record: Record<string, unknown>, key: string): WorkflowStepPolicy | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  return {
    onRunFailed: readWorkflowStepFailurePolicy(value, "onRunFailed"),
    onRunCancelled: readWorkflowStepFailurePolicy(value, "onRunCancelled"),
    onApprovalDenied: readWorkflowStepFailurePolicy(value, "onApprovalDenied"),
    retryable: readOptionalBoolean(value, "retryable") ?? true,
    maxRetries: readOptionalPositiveInteger(value, "maxRetries"),
  };
}

function readOptionalWorkflowStepGates(record: Record<string, unknown>, key: string): readonly WorkflowStepGate[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array`);
  }
  return value.map((item, index) => readWorkflowStepGate(item, `${key}[${index}]`));
}

function readWorkflowStepGate(value: unknown, location: string): WorkflowStepGate {
  if (!isRecord(value)) {
    throw new Error(`${location} must be an object`);
  }
  const stage = value.stage;
  if (stage !== "pre" && stage !== "post") {
    throw new Error(`${location}.stage must be pre or post`);
  }
  return {
    stage,
    approvalProfile: readSkillApprovalProfile(value, "approvalProfile"),
    title: readString(value, "title"),
    reason: readString(value, "reason"),
    requiredForStatuses: readOptionalStringArray(value, "requiredForStatuses", channelWorkflowStepStatuses) as readonly ChannelWorkflowStepStatus[] | undefined,
  };
}

function readSkillApprovalProfile(record: Record<string, unknown>, key: string): SkillApprovalProfile {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  const mode = value.mode;
  if (mode !== "none" && mode !== "standard" && mode !== "strict") {
    throw new Error(`${key}.mode must be none, standard, or strict`);
  }
  return {
    mode,
    risk: readOptionalApprovalRisk(value, "risk"),
    requiredForTools: readOptionalStringArray(value, "requiredForTools", ["read", "grep", "find", "ls", "bash", "edit", "write"] satisfies readonly RunTool[]),
    requiredForActions: readOptionalStringArray(value, "requiredForActions", approvalActionTypes),
  };
}

function readOptionalDependencyMode(record: Record<string, unknown>, key: string): ChannelWorkflowStepMetadata["dependencyMode"] | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined || value === "all_succeeded" || value === "all_terminal" || value === "any_succeeded") {
    return value;
  }
  throw new Error(`${key} must be all_succeeded, all_terminal, or any_succeeded`);
}

function readWorkflowStepFailurePolicy(record: Record<string, unknown>, key: string): WorkflowStepFailurePolicy {
  const value = readString(record, key);
  if (value === "block_for_user" || value === "fail_workflow" || value === "cancel_workflow" || value === "skip_if_optional") {
    return value;
  }
  throw new Error(`${key} must be a valid workflow step failure policy`);
}

function readOptionalApprovalRisk(record: Record<string, unknown>, key: string): SkillApprovalProfile["risk"] | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined || value === "low" || value === "medium" || value === "high" || value === "critical") {
    return value;
  }
  throw new Error(`${key} must be low, medium, high, or critical`);
}

function readOptionalPositiveInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = readOptionalNumber(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

function omitUndefined<T extends object>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

function isString(value: string | undefined): value is string {
  return typeof value === "string";
}
