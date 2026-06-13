import { redactEvidenceText } from "./evidence.js";
import type {
  ChannelContextDroppedSource,
  ChannelContextSource,
  ChannelContextSourceKind,
} from "./types.js";

export interface CondenseChannelContextSourcesInput {
  readonly sources: readonly ChannelContextSource[];
  readonly inputBudgetTokens?: number;
  readonly maxSourceTextChars?: number;
  readonly maxSources?: number;
}

export interface CondenseChannelContextSourcesResult {
  readonly sources: readonly ChannelContextSource[];
  readonly dropped: readonly ChannelContextDroppedSource[];
  readonly compactionIds: readonly string[];
  readonly condensedSourceIds: readonly string[];
}

const PROTECTED_SOURCE_KINDS = new Set<ChannelContextSourceKind>([
  "turn",
  "channel_state",
  "active_work",
  "workflow",
  "workflow_step",
]);

const DEFAULT_MAX_SOURCE_TEXT_CHARS = 2_400;
const MIN_SOURCE_TEXT_CHARS = 600;
const DEFAULT_MAX_SOURCES = 24;

export function condenseChannelContextSources(
  input: CondenseChannelContextSourcesInput,
): CondenseChannelContextSourcesResult {
  const maxSourceTextChars = normalizeMaxSourceTextChars(input);
  const maxSources = normalizeMaxSources(input.maxSources);
  const compactionIds: string[] = [];
  const condensedSourceIds: string[] = [];
  const dropped: ChannelContextDroppedSource[] = [];

  const condensed = input.sources.map((source) => {
    if (maxSourceTextChars === undefined || !shouldCondenseSourceText(source, maxSourceTextChars)) {
      return source;
    }
    const text = renderCondensedSourceText(source, maxSourceTextChars);
    compactionIds.push(stableCondenserId("text", source.id, `${source.text?.length ?? 0}:${maxSourceTextChars}`));
    condensedSourceIds.push(source.id);
    return {
      ...source,
      text,
      metadata: {
        ...source.metadata,
        condensed: true,
        originalTextChars: source.text?.length ?? 0,
        condensedTextChars: text.length,
      },
    };
  });

  const dropIds = selectDroppedSourceIds(condensed, maxSources);
  if (dropIds.size === 0) {
    return { sources: condensed, dropped, compactionIds: uniqueStrings(compactionIds), condensedSourceIds };
  }

  const kept: ChannelContextSource[] = [];
  for (const source of condensed) {
    if (!dropIds.has(source.id)) {
      kept.push(source);
      continue;
    }
    dropped.push({ sourceId: source.id, reason: "budget" });
    compactionIds.push(stableCondenserId("drop", source.id, `${maxSources ?? "unbounded"}`));
  }
  return {
    sources: kept,
    dropped,
    compactionIds: uniqueStrings(compactionIds),
    condensedSourceIds,
  };
}

function normalizeMaxSourceTextChars(input: CondenseChannelContextSourcesInput): number | undefined {
  if (input.maxSourceTextChars !== undefined) {
    return Math.max(MIN_SOURCE_TEXT_CHARS, Math.floor(input.maxSourceTextChars));
  }
  if (input.inputBudgetTokens !== undefined) {
    return Math.max(MIN_SOURCE_TEXT_CHARS, Math.min(DEFAULT_MAX_SOURCE_TEXT_CHARS, Math.floor(input.inputBudgetTokens * 1.4)));
  }
  return undefined;
}

function normalizeMaxSources(maxSources: number | undefined): number | undefined {
  if (maxSources === undefined) {
    return undefined;
  }
  return Math.max(0, Math.floor(maxSources));
}

function shouldCondenseSourceText(source: ChannelContextSource, maxSourceTextChars: number | undefined): boolean {
  if (maxSourceTextChars === undefined || isProtectedSource(source)) {
    return false;
  }
  return (source.text?.length ?? 0) > maxSourceTextChars;
}

function renderCondensedSourceText(source: ChannelContextSource, maxSourceTextChars: number): string {
  const sourceRefs = source.sourceRefs
    .slice(0, 8)
    .map((ref) => `${ref.type}:${ref.id}`)
    .join(", ");
  const redacted = redactEvidenceText(source.text ?? "").trim();
  const targetBodyChars = Math.max(160, maxSourceTextChars - 220);
  const headChars = Math.ceil(targetBodyChars * 0.58);
  const tailChars = Math.max(120, targetBodyChars - headChars);
  const head = redacted.slice(0, headChars).trim();
  const tail = redacted.slice(Math.max(0, redacted.length - tailChars)).trim();
  return [
    "Context source condensed for prompt budget.",
    `sourceId=${source.id}`,
    `kind=${source.kind}`,
    `freshness=${source.freshness}`,
    sourceRefs ? `sourceRefs=${sourceRefs}` : undefined,
    `originalTextChars=${source.text?.length ?? 0}`,
    "boundedPreview:",
    head,
    tail && tail !== head ? "[middle omitted]" : undefined,
    tail && tail !== head ? tail : undefined,
  ].filter((line): line is string => line !== undefined && line.length > 0).join("\n");
}

function selectDroppedSourceIds(
  sources: readonly ChannelContextSource[],
  configuredMaxSources: number | undefined,
): ReadonlySet<string> {
  const maxSources = configuredMaxSources ?? DEFAULT_MAX_SOURCES;
  if (sources.length <= maxSources) {
    return new Set();
  }
  const droppable = sources
    .map((source, index) => ({ source, index, priority: dropPriority(source) }))
    .filter((candidate) => Number.isFinite(candidate.priority))
    .sort((left, right) => left.priority - right.priority || left.index - right.index);
  const dropCount = Math.min(sources.length - maxSources, droppable.length);
  return new Set(droppable.slice(0, dropCount).map((candidate) => candidate.source.id));
}

function dropPriority(source: ChannelContextSource): number {
  if (isProtectedSource(source)) {
    return Number.POSITIVE_INFINITY;
  }
  const freshnessScore = source.freshness === "archival"
    ? 0
    : source.freshness === "durable"
      ? 1
      : source.freshness === "recent"
        ? 2
        : 8;
  const kindScore = source.kind === "evidence" || source.kind === "artifact" || source.kind === "workflow_packet"
    ? 0
    : source.kind === "recent_message" || source.kind === "channel_summary"
      ? 1
      : source.kind === "memory" || source.kind === "materialized_input"
        ? 3
        : 4;
  return freshnessScore * 10 + kindScore;
}

function isProtectedSource(source: ChannelContextSource): boolean {
  return PROTECTED_SOURCE_KINDS.has(source.kind) || source.freshness === "current_turn";
}

function stableCondenserId(kind: "text" | "drop", sourceId: string, seed: string): string {
  let hash = 0;
  for (const character of `${kind}:${sourceId}:${seed}`) {
    hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  }
  return `context_condenser_${kind}_${Math.abs(hash).toString(36)}`;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
