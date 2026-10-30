import type { ChannelWorkflow, LingThread, RunStore } from "@ling-stack/core";

/** Durable conversation ownership, independent of the selected message page. */
export function channelConversationRuntimeMetricsScope(store: RunStore, selected: LingThread): {
  readonly threads: readonly LingThread[];
  readonly enumerationMayBeTruncated: boolean;
} {
  if (selected.kind !== "channel_discussion" || !selected.channelId) {
    return { threads: [], enumerationMayBeTruncated: false };
  }
  const channelId = selected.channelId;
  const enumerated = store.listLingThreads({ kind: "channel_discussion", channelId: selected.channelId,
    includeArchived: true, limit: 500 });
  let enumerationMayBeTruncated = enumerated.length === 500;
  const candidates = new Map(enumerated.map(thread => [thread.id, thread]));
  // The selected conversation can be older than the bounded enumeration.
  candidates.set(selected.id, selected);
  const owners = new Map<string, string | undefined>();
  const visiting = new Set<string>();
  let taskWorkflows: Map<string, ChannelWorkflow[]> | undefined;
  let taskEnumerationComplete = true;
  const sameScope = (entity: { readonly workspaceId: string; readonly channelId?: string }): boolean =>
    entity.workspaceId === selected.workspaceId && entity.channelId === selected.channelId;

  function workflowsForTask(taskId: string): readonly ChannelWorkflow[] | undefined {
    if (!taskWorkflows) {
      taskWorkflows = new Map();
      const workflows = store.listChannelWorkflows({ channelId, limit: 500 });
      taskEnumerationComplete = workflows.length < 500;
      enumerationMayBeTruncated ||= !taskEnumerationComplete;
      for (const workflow of workflows) {
        if (!sameScope(workflow)) continue;
        for (const step of store.listChannelWorkflowSteps({ workflowId: workflow.id, complete: true })) {
          if (!sameScope(step) || step.workflowId !== workflow.id || !step.taskId) continue;
          const matches = taskWorkflows.get(step.taskId) ?? [];
          matches.push(workflow);
          taskWorkflows.set(step.taskId, matches);
        }
      }
    }
    // A missing older Step could change an apparently unowned legacy Thread.
    return taskEnumerationComplete ? taskWorkflows.get(taskId) ?? [] : undefined;
  }

  function workflowOwner(workflow: ChannelWorkflow): string | undefined {
    if (!sameScope(workflow)) return undefined;
    const turnId = workflow.metadata?.sourceTurnId;
    const itemId = workflow.metadata?.sourceMessageId;
    if ((turnId !== undefined && (typeof turnId !== "string" || !turnId))
      || (itemId !== undefined && (typeof itemId !== "string" || !itemId))) return undefined;
    if (!turnId && !itemId) return undefined;
    const turn = turnId ? store.getLingTurn(turnId) : undefined;
    const item = itemId ? store.getConversationItem(itemId) : undefined;
    if ((turnId && (!turn || !sameScope(turn))) || (itemId && (!item || !sameScope(item)))
      || (turn && item && (turn.threadId !== item.threadId || (item.turnId && item.turnId !== turn.id)))) return undefined;
    const sourceId = turn?.threadId ?? item?.threadId;
    return sourceId ? owner(store.getLingThread(sourceId)) : undefined;
  }

  function resolveOwner(thread: LingThread): string | undefined {
    // A true fork is an independent boundary even though it has a parent.
    if (thread.surfaceKind === "channel_session" || thread.surfaceKind === "branch") return `session:${thread.id}`;
    if (thread.surfaceKind === "channel_root") return "legacy-channel";
    if (thread.surfaceKind !== "topic" && thread.surfaceKind !== "work") return undefined;
    const sources: (string | undefined)[] = [];
    if (thread.surfaceKind === "topic") {
      if (!thread.parentThreadId) return undefined;
      sources.push(owner(store.getLingThread(thread.parentThreadId)));
    } else if (thread.parentThreadId || thread.parentTurnId || thread.forkedFromRunId) {
      return undefined;
    }
    const workflows = new Map<string, ChannelWorkflow>();
    if (thread.workflowId) {
      const workflow = store.getChannelWorkflow(thread.workflowId);
      if (!workflow || !sameScope(workflow)) return undefined;
      workflows.set(workflow.id, workflow);
    }
    if (thread.workflowStepId) {
      const step = store.getChannelWorkflowStep(thread.workflowStepId);
      if (!step || !sameScope(step) || (thread.workflowId && step.workflowId !== thread.workflowId)
        || (thread.taskId && step.taskId && step.taskId !== thread.taskId)) return undefined;
      const workflow = store.getChannelWorkflow(step.workflowId);
      if (!workflow || !sameScope(workflow)) return undefined;
      workflows.set(workflow.id, workflow);
    }
    if (thread.taskId) {
      const matches = workflowsForTask(thread.taskId);
      if (!matches) return undefined;
      for (const workflow of matches) workflows.set(workflow.id, workflow);
    }
    for (const workflow of workflows.values()) sources.push(workflowOwner(workflow));
    if (!sources.length) return "legacy-channel";
    const first = sources[0];
    return first && sources.every(source => source === first) ? first : undefined;
  }

  function owner(thread: LingThread | undefined): string | undefined {
    if (!thread || thread.kind !== "channel_discussion" || !sameScope(thread) || visiting.has(thread.id)) return undefined;
    if (owners.has(thread.id)) return owners.get(thread.id);
    visiting.add(thread.id);
    const result = resolveOwner(thread);
    visiting.delete(thread.id);
    owners.set(thread.id, result);
    return result;
  }

  const selectedOwner = owner(selected);
  const threads = selectedOwner ? [...candidates.values()].filter(thread => owner(thread) === selectedOwner) : [];
  return { threads, enumerationMayBeTruncated };
}
