import {
  readAutomationContextItemBudget,
  type AutomationContextSelector,
  type AutomationDefinition,
  type RunArtifact,
  type RunSession,
  type RunStore,
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

interface AutomationContextItem {
  readonly ref: AutomationContextRef;
  readonly renderMarkdown: () => string;
}

interface AutomationContextSection {
  readonly heading: string;
  readonly introduction?: string;
  readonly items: readonly AutomationContextItem[];
}

export function buildAutomationContext(input: AutomationContextBuildInput): AutomationContextBuildResult {
  // Validate before Store reads, including historical values not admitted by HTTP.
  const maxContextItems = readAutomationContextItemBudget(input.automation.promptTemplate.maxContextItems);
  const sections: string[] = [];
  const selectedRefs: AutomationContextRef[] = [];
  const warnings: string[] = [];
  let omittedItems = 0;
  const channelId = input.automation.channelId ?? input.automation.target.channelId;

  for (const selector of input.automation.promptTemplate.contextSelectors) {
    const section = buildSelectorSection({
      store: input.store,
      selector,
      channelId,
      warnings,
    });
    if (section) {
      const remaining = maxContextItems === undefined ? section.items.length : Math.max(0, maxContextItems - selectedRefs.length);
      const selectedItems = section.items.slice(0, remaining);
      omittedItems += section.items.length - selectedItems.length;
      if (selectedItems.length > 0) {
        // Repeated selectors remain repeated occurrences. One chosen set owns
        // both refs and complete bodies; omitted items are never rendered.
        selectedRefs.push(...selectedItems.map((item) => item.ref));
        sections.push([
          section.heading,
          section.introduction,
          ...selectedItems.map((item) => item.renderMarkdown()),
        ].filter((value): value is string => value !== undefined).join("\n"));
      }
    }
  }
  if (omittedItems > 0) {
    warnings.push(`Context item budget (maxContextItems=${maxContextItems}) omitted ${omittedItems} whole context items.`);
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
  readonly warnings: string[];
}): AutomationContextSection | undefined {
  switch (input.selector.kind) {
    case "channel_brief":
      return buildChannelBriefSection(input.store, input.selector.channelId ?? input.channelId, input.warnings);
    case "recent_runs":
      return buildRecentRunsSection(input.store, input.channelId, input.selector.limit);
    case "pending_approvals":
      return buildPendingApprovalsSection(input.store, input.selector.limit);
    case "recent_artifacts":
      return buildRecentArtifactsSection(input.store, input.channelId, input.selector.limit);
    case "state_transitions":
      return buildStateTransitionsSection(input.store, input.selector.limit);
    case "external_work":
      return buildExternalWorkSection(input.store, input.channelId, input.selector.status, input.selector.limit);
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
  warnings: string[],
): AutomationContextSection | undefined {
  if (!channelId) {
    warnings.push("channel_brief selector skipped because no channel target was set.");
    return undefined;
  }
  const brief = store.getChannelBrief(channelId);
  if (!brief) {
    warnings.push(`No channel brief found for ${channelId}.`);
    return undefined;
  }
  return {
    heading: "## Channel Brief",
    items: [{
      ref: { kind: "channel_brief", id: brief.id, label: brief.objective },
      renderMarkdown: () => [
        `Objective: ${brief.objective}`,
        `Scope: ${brief.scope}`,
        listBlock("Acceptance criteria", brief.acceptanceCriteria),
        listBlock("Open questions", brief.openQuestions),
        listBlock("Risks", brief.risks),
      ].filter(Boolean).join("\n"),
    }],
  };
}

function buildRecentRunsSection(
  store: RunStore,
  channelId: string | undefined,
  limit: number,
): AutomationContextSection | undefined {
  const runs = filterRunsForChannel(store.listRuns({ limit: Math.min(limit * 4, 100) }), channelId).slice(0, limit);
  if (runs.length === 0) {
    return undefined;
  }
  return {
    heading: "## Recent Runs",
    items: runs.map((run) => ({
      ref: { kind: "run", id: run.id, label: run.taskId },
      renderMarkdown: () => `- ${run.id}: ${run.status}; task=${run.taskId}; created=${run.createdAt}${run.errorMessage ? `; error=${run.errorMessage}` : ""}`,
    })),
  };
}

function buildPendingApprovalsSection(store: RunStore, limit: number): AutomationContextSection | undefined {
  const approvals = store.listApprovalRequests({ status: "pending", limit });
  if (approvals.length === 0) {
    return undefined;
  }
  return {
    heading: "## Pending Approvals",
    items: approvals.map((approval) => ({
      ref: { kind: "approval", id: approval.id, label: approval.title },
      renderMarkdown: () => `- ${approval.id}: ${approval.title}; risk=${approval.risk}; action=${approval.actionType}; created=${approval.createdAt}`,
    })),
  };
}

function buildRecentArtifactsSection(
  store: RunStore,
  channelId: string | undefined,
  limit: number,
): AutomationContextSection | undefined {
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
  return {
    heading: "## Recent Artifacts",
    items: selected.map((item) => ({
      ref: { kind: "artifact", id: item.artifact.id, label: item.artifact.title ?? item.artifact.path },
      renderMarkdown: () => `- ${item.artifact.id}: ${item.artifact.title ?? item.artifact.path}; type=${item.artifact.type}; run=${item.run.id}`,
    })),
  };
}

function buildStateTransitionsSection(store: RunStore, limit: number): AutomationContextSection | undefined {
  const transitions = store.listStateTransitionEvents({ limit });
  if (transitions.length === 0) {
    return undefined;
  }
  return {
    heading: "## Recent State Transitions",
    items: transitions.map((transition) => ({
      ref: { kind: "state_transition", id: transition.id, label: `${transition.entityType}:${transition.entityId}` },
      renderMarkdown: () => `- ${transition.id}: ${transition.entityType}:${transition.entityId} ${transition.fromStatus ?? "none"} -> ${transition.toStatus}; event=${transition.event}; actor=${transition.actor}`,
    })),
  };
}

function buildExternalWorkSection(
  store: RunStore,
  channelId: string | undefined,
  status: string | undefined,
  limit: number,
): AutomationContextSection | undefined {
  const records = store.listExternalWorkRecords({ channelId, limit });
  if (records.length === 0) {
    return undefined;
  }
  return {
    heading: "## External Work",
    introduction: status ? `Requested status filter "${status}" is not available in the P0 record summary.` : undefined,
    items: records.map((record) => ({
      ref: { kind: "external_work", id: record.id, label: record.identifier },
      renderMarkdown: () => `- ${record.id}: ${record.identifier}; source=${record.sourceKind}; item=${record.workItemKind}; updated=${record.updatedAt}`,
    })),
  };
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
