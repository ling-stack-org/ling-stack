import type { RunEventEnvelope, RunSession, RunStore } from "./run-types.js";

export interface UnsettledNormalTool {
  readonly runId: string;
  readonly toolCallId: string;
  readonly startEventId: string;
  readonly terminalEventId?: string;
}

/** Read all durable lifecycle facts. A Run failure fence is not a tool receipt. */
export function readNormalTerminalToolBarrier(
  store: Pick<RunStore, "listEvents">,
  run: RunSession,
): { readonly events: readonly RunEventEnvelope[]; readonly unsettledTools: readonly UnsettledNormalTool[]; readonly malformed: boolean } {
  const events: RunEventEnvelope[] = [];
  let afterSeq = 0;
  while (true) {
    const page = store.listEvents(run.id, { afterSeq, limit: 1000 });
    if (!page.length) break;
    const next = page.at(-1)!.seq;
    if (next <= afterSeq) throw new Error(`Normal report event cursor did not advance: ${run.id}`);
    events.push(...page);
    afterSeq = next;
    if (page.length < 1000) break;
  }
  const ordered = [...events].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  const terminalType = run.status === "failed" ? "run_error" : run.status === "cancelled" ? "run_cancelled" : undefined;
  const starts = new Map<string, RunEventEnvelope>();
  const ended = new Set<string>();
  let malformed = false;
  for (const event of ordered) {
    if (event.type !== "tool_start" && event.type !== "tool_end") continue;
    const toolCallId = typeof event.data.toolCallId === "string" && event.data.toolCallId.trim() ? event.data.toolCallId : undefined;
    if (event.runId !== run.id || !toolCallId) { malformed = true; continue; }
    if (event.type === "tool_start") {
      if (!starts.has(toolCallId)) starts.set(toolCallId, event);
    } else {
      const start = starts.get(toolCallId);
      const fence = terminalType && start ? ordered.find(candidate => candidate.runId === run.id && candidate.type === terminalType && candidate.seq > start.seq) : undefined;
      if (start && (!fence || event.seq < fence.seq)) ended.add(toolCallId);
    }
  }
  const unsettledTools = [...starts].filter(([id]) => !ended.has(id)).map(([toolCallId, start]) => {
    const fence = terminalType ? ordered.find(event => event.runId === run.id && event.type === terminalType && event.seq > start.seq) : undefined;
    return { runId: run.id, toolCallId, startEventId: start.id, ...(fence ? { terminalEventId: fence.id } : {}) };
  }).sort((a, b) => a.toolCallId.localeCompare(b.toolCallId));
  return { events, unsettledTools, malformed };
}

export function unconfirmedToolRiskId(tool: Pick<UnsettledNormalTool, "runId" | "toolCallId">): string {
  return `execution-unconfirmed:${tool.runId}:${tool.toolCallId}`;
}
