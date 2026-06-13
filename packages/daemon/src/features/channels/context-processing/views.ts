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
  readonly compactionIds?: readonly string[];
  readonly now?: string;
}

export function buildChannelContextView(input: BuildChannelContextViewInput): ChannelContextView {
  const keptSources: ChannelContextSource[] = [];
  const dropped: ChannelContextDroppedSource[] = [...(input.dropped ?? [])];
  for (const source of input.sources ?? []) {
    const reason = sourceDropReasonForView(source, input.kind, input.consumerTeammateId);
    if (reason) {
      dropped.push({ sourceId: source.id, reason });
      continue;
    }
    keptSources.push(source);
  }

  return {
    id: `${input.kind}:${input.channelId ?? input.workspaceId}`,
    kind: input.kind,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    consumerTeammateId: input.consumerTeammateId,
    sections: input.sections,
    sourceRefs: uniqueSourceRefs([
      ...input.sourceRefs,
      ...keptSources.flatMap((source) => source.sourceRefs),
    ]),
    sources: keptSources,
    dropped,
    budget: input.budget,
    metadata: {
      createdAt: input.now ?? new Date().toISOString(),
      compactionIds: input.compactionIds ?? [],
      sourceCount: keptSources.length,
    },
  };
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
