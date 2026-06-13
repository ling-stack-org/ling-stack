import type { Channel, ChannelWorkflow, ChannelWorkflowStep, RunStore, SkillApprovalProfile } from "@ling-stack/core";
import { collectChannelStateSource, collectWorkflowEvidenceSources, collectWorkflowStepSource } from "./sources.js";
import type { ChannelContextBudgetSnapshot, ChannelContextSection, ChannelContextSourceRef, ChannelContextView } from "./types.js";
import { buildChannelContextView } from "./views.js";

export interface WorkflowStepContextPackInput {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly workflow: ChannelWorkflow;
  readonly step: ChannelWorkflowStep;
  readonly prompt: string;
  readonly providerPresetId?: string;
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly compactedDependencySummary?: WorkflowStepCompactedDependencySummary;
}

export interface WorkflowStepCompactedDependencySummary {
  readonly id: string;
  readonly text: string;
  readonly sourceRefs: readonly ChannelContextSourceRef[];
  readonly sourceRefIds: readonly string[];
}

export interface BuildWorkflowStepContextViewInput extends WorkflowStepContextPackInput {
  readonly protocolSection: ChannelContextSection;
  readonly budget?: ChannelContextBudgetSnapshot;
}

export function buildWorkflowStepContextView(input: BuildWorkflowStepContextViewInput): ChannelContextView {
  const sourceRefs = buildWorkflowStepContextSourceRefs(input);
  const dependencySections = input.compactedDependencySummary
    ? [buildCompactedWorkflowDependencySection(input.compactedDependencySummary)]
    : buildWorkflowStepDependencySections(input);
  const contextSummary = input.step.contextSummaryId
    ? input.store.getChannelContextSummary(input.step.contextSummaryId)
    : undefined;
  const compactedSourceRefs = input.compactedDependencySummary
    ? uniqueContextSourceRefs([...sourceRefs, ...input.compactedDependencySummary.sourceRefs])
    : sourceRefs;
  const sections: readonly ChannelContextSection[] = [
    {
      id: "workflow_runtime_boundary",
      role: "instruction",
      priority: "must_keep",
      title: "workflow_runtime_boundary",
      text: [
        "Workflow step runtime boundary:",
        "- Complete this step only.",
        "- Do not start, approve, skip, or mark later workflow steps.",
        "- The Ling orchestrator owns sequencing, workflow state transitions, and approval gates.",
        "- Do not self-approve tools, writes, releases, external sends, deploys, or other side effects.",
        "- Return a concise terminal summary plus artifacts, blockers, decisions, or handoff needs for later steps.",
      ].join("\n"),
      sourceRefIds: [],
      visibility: "prompt",
      quotePolicy: "public_ok",
    },
    {
      id: "workflow_objective",
      role: "user",
      priority: "must_keep",
      title: "workflow_objective",
      text: [
        "Workflow objective:",
        input.workflow.objective || "No objective provided.",
        "",
        `Workflow: ${input.workflow.title}`,
        `Channel: ${input.channel.name}`,
        input.channel.boundPath ? `Bound path: ${input.channel.boundPath}` : undefined,
      ].filter((line): line is string => line !== undefined).join("\n"),
      sourceRefIds: [input.workflow.id, input.channel.id],
      visibility: "prompt",
      quotePolicy: "public_ok",
    },
    {
      id: "workflow_current_step",
      role: "user",
      priority: "must_keep",
      title: "workflow_current_step",
      text: [
        "Current workflow step:",
        `Title: ${input.step.title}`,
        `Workflow step id: ${input.step.id}`,
        input.step.metadata?.templateStepId ? `Template step id: ${input.step.metadata.templateStepId}` : undefined,
        input.step.metadata?.graphNodeId ? `Graph node id: ${input.step.metadata.graphNodeId}` : undefined,
        input.step.toParticipantId ? `Assigned teammate: ${input.step.toParticipantLabel ?? input.step.toParticipantId} (${input.step.toParticipantId})` : undefined,
        input.step.metadata?.skillId ? `Skill: ${input.step.metadata.skillId}` : undefined,
        "",
        "Step instruction:",
        input.prompt,
      ].filter((line): line is string => line !== undefined).join("\n"),
      sourceRefIds: [input.step.id],
      visibility: "prompt",
      quotePolicy: "public_ok",
    },
    {
      id: "workflow_approval_gates",
      role: "instruction",
      priority: "high",
      title: "workflow_approval_gates",
      text: [
        "Approval gates:",
        ...formatWorkflowApprovalGatePromptLines(input.step),
      ].join("\n"),
      sourceRefIds: [input.step.id],
      visibility: "prompt",
      quotePolicy: "public_ok",
    },
    ...dependencySections,
    ...formatWorkflowDecisionAndHandoffSections(input),
    ...(contextSummary
      ? [{
          id: "workflow_context_summary",
          role: "evidence" as const,
          priority: "medium" as const,
          title: "workflow_context_summary",
          text: [
            "Channel context summary:",
            contextSummary.summary,
            contextSummary.acceptanceCriteria.length > 0 ? `Acceptance criteria: ${contextSummary.acceptanceCriteria.join("; ")}` : undefined,
            contextSummary.openQuestions.length > 0 ? `Open questions: ${contextSummary.openQuestions.join("; ")}` : undefined,
          ].filter((line): line is string => line !== undefined).join("\n"),
          sourceRefIds: [contextSummary.id],
          visibility: "prompt" as const,
          quotePolicy: "public_ok" as const,
        }]
      : []),
    input.protocolSection,
  ];
  return buildChannelContextView({
    kind: "workflow_step_view",
    workspaceId: input.channel.workspaceId,
    channelId: input.channel.id,
    consumerTeammateId: input.step.toParticipantId,
    sections,
    sourceRefs: compactedSourceRefs,
    compactionIds: input.compactedDependencySummary ? [input.compactedDependencySummary.id] : undefined,
    budget: input.budget,
    sources: [
      collectChannelStateSource({
        channel: input.channel,
        text: input.protocolSection.text,
        metadata: input.protocolSection.metadata,
      }),
      collectWorkflowStepSource({ channel: input.channel, workflow: input.workflow, step: input.step }),
      ...collectWorkflowEvidenceSources({
        store: input.store,
        channel: input.channel,
        workflow: input.workflow,
        step: input.step,
      }),
    ],
  });
}

function buildCompactedWorkflowDependencySection(summary: WorkflowStepCompactedDependencySummary): ChannelContextSection {
  return {
    id: "workflow_dependency_summary",
    role: "evidence",
    priority: "high",
    title: "workflow_dependency_summary",
    text: summary.text,
    sourceRefIds: summary.sourceRefIds,
    visibility: "prompt",
    quotePolicy: "public_ok",
  };
}

function buildWorkflowStepDependencySections(input: WorkflowStepContextPackInput): readonly ChannelContextSection[] {
  const stepsById = new Map(input.workflowSteps.map((candidate) => [candidate.id, candidate] as const));
  const dependencies = (input.step.metadata?.dependsOnStepIds ?? [])
    .map((stepId) => stepsById.get(stepId))
    .filter((candidate): candidate is ChannelWorkflowStep => candidate !== undefined);
  if (dependencies.length === 0) {
    return [{
      id: "workflow_dependencies",
      role: "evidence",
      priority: "high",
      title: "workflow_dependencies",
      text: "Dependencies:\n- none",
      sourceRefIds: [input.step.id],
      visibility: "prompt",
      quotePolicy: "public_ok",
    }];
  }
  return dependencies.map((dependency, index) => {
    const artifactIds = uniqueStrings([
      dependency.metadata?.outputArtifactId,
      ...(dependency.metadata?.outputArtifactIds ?? []),
      ...(dependency.runId ? input.store.listArtifacts(dependency.runId).map((artifact) => artifact.id) : []),
    ]);
    return {
      id: `workflow_dependency_${index + 1}`,
      role: "evidence",
      priority: "high",
      title: `workflow_dependency_${index + 1}`,
      text: [
        "Dependency output:",
        `- ${dependency.title} (${dependency.status})`,
        `  workflowStepId: ${dependency.id}`,
        `  runId: ${dependency.runId ?? "none"}`,
        `  outputArtifactId: ${dependency.metadata?.outputArtifactId ?? "none"}`,
        `  artifactIds: ${artifactIds.length > 0 ? artifactIds.join(", ") : "none"}`,
        `  resultSummary: ${dependency.resultSummary ? truncateWorkflowPromptValue(dependency.resultSummary, 420) : "none"}`,
      ].filter((line): line is string => line !== undefined).join("\n"),
      sourceRefIds: [dependency.id, ...artifactIds],
      visibility: "prompt",
      quotePolicy: "public_ok",
    };
  });
}

function formatWorkflowDecisionAndHandoffSections(input: WorkflowStepContextPackInput): readonly ChannelContextSection[] {
  const selectorDecisionIds = input.step.metadata?.selectorDecisionIds ?? [];
  const handoffIntentIds = input.step.metadata?.handoffIntentIds ?? [];
  const sections: ChannelContextSection[] = [];
  if (selectorDecisionIds.length > 0) {
    const lines = selectorDecisionIds.map((decisionId) => {
      const decision = input.store.getWorkflowSelectorDecision(decisionId);
      return decision
        ? `- ${decision.targetKind}: ${decision.reason} (status=${decision.status}, createdBy=${decision.createdBy})`
        : `- ${decisionId}: missing selector decision`;
    });
    sections.push({
      id: "workflow_selector_decisions",
      role: "evidence",
      priority: "high",
      title: "workflow_selector_decisions",
      text: ["Workflow selector decisions:", ...lines].join("\n"),
      sourceRefIds: selectorDecisionIds,
      visibility: "prompt",
      quotePolicy: "public_ok",
    });
  }
  if (handoffIntentIds.length > 0) {
    const lines = handoffIntentIds.map((intentId) => {
      const intent = input.store.getWorkflowHandoffIntent(intentId);
      return intent
        ? `- ${intent.fromParticipantLabel} -> ${intent.toParticipantLabel ?? intent.toParticipantId}: ${intent.reason} (status=${intent.status})`
        : `- ${intentId}: missing handoff intent`;
    });
    sections.push({
      id: "workflow_handoff_intents",
      role: "evidence",
      priority: "high",
      title: "workflow_handoff_intents",
      text: ["Workflow handoff intents:", ...lines].join("\n"),
      sourceRefIds: handoffIntentIds,
      visibility: "prompt",
      quotePolicy: "public_ok",
    });
  }
  return sections;
}

function buildWorkflowStepContextSourceRefs(input: WorkflowStepContextPackInput): readonly ChannelContextSourceRef[] {
  const refs: ChannelContextSourceRef[] = [
    { type: "channel", id: input.channel.id, label: input.channel.name },
    { type: "workflow", id: input.workflow.id, label: input.workflow.title },
    { type: "workflow_step", id: input.step.id, label: input.step.title },
  ];
  if (input.step.contextSummaryId) {
    const summary = input.store.getChannelContextSummary(input.step.contextSummaryId);
    refs.push({ type: "context_summary", id: input.step.contextSummaryId, label: summary?.summary });
  }
  for (const stepId of input.step.metadata?.dependsOnStepIds ?? []) {
    const dependency = input.workflowSteps.find((candidate) => candidate.id === stepId);
    refs.push({ type: "workflow_step", id: stepId, label: dependency?.title });
    if (dependency?.metadata?.outputArtifactId) {
      const artifact = input.store.getArtifact(dependency.metadata.outputArtifactId);
      refs.push({ type: "artifact", id: dependency.metadata.outputArtifactId, label: artifact?.title ?? artifact?.path });
    }
    for (const artifactId of dependency?.metadata?.outputArtifactIds ?? []) {
      const artifact = input.store.getArtifact(artifactId);
      refs.push({ type: "artifact", id: artifactId, label: artifact?.title ?? artifact?.path });
    }
    if (dependency?.runId) {
      refs.push({ type: "run", id: dependency.runId, label: "Dependency run" });
      for (const artifact of input.store.listArtifacts(dependency.runId)) {
        refs.push({ type: "artifact", id: artifact.id, label: artifact.title ?? artifact.path });
      }
    }
  }
  for (const decisionId of input.step.metadata?.selectorDecisionIds ?? []) {
    const decision = input.store.getWorkflowSelectorDecision(decisionId);
    refs.push({ type: "workflow_selector_decision", id: decisionId, label: decision?.reason });
  }
  for (const intentId of input.step.metadata?.handoffIntentIds ?? []) {
    const intent = input.store.getWorkflowHandoffIntent(intentId);
    refs.push({ type: "workflow_handoff_intent", id: intentId, label: intent?.reason });
  }
  return uniqueContextSourceRefs(refs);
}

function formatWorkflowApprovalGatePromptLines(step: ChannelWorkflowStep): readonly string[] {
  const lines: string[] = [];
  if (step.metadata?.approvalGate) {
    lines.push(`- pre-run: ${formatApprovalProfileSummary(step.metadata.approvalGate)}`);
  }
  for (const gate of step.metadata?.gates ?? []) {
    lines.push(`- ${gate.stage}: ${gate.title} (${formatApprovalProfileSummary(gate.approvalProfile)})`);
    lines.push(`  reason: ${truncateWorkflowPromptValue(gate.reason, 180)}`);
    lines.push(`  requiredForStatuses: ${gate.requiredForStatuses?.join(", ") ?? "any"}`);
  }
  return lines.length > 0 ? lines : ["- none"];
}

function formatApprovalProfileSummary(profile: SkillApprovalProfile): string {
  return [
    `mode=${profile.mode}`,
    profile.risk ? `risk=${profile.risk}` : undefined,
    profile.requiredForTools?.length ? `tools=${profile.requiredForTools.join(",")}` : undefined,
    profile.requiredForActions?.length ? `actions=${profile.requiredForActions.join(",")}` : undefined,
  ].filter((item): item is string => Boolean(item)).join("; ");
}

function truncateWorkflowPromptValue(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function uniqueContextSourceRefs(refs: readonly ChannelContextSourceRef[]): readonly ChannelContextSourceRef[] {
  const seen = new Set<string>();
  const unique: ChannelContextSourceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}

function uniqueStrings(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0)))];
}
