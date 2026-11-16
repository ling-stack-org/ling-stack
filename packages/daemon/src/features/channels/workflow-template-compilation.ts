import { isDeepStrictEqual } from "node:util";
import {
  DEFAULT_RUNNER_ID, buildEffectiveTeammateSkills, getEffectiveTeammateSkill,
  createSqliteWorkflowTemplateRegistryStore, parseWorkflowTemplateCompilation,
  workflowTemplateCompilationFingerprint, workflowTemplateDigest, workflowTemplateReferenceDigest,
  resolveEffectiveTeammateProvider,
  type AiTeammate, type ChannelWorkflowStep, type ProviderPreset, type RunStore, type SkillDefinition,
} from "@ling-stack/core";
import { type CustomWorkflowTemplate, type WorkflowTemplateCompilationV1, type WorkflowTemplatePin,
  type WorkflowTemplateResolvedStepV1 } from "@ling-stack/contracts";
import { HttpError } from "../../errors.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import { loadWorkspaceRuntimeSettings } from "../../runtime/runner-settings.js";
import { listExecutableSkillDefinitions } from "../skills/registry.js";

export function workflowTemplateParticipantDigest(teammate: AiTeammate): string {
  return workflowTemplateReferenceDigest({ id: teammate.id, roleKey: teammate.roleKey, systemPrompt: teammate.systemPrompt,
    appendSystemPrompt: teammate.appendSystemPrompt, allowedTools: teammate.allowedTools, approvalProfile: teammate.approvalProfile });
}

export function workflowTemplateProviderDigest(provider: ProviderPreset): string {
  const { createdAt: _created, updatedAt: _updated, lastCheck: _check, displayName: _name, enabled: _enabled, ...configuration } = provider;
  return workflowTemplateReferenceDigest(configuration);
}

function skillDigest(store: RunStore, definition: SkillDefinition): string {
  const source = store.getSkillSourceSnapshot(definition.id);
  return workflowTemplateReferenceDigest({ definition, source: source ? {
    id: source.id, sourceKind: source.sourceKind, sourceChecksum: source.sourceChecksum,
    rawSkillMarkdown: source.rawSkillMarkdown, agentMetadata: source.agentMetadata,
    referencedFiles: source.referencedFiles, reviewStatus: source.reviewStatus,
  } : null });
}

export function resolveWorkflowTemplateCompilation(input: {
  readonly store: RunStore; readonly channelId: string; readonly template: CustomWorkflowTemplate;
  readonly objective: string; readonly autoStart?: boolean;
  readonly source: "inline" | "registry"; readonly templatePin?: WorkflowTemplatePin;
  readonly providerPresetId?: string; readonly runnerId?: string; readonly runnerRegistry?: RunnerRegistry;
  readonly resolveParticipant: (step: CustomWorkflowTemplate["steps"][number]) => { readonly toParticipantId: string; readonly toParticipantLabel: string };
  readonly resolveSafety: (step: CustomWorkflowTemplate["steps"][number]) => Pick<WorkflowTemplateResolvedStepV1, "sideEffectClass" | "parallelPolicy">;
}): WorkflowTemplateCompilationV1 {
  const { store, template } = input, channel = store.getChannel(input.channelId)!;
  const skills = listExecutableSkillDefinitions(store);
  const settings = input.runnerRegistry ? loadWorkspaceRuntimeSettings(store, input.runnerRegistry) : undefined;
  const steps = template.steps.map((step): WorkflowTemplateResolvedStepV1 => {
    const participant = input.resolveParticipant(step), teammate = store.getAiTeammate(participant.toParticipantId);
    if (!teammate || teammate.status !== "active") throw stale(`Participant is unavailable: ${participant.toParticipantId}`);
    const skill = step.skillId ? skills.find(item => item.id === step.skillId) : undefined;
    if (step.skillId && !skill) throw stale(`Skill is unavailable: ${step.skillId}`);
    const providerResolution = resolveEffectiveTeammateProvider({ teammate, surface: "channel",
      workspaceDefaultProviderPresetId: store.getWorkspaceSettings().defaultProviderPresetId,
      channelDefaultProviderPresetId: channel.defaultProviderPresetId });
    const providerPresetId = step.providerPresetId ?? input.providerPresetId
      ?? (providerResolution.kind === "resolved" ? providerResolution.binding.providerPresetId : undefined);
    const provider = providerPresetId ? store.getProviderPreset(providerPresetId) : undefined;
    if (input.source === "registry" && (!provider || !provider.enabled)) throw stale(`Provider is unavailable for step ${step.id}`);
    if (skill) {
      const effective = getEffectiveTeammateSkill(buildEffectiveTeammateSkills({ teammate, skills,
        bindings: store.listTeammateSkillBindings(teammate.id), channelAllowedTools: channel.allowedTools,
        providerCapabilities: provider?.capabilities }), skill.id);
      if (!effective?.executable) throw stale(`Skill is unavailable for step ${step.id}`);
    }
    const requestedRunnerId = step.requestedRunnerId ?? input.runnerId ?? teammate.runnerId ?? settings?.defaultRunnerId ?? DEFAULT_RUNNER_ID;
    const runnerId = input.runnerRegistry ? input.runnerRegistry.resolve({ requestedRunnerId,
      allowedRunnerIds: settings?.allowedRunnerIds, allowFallback: false,
      tools: skill?.requiredTools }).effectiveRunnerId : requestedRunnerId;
    return { templateStepId: step.id, title: step.name,
      prompt: [ `Workflow objective:\n${input.objective}`, `Current step: ${step.name}`,
        step.skillId ? `Skill: ${step.skillId}` : undefined, step.prompt,
        "Complete this step only. Do not start or approve later workflow steps.",
        "Return a concise terminal summary and any artifacts or follow-up decisions needed by later steps.",
      ].filter(item => item !== undefined).join("\n\n"),
      autoStart: step.autoStart ?? input.autoStart ?? template.autoStartDefault ?? false,
      policy: step.policy ?? { onRunFailed: "block_for_user", onRunCancelled: "block_for_user", onApprovalDenied: "block_for_user", retryable: true },
      ...(step.gates ? { gates: step.gates } : {}),
      ...participant, participantDigest: workflowTemplateParticipantDigest(teammate),
      ...(skill ? { skillId: skill.id, skillDigest: skillDigest(store, skill) } : {}), runnerId,
      ...(providerPresetId ? { providerPresetId } : {}), ...(provider ? { providerDigest: workflowTemplateProviderDigest(provider) } : {}),
      requiredTools: [...(skill?.requiredTools ?? [])].sort(), dependsOn: [...(step.dependsOn ?? [])], ...input.resolveSafety(step) };
  });
  const basis = { schemaVersion: 1 as const, source: input.source,
    templatePin: input.templatePin ?? { id: template.id, version: `custom:${template.schemaVersion}`, digest: workflowTemplateDigest(template) },
    template, objective: input.objective, steps };
  return { ...basis, graphFingerprint: workflowTemplateCompilationFingerprint(basis) };
}

/** Pin checks intersect the frozen definition with current revocation; they never grant tools. */
export function assertWorkflowTemplateCompilationCurrent(store: RunStore, step: ChannelWorkflowStep): void {
  const workflow = store.getChannelWorkflow(step.workflowId), raw = workflow?.metadata?.templateCompilation;
  const pin = step.metadata?.templateCompilationPin;
  if (!raw && !pin) return;
  if (!raw || !pin) throw stale("Template compilation pin or snapshot is missing.");
  const compilation = parseWorkflowTemplateCompilation(raw);
  if (!isDeepStrictEqual(pin, { ...compilation.templatePin, graphFingerprint: compilation.graphFingerprint })
    || workflow?.objective !== compilation.objective || workflow.metadata?.maxParallelSteps !== compilation.template.maxParallelSteps) throw stale("Template pin or frozen objective changed.");
  if (compilation.source === "registry") {
    const registry = createSqliteWorkflowTemplateRegistryStore(store), entry = registry.get(pin.id);
    const version = registry.getVersion(pin.id, pin.version);
    if (!entry || ["disabled", "archived"].includes(entry.reviewStatus) || !version || version.digest !== pin.digest) throw stale("Template was revoked or its historical version cannot be verified.");
    if (!entry.visibility.workspaceVisible && entry.visibility.ownerTeammateId !== step.toParticipantId) throw stale("Template visibility was revoked.");
  }
  const resolved = compilation.steps.find(item => item.templateStepId === step.metadata?.templateStepId);
  const definition = compilation.template.steps.find(item => item.id === step.metadata?.templateStepId);
  const teammate = store.getAiTeammate(step.toParticipantId);
  if (!resolved || !definition || !teammate || teammate.status !== "active" || resolved.toParticipantId !== step.toParticipantId
    || workflowTemplateParticipantDigest(teammate) !== resolved.participantDigest
    || step.metadata?.skillId !== resolved.skillId || step.metadata?.requestedRunnerId !== resolved.runnerId
    || step.metadata?.providerPresetId !== resolved.providerPresetId
    || step.metadata?.workflowTemplateId !== compilation.template.id || step.metadata?.templateVersion !== compilation.templatePin.version
    || step.title !== resolved.title || step.prompt !== resolved.prompt || step.metadata?.autoStart !== resolved.autoStart
    || !isDeepStrictEqual(step.metadata?.policy, resolved.policy) || !isDeepStrictEqual(step.metadata?.gates, resolved.gates)
    || step.metadata?.approvalGate !== undefined
    || step.position !== compilation.steps.indexOf(resolved) + 1
    || step.metadata?.branchGroupId !== definition.branchGroupId || step.metadata?.joinGroupId !== definition.joinGroupId
    || step.metadata?.dependencyMode !== definition.dependencyMode
    || step.metadata?.maxParallelSiblings !== resolved.parallelPolicy?.maxParallelSiblings
    || !isDeepStrictEqual(step.metadata?.requiredTools, resolved.requiredTools)
    || !isDeepStrictEqual(step.metadata?.sideEffectClass, resolved.sideEffectClass)
    || !isDeepStrictEqual(step.metadata?.parallelPolicy, resolved.parallelPolicy)) throw stale("A frozen participant, skill, Runner or safety reference changed.");
  const siblings = store.listChannelWorkflowSteps({ workflowId: step.workflowId, complete: true });
  if (siblings.length !== compilation.steps.length || new Set(siblings.map(sibling => sibling.metadata?.templateStepId)).size !== siblings.length) throw stale("Frozen template nodes changed.");
  const dependencies = (step.metadata?.dependsOnStepIds ?? []).map(id => siblings.find(sibling => sibling.id === id)?.metadata?.templateStepId);
  if (!isDeepStrictEqual(dependencies, resolved.dependsOn)) throw stale("Frozen template dependencies changed.");
  if (resolved.skillId) {
    const skills = listExecutableSkillDefinitions(store), skill = skills.find(item => item.id === resolved.skillId);
    const effective = getEffectiveTeammateSkill(buildEffectiveTeammateSkills({ teammate,
      bindings: store.listTeammateSkillBindings(teammate.id), skills,
      channelAllowedTools: store.getChannel(step.channelId)?.allowedTools,
      providerCapabilities: resolved.providerPresetId ? store.getProviderPreset(resolved.providerPresetId)?.capabilities : undefined }), resolved.skillId);
    if (!skill || !effective?.executable || skillDigest(store, skill) !== resolved.skillDigest) throw stale("The frozen skill or its source was changed or revoked; recompile explicitly.");
  }
  if (resolved.providerDigest) {
    const provider = store.getProviderPreset(resolved.providerPresetId!);
    if (!provider?.enabled || workflowTemplateProviderDigest(provider) !== resolved.providerDigest) throw stale("The frozen Provider was changed or disabled; recompile explicitly.");
  }
}

function stale(message: string): HttpError { return new HttpError(409, "workflow_template_compilation_stale", message); }
