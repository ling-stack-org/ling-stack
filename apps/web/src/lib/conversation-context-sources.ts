import type { ChannelContextSummary, ChannelWorkflowStepContextPacket, WorkflowContextInspectSummary } from "../types.js";
import type { Translate } from "../i18n.js";

type WorkflowContextPackSnapshot = NonNullable<ChannelWorkflowStepContextPacket["contextPack"]>;

export interface ConversationContextSourceRefLike {
  readonly type: string;
  readonly id: string;
  readonly label?: string;
}

export interface ConversationContextSourceGroup {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly count: number;
  readonly examples: readonly string[];
  readonly refs: readonly ConversationContextSourceRefLike[];
}

export interface ConversationContextSourceSummary {
  readonly sourceCount: number;
  readonly groups: readonly ConversationContextSourceGroup[];
  readonly droppedCount: number;
  readonly compactionCount: number;
  readonly unavailableReason?: string;
}

export function buildConversationContextSourceSummaryFromInspect(
  inspect: WorkflowContextInspectSummary,
  t: Translate,
): ConversationContextSourceSummary {
  if (inspect.availability !== "available") {
    return {
      sourceCount: 0,
      groups: [],
      droppedCount: 0,
      compactionCount: 0,
      unavailableReason: contextInspectAvailabilityLabel(inspect.availability, t),
    };
  }
  return buildConversationContextSourceSummary({
    sourceRefs: inspect.sourceRefs,
    droppedCount: inspect.droppedSectionCount,
    compactionCount: inspect.compactionCount,
    t,
  });
}

export function buildConversationContextSourceSummaryFromPacket(
  packet: ChannelWorkflowStepContextPacket,
  t: Translate,
): ConversationContextSourceSummary {
  const pack = packet.contextPack;
  if (!pack) {
    return {
      sourceCount: 0,
      groups: [],
      droppedCount: 0,
      compactionCount: 0,
      unavailableReason: t("Context source details are not available."),
    };
  }
  return buildConversationContextSourceSummaryFromPack(pack, t);
}

export function buildConversationContextSourceSummaryFromChannelSummary(
  summary: ChannelContextSummary,
  t: Translate,
): ConversationContextSourceSummary {
  const sourceRefs: ConversationContextSourceRefLike[] = [
    ...summary.sourceMessageIds.map((id) => ({ type: "message", id })),
    ...summary.decisionIds.map((id) => ({ type: "decision", id })),
  ];
  if (sourceRefs.length === 0) {
    sourceRefs.push({ type: "context_summary", id: summary.id, label: t("Context summary") });
  }
  return buildConversationContextSourceSummary({
    sourceRefs,
    droppedCount: 0,
    compactionCount: 0,
    t,
  });
}

export function buildConversationContextSourceSummaryFromPack(
  pack: WorkflowContextPackSnapshot,
  t: Translate,
): ConversationContextSourceSummary {
  return buildConversationContextSourceSummary({
    sourceRefs: pack.sourceRefs,
    droppedCount: pack.droppedSectionIds.length,
    compactionCount: pack.compactionIds.length,
    t,
  });
}

export function conversationContextSourceSummaryLabel(
  summary: ConversationContextSourceSummary,
  t: Translate,
): string {
  if (summary.unavailableReason) {
    return summary.unavailableReason;
  }
  if (summary.sourceCount === 0) {
    return t("No user-facing sources were recorded.");
  }
  return t("{count} sources", { count: summary.sourceCount });
}

function buildConversationContextSourceSummary(input: {
  readonly sourceRefs: readonly ConversationContextSourceRefLike[];
  readonly droppedCount: number;
  readonly compactionCount: number;
  readonly t: Translate;
}): ConversationContextSourceSummary {
  const grouped = new Map<string, {
    readonly type: string;
    readonly label: string;
    readonly examples: string[];
    readonly refs: ConversationContextSourceRefLike[];
    count: number;
  }>();

  for (const ref of input.sourceRefs) {
    if (isInternalContextSourceRef(ref)) {
      continue;
    }
    const type = sanitizeContextSourceType(ref.type);
    const label = contextSourceTypeLabel(type, input.t);
    const key = `${type}:${label}`;
    const existing = grouped.get(key) ?? { type, label, examples: [], refs: [], count: 0 };
    const example = userFacingSourceExample(ref);
    if (example && !existing.examples.includes(example) && existing.examples.length < 3) {
      existing.examples.push(example);
    }
    existing.refs.push({ ...ref, type });
    existing.count += 1;
    grouped.set(key, existing);
  }

  const groups = [...grouped.entries()]
    .sort((left, right) => right[1].count - left[1].count || left[1].label.localeCompare(right[1].label))
    .map(([id, group]) => ({
      id,
      type: group.type,
      label: group.label,
      count: group.count,
      examples: group.examples,
      refs: group.refs,
    }));

  return {
    sourceCount: groups.reduce((sum, group) => sum + group.count, 0),
    groups,
    droppedCount: input.droppedCount,
    compactionCount: input.compactionCount,
  };
}

function contextInspectAvailabilityLabel(
  availability: WorkflowContextInspectSummary["availability"],
  t: Translate,
): string {
  if (availability === "missing_context_artifact") {
    return t("Context source details were not persisted.");
  }
  if (availability === "unreadable_context_packet") {
    return t("Context source details could not be read.");
  }
  if (availability === "missing_context_pack") {
    return t("Context source details are not available.");
  }
  return t("Context source details are not available.");
}

function sanitizeContextSourceType(type: string): string {
  const value = type.trim().toLowerCase();
  return value || "source";
}

function contextSourceTypeLabel(type: string, t: Translate): string {
  if (type === "message" || type === "channel_message" || type === "private_message") {
    return t("Messages");
  }
  if (type === "decision" || type === "channel_decision") {
    return t("Decisions");
  }
  if (type === "context_summary" || type === "summary") {
    return t("Context summaries");
  }
  if (type === "file" || type === "workspace_file" || type === "attachment") {
    return t("Files");
  }
  if (type === "artifact" || type === "run_artifact") {
    return t("Artifacts");
  }
  if (type === "memory" || type === "project_memory") {
    return t("Memory");
  }
  if (type === "web" || type === "url" || type === "page") {
    return t("Web pages");
  }
  if (type === "task" || type === "channel_task") {
    return t("Tasks");
  }
  if (type === "run" || type === "run_session") {
    return t("Runs");
  }
  if (type === "teammate" || type === "agent") {
    return t("Teammates");
  }
  if (type === "channel") {
    return t("Channel");
  }
  return t("Sources");
}

function userFacingSourceExample(ref: ConversationContextSourceRefLike): string | undefined {
  const label = ref.label?.trim();
  if (label && !isInternalContextText(label)) {
    return label;
  }
  return undefined;
}

function isInternalContextSourceRef(ref: ConversationContextSourceRefLike): boolean {
  return isInternalContextText([ref.type, ref.id, ref.label ?? ""].join(" "));
}

function isInternalContextText(value: string): boolean {
  return /\bchannel_collaboration_protocol\b/iu.test(value) ||
    /\bcontext[_\s-]?pack\b/iu.test(value) ||
    /\bworkflow[_\s-]?runtime[_\s-]?boundary\b/iu.test(value) ||
    /\bprovider_[a-z0-9_-]+\b/iu.test(value) ||
    /\bmodel_known\b/iu.test(value) ||
    /\btoken\s*budget\b/iu.test(value) ||
    /\braw\s+(?:prompt|logs?|events?)\b/iu.test(value);
}
