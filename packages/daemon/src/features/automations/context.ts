import type {
  AutomationContextSelector,
  AutomationDefinition,
  RunArtifact,
  RunSession,
  RunStore,
} from "@ling-stack/core";

export interface AutomationContextRef {
  readonly kind: string;
  readonly id?: string;
  readonly label?: string;
}

export interface AutomationContextBuildInput {
  readonly store: RunStore;
  readonly automation: AutomationDefinition;
  readonly now: string;
  readonly mode: "preview" | "run";
}

export interface AutomationContextBuildResult {
  readonly renderedPrompt: string;
  readonly contextMarkdown: string;
  readonly selectedRefs: readonly AutomationContextRef[];
  readonly warnings: readonly string[];
}

export function buildAutomationContext(input: AutomationContextBuildInput): AutomationContextBuildResult {
  const sections: string[] = [];
  const selectedRefs: AutomationContextRef[] = [];
  const warnings: string[] = [];
  const channelId = input.automation.channelId ?? input.automation.target.channelId;

  for (const selector of input.automation.promptTemplate.contextSelectors) {
    const section = buildSelectorSection({
      store: input.store,
      selector,
      channelId,
      selectedRefs,
      warnings,
    });
    if (section) {
      sections.push(section);
    }
  }

  const contextMarkdown = [
    `# Automation Context`,
    "",
    `Generated: ${input.now}`,
    `Automation: ${input.automation.title} (${input.automation.id})`,
    `Mode: ${input.mode}`,
    channelId ? `Channel: ${channelId}` : undefined,
    "",
    ...sections,
    warnings.length > 0 ? ["## Warnings", ...warnings.map((warning) => `- ${warning}`)].join("\n") : undefined,
  ].filter((value): value is string => Boolean(value)).join("\n");

  const renderedPrompt = [
    input.automation.promptTemplate.systemPurpose ? `System purpose:\n${input.automation.promptTemplate.systemPurpose}` : undefined,
    input.automation.promptTemplate.promptMarkdown,
    "",
    "Use the following deterministic Ling context. Do not claim facts that are not present here.",
    "",
    contextMarkdown,
  ].filter((value): value is string => Boolean(value)).join("\n\n");

  return { renderedPrompt, contextMarkdown, selectedRefs, warnings };
}

function buildSelectorSection(input: {
  readonly store: RunStore;
  readonly selector: AutomationContextSelector;
  readonly channelId?: string;
  readonly selectedRefs: AutomationContextRef[];
  readonly warnings: string[];
}): string | undefined {
  switch (input.selector.kind) {
    case "channel_brief":
      return buildChannelBriefSection(input.store, input.selector.channelId ?? input.channelId, input.selectedRefs, input.warnings);
    case "recent_runs":
      return buildRecentRunsSection(input.store, input.channelId, input.selector.limit, input.selectedRefs);
    case "pending_approvals":
      return buildPendingApprovalsSection(input.store, input.selector.limit, input.selectedRefs);
    case "recent_artifacts":
      return buildRecentArtifactsSection(input.store, input.channelId, input.selector.limit, input.selectedRefs);
    case "state_transitions":
      return buildStateTransitionsSection(input.store, input.selector.limit, input.selectedRefs);
    case "external_work":
      return buildExternalWorkSection(input.store, input.channelId, input.selector.status, input.selector.limit, input.selectedRefs);
    case "doctor_summary":
      input.warnings.push("doctor_summary selector is not available in P0 preview.");
      return undefined;
    case "mcp_status":
      input.warnings.push("mcp_status selector is not available in P0 preview.");
      return undefined;
  }
}

function buildChannelBriefSection(
  store: RunStore,
  channelId: string | undefined,
  selectedRefs: AutomationContextRef[],
  warnings: string[],
): string | undefined {
  if (!channelId) {
    warnings.push("channel_brief selector skipped because no channel target was set.");
    return undefined;
  }
  const brief = store.getChannelBrief(channelId);
  if (!brief) {
    warnings.push(`No channel brief found for ${channelId}.`);
    return undefined;
  }
  selectedRefs.push({ kind: "channel_brief", id: brief.id, label: brief.objective });
  return [
    "## Channel Brief",
    `Objective: ${brief.objective}`,
    `Scope: ${brief.scope}`,
    listBlock("Acceptance criteria", brief.acceptanceCriteria),
    listBlock("Open questions", brief.openQuestions),
    listBlock("Risks", brief.risks),
  ].filter(Boolean).join("\n");
}

function buildRecentRunsSection(
  store: RunStore,
  channelId: string | undefined,
  limit: number,
  selectedRefs: AutomationContextRef[],
): string | undefined {
  const runs = filterRunsForChannel(store.listRuns({ limit: Math.min(limit * 4, 100) }), channelId).slice(0, limit);
  if (runs.length === 0) {
    return undefined;
  }
  for (const run of runs) {
    selectedRefs.push({ kind: "run", id: run.id, label: run.taskId });
  }
  return [
    "## Recent Runs",
    ...runs.map((run) => `- ${run.id}: ${run.status}; task=${run.taskId}; created=${run.createdAt}${run.errorMessage ? `; error=${run.errorMessage}` : ""}`),
  ].join("\n");
}

function buildPendingApprovalsSection(store: RunStore, limit: number, selectedRefs: AutomationContextRef[]): string | undefined {
  const approvals = store.listApprovalRequests({ status: "pending", limit });
  if (approvals.length === 0) {
    return undefined;
  }
  for (const approval of approvals) {
    selectedRefs.push({ kind: "approval", id: approval.id, label: approval.title });
  }
  return [
    "## Pending Approvals",
    ...approvals.map((approval) => `- ${approval.id}: ${approval.title}; risk=${approval.risk}; action=${approval.actionType}; created=${approval.createdAt}`),
  ].join("\n");
}

function buildRecentArtifactsSection(
  store: RunStore,
  channelId: string | undefined,
  limit: number,
  selectedRefs: AutomationContextRef[],
): string | undefined {
  const artifacts: Array<{ readonly run: RunSession; readonly artifact: RunArtifact }> = [];
  const runs = filterRunsForChannel(store.listRuns({ limit: Math.min(limit * 4, 100) }), channelId);
  for (const run of runs) {
    for (const artifact of store.listArtifacts(run.id)) {
      artifacts.push({ run, artifact });
    }
  }
  const selected = artifacts.slice(0, limit);
  if (selected.length === 0) {
    return undefined;
  }
  for (const item of selected) {
    selectedRefs.push({ kind: "artifact", id: item.artifact.id, label: item.artifact.title ?? item.artifact.path });
  }
  return [
    "## Recent Artifacts",
    ...selected.map((item) => `- ${item.artifact.id}: ${item.artifact.title ?? item.artifact.path}; type=${item.artifact.type}; run=${item.run.id}`),
  ].join("\n");
}

function buildStateTransitionsSection(store: RunStore, limit: number, selectedRefs: AutomationContextRef[]): string | undefined {
  const transitions = store.listStateTransitionEvents({ limit });
  if (transitions.length === 0) {
    return undefined;
  }
  for (const transition of transitions) {
    selectedRefs.push({ kind: "state_transition", id: transition.id, label: `${transition.entityType}:${transition.entityId}` });
  }
  return [
    "## Recent State Transitions",
    ...transitions.map((transition) => `- ${transition.id}: ${transition.entityType}:${transition.entityId} ${transition.fromStatus ?? "none"} -> ${transition.toStatus}; event=${transition.event}; actor=${transition.actor}`),
  ].join("\n");
}

function buildExternalWorkSection(
  store: RunStore,
  channelId: string | undefined,
  status: string | undefined,
  limit: number,
  selectedRefs: AutomationContextRef[],
): string | undefined {
  const records = store.listExternalWorkRecords({ channelId, limit });
  if (records.length === 0) {
    return undefined;
  }
  for (const record of records) {
    selectedRefs.push({ kind: "external_work", id: record.id, label: record.identifier });
  }
  return [
    "## External Work",
    ...(status ? [`Requested status filter "${status}" is not available in the P0 record summary.`] : []),
    ...records.map((record) => `- ${record.id}: ${record.identifier}; source=${record.sourceKind}; item=${record.workItemKind}; updated=${record.updatedAt}`),
  ].join("\n");
}

function filterRunsForChannel(runs: readonly RunSession[], channelId: string | undefined): RunSession[] {
  if (!channelId) {
    return [...runs];
  }
  return runs.filter((run) => run.channelId === channelId);
}

function listBlock(label: string, values: readonly string[]): string | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return [`${label}:`, ...values.map((value) => `- ${value}`)].join("\n");
}
