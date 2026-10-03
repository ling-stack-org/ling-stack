import type {
  ConversationTimelineItem,
  ConversationTimelineMessageItem,
  ConversationTimelineTerminalReportItem,
} from "@ling-stack/conversation-ui-core";

export interface ConversationTimelineResponse {
  readonly id: string;
  readonly items: readonly ConversationTimelineItem[];
  readonly messages: readonly ConversationTimelineMessageItem[];
  readonly message?: ConversationTimelineMessageItem;
  readonly report?: ConversationTimelineTerminalReportItem;
  readonly copyText: string;
  readonly logicalMessageCount: number;
  readonly settled: boolean;
}

export interface ConversationTimelineMessagePresentation {
  readonly ownsIdentity: boolean;
}

/** Commentary alone must not suppress the only available final-result fallback. */
export function hasFinalTimelineResponseNarration(response: ConversationTimelineResponse): boolean {
  return response.messages.some((message) => message.phase !== "commentary" &&
    Boolean(message.markdown.trim()) && terminalStatuses.has(message.status ?? ""));
}

export interface TimelineResponsePresentation {
  readonly identityOwnerIds: ReadonlySet<string>;
  readonly responseByItemId: ReadonlyMap<string, ConversationTimelineResponse>;
  readonly footerByItemId: ReadonlyMap<string, ConversationTimelineResponse>;
}

/** Display placement only; canonical sequence and evidence identity stay intact. */
export function placeTimelineResponseReports(items: readonly ConversationTimelineItem[]): readonly ConversationTimelineItem[] {
  const scoped = items.map((item) => {
    if (item.kind !== "subAgentActivity") return item;
    const childItems = placeTimelineResponseReports(item.childItems);
    return childItems === item.childItems ? item : { ...item, childItems };
  });
  const presentation = projectTimelineResponsePresentation(scoped);
  const tailByResponse = new Map<string, ConversationTimelineItem>();
  for (const item of scoped) {
    if (item.kind === "terminalReport") continue;
    const response = presentation.responseByItemId.get(item.id);
    if (response?.settled) tailByResponse.set(response.id, item);
  }
  const reportsAfter = new Map<string, ConversationTimelineTerminalReportItem[]>();
  const relocatedIds = new Set<string>();
  for (const item of scoped) {
    if (item.kind !== "terminalReport") continue;
    const response = presentation.responseByItemId.get(item.id);
    if (!response?.settled || response.report?.id !== item.id) continue;
    const tail = tailByResponse.get(response.id);
    // A paged transcript may contain only the result. Do not move it into
    // another visible Turn, guess a missing anchor, or alter persisted facts.
    if (!tail) continue;
    relocatedIds.add(item.id);
    reportsAfter.set(tail.id, [...(reportsAfter.get(tail.id) ?? []), item]);
  }
  const placed = scoped.flatMap((item) => relocatedIds.has(item.id) ? [] : [item, ...(reportsAfter.get(item.id) ?? [])]);
  return placed.every((item, index) => item === items[index]) ? items : placed;
}

/**
 * Place settled response chrome after its last disclosed row, not after its
 * last narration segment. Rows are the complete display model, never the
 * viewport's virtual subset. Batch expansion changes placement, not ownership
 * or completion; collapsed child responses have no visible footer.
 */
export function projectTimelineResponseFooterRows(
  presentation: TimelineResponsePresentation,
  rows: readonly { readonly item: ConversationTimelineItem }[],
): ReadonlyMap<string, ConversationTimelineResponse> {
  const settledResponses = new Set([...presentation.footerByItemId.values()].map((response) => response.id));
  const lastRowByResponse = new Map<string, { readonly itemId: string; readonly response: ConversationTimelineResponse }>();
  for (const row of rows) {
    const response = presentation.responseByItemId.get(row.item.id);
    if (!response || !settledResponses.has(response.id)) continue;
    // A superseded report cannot displace the effective report's final chrome.
    if (row.item.kind === "terminalReport" && response.report?.id !== row.item.id) continue;
    lastRowByResponse.set(response.id, { itemId: row.item.id, response });
  }
  return new Map([...lastRowByResponse.values()].map(({ itemId, response }) => [itemId, response]));
}

const terminalStatuses = new Set(["succeeded", "partially_succeeded", "failed", "cancelled", "blocked"]);
const liveStatuses = new Set(["pending", "running", "waiting"]);

/**
 * Assign display chrome on an already scoped, effective-attempt transcript.
 * Never mutate/sort canonical facts or turn model prose into completion evidence.
 * Each child is projected independently, including while its rows are collapsed.
 */
export function projectTimelineResponsePresentation(items: readonly ConversationTimelineItem[]): TimelineResponsePresentation {
  const identityOwnerIds = new Set<string>();
  const responseByItemId = new Map<string, ConversationTimelineResponse>();
  const footerByItemId = new Map<string, ConversationTimelineResponse>();

  function projectScope(scopedItems: readonly ConversationTimelineItem[], scope: string): void {
    const turnByRun = new Map<string, string>();
    for (const item of scopedItems) {
      if (item.runId && item.turnId) turnByRun.set(item.runId, item.turnId);
    }
    const groups = new Map<string, ConversationTimelineItem[]>();
    for (const item of scopedItems) {
      if (item.kind === "userMessage") continue;
      const turnId = item.turnId ?? (item.runId ? turnByRun.get(item.runId) : undefined);
      const key = JSON.stringify([scope, turnId ? ["turn", turnId]
        : item.runId ? ["run", item.runId]
          : ["message", item.kind === "agentMessage" ? item.logicalMessageId ?? item.itemId ?? item.id : item.id]]);
      const group = groups.get(key) ?? [];
      group.push(item);
      groups.set(key, group);
    }
    for (const [id, group] of groups) {
      const messages = group.filter((item): item is ConversationTimelineMessageItem => item.kind === "agentMessage");
      const message = messages.at(-1);
      const reports = group.filter((item): item is ConversationTimelineTerminalReportItem => item.kind === "terminalReport");
      const report = reports.reduce<ConversationTimelineTerminalReportItem | undefined>((latest, item) =>
        !latest || item.generation > latest.generation || item.generation === latest.generation && item.revision > latest.revision ? item : latest, undefined);
      if (!message && !report) continue;
      const firstBySpeaker = new Set<string>();
      for (const item of messages) {
        // An unattributed message is not evidence that it came from the sole
        // known teammate. Only continue its own durable logical message.
        const speaker = item.participantId ?? `unattributed:${item.logicalMessageId ?? item.itemId ?? item.id}`;
        if (!firstBySpeaker.has(speaker)) {
          identityOwnerIds.add(item.id);
          firstBySpeaker.add(speaker);
        }
      }
      const hasLiveItems = group.some((item) => liveStatuses.has(item.status ?? "") ||
        item.kind === "subAgentActivity" && ["started", "running", "waiting"].includes(item.lifecycle));
      const settled = !hasLiveItems && (report ? terminalStatuses.has(report.status ?? "")
        : Boolean(message && message.phase !== "commentary" && terminalStatuses.has(message.status ?? "")));
      const response: ConversationTimelineResponse = {
        id, items: group, messages, message, report, settled,
        copyText: messages.map((item) => item.markdown).filter((body) => body.trim()).join("\n\n"),
        logicalMessageCount: new Set(messages.map((item) => item.logicalMessageId ?? item.itemId ?? item.id)).size,
      };
      for (const item of group) {
        responseByItemId.set(item.id, response);
        // Expanded batch facts are flat rows under the same root virtualizer.
        // They keep their own item ids but share their response hover scope.
        if (item.kind === "commandBatch") {
          for (const command of item.batch.commands) responseByItemId.set(command.id, response);
        } else if (item.kind === "explorationBatch") {
          for (const child of item.batch.children) responseByItemId.set(child.id, response);
        }
      }
      const footerOwner = report ?? message;
      if (settled && footerOwner) footerByItemId.set(footerOwner.id, response);
    }
    for (const item of scopedItems) {
      if (item.kind === "subAgentActivity") projectScope(item.childItems, `${scope}/child:${item.id}`);
    }
  }

  projectScope(items, "root");
  return { identityOwnerIds, responseByItemId, footerByItemId };
}
