import { randomUUID } from "node:crypto";
import { condenseChannelContextSections, condenseChannelContextSources } from "./condenser.js";
import { sourceDropReasonForView } from "./policies.js";
import type {
  ChannelContextBudgetSnapshot,
  ChannelContextDroppedSource,
  ChannelContextSection,
  ChannelContextSource,
  ChannelContextSourceRef,
  ChannelContextView,
  ChannelContextViewKind,
} from "./types.js";
import type { ConversationContextProjectionMetadata } from "@ling-stack/contracts";

export interface BuildChannelContextCondenserInput {
  readonly enabled?: boolean;
  readonly maxSourceTextChars?: number;
  readonly maxSources?: number;
}

export interface BuildChannelContextViewInput {
  readonly kind: ChannelContextViewKind;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly consumerTeammateId?: string;
  readonly sections: readonly ChannelContextSection[];
  readonly sourceRefs: readonly ChannelContextSourceRef[];
  readonly sources?: readonly ChannelContextSource[];
  readonly dropped?: readonly ChannelContextDroppedSource[];
  readonly budget?: ChannelContextBudgetSnapshot;
  readonly contextProjection?: ConversationContextProjectionMetadata;
  readonly condenser?: BuildChannelContextCondenserInput;
  readonly compactionIds?: readonly string[];
  readonly now?: string;
}

export function buildChannelContextView(input: BuildChannelContextViewInput): ChannelContextView {
  const createdAt = input.now ?? new Date().toISOString();
  const id = createChannelContextViewId();
  const keptSources: ChannelContextSource[] = [];
  const dropped: ChannelContextDroppedSource[] = [...(input.dropped ?? [])];
  for (const source of input.sources ?? []) {
    const reason = sourceDropReasonForView(source, input.kind, input.consumerTeammateId, input);
    if (reason) {
      dropped.push({ sourceId: source.id, reason });
      continue;
    }
    keptSources.push(source);
  }

  const condenserResult = input.condenser?.enabled
    ? condenseChannelContextSources({
        sources: keptSources,
        inputBudgetTokens: input.budget?.inputBudgetTokens,
        maxSourceTextChars: input.condenser.maxSourceTextChars,
        maxSources: input.condenser.maxSources,
      })
    : undefined;
  const viewSources = condenserResult?.sources ?? keptSources;
  if (condenserResult) {
    dropped.push(...condenserResult.dropped);
  }

  const sectionCondenserResult = input.condenser?.enabled
    ? condenseChannelContextSections({
        sections: input.sections,
        maxSectionTextChars: input.condenser.maxSourceTextChars,
      })
    : undefined;
  const viewSections = sectionCondenserResult?.sections ?? input.sections;
  const viewContextProjection = input.contextProjection
    ? {
        ...input.contextProjection,
        contextViewId: id,
        contextViewCreatedAt: createdAt,
      }
    : undefined;

  return {
    id,
    kind: input.kind,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    consumerTeammateId: input.consumerTeammateId,
    sections: viewSections,
    sourceRefs: uniqueSourceRefs([
      ...input.sourceRefs,
      ...viewSources.flatMap((source) => source.sourceRefs),
    ]),
    sources: viewSources,
    dropped,
    budget: input.budget,
    contextProjection: viewContextProjection,
    metadata: {
      createdAt,
      compactionIds: uniqueStrings([
        ...(input.compactionIds ?? []),
        ...(condenserResult?.compactionIds ?? []),
        ...(sectionCondenserResult?.compactionIds ?? []),
      ]),
      sourceCount: viewSources.length,
      condenser: condenserResult ? {
        enabled: true,
        maxSourceTextChars: input.condenser?.maxSourceTextChars,
        maxSources: input.condenser?.maxSources,
        condensedSourceCount: condenserResult.condensedSourceIds.length,
        droppedSourceCount: condenserResult.dropped.length,
        condensedSectionCount: sectionCondenserResult?.condensedSectionIds.length ?? 0,
        discardedSectionCount: sectionCondenserResult?.discardedSectionIds.length ?? 0,
      } : undefined,
    },
  };
}

export function createChannelContextViewId(): string {
  return `context_view_${randomUUID()}`;
}

function uniqueSourceRefs(refs: readonly ChannelContextSourceRef[]): readonly ChannelContextSourceRef[] {
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

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
