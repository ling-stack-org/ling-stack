import type { ReactNode } from "react";
import type { ConversationTurn, TranscriptBlockBase } from "./types.js";

export interface TranscriptBlockRendererProps<
  TTurn extends ConversationTurn,
  TBlock extends TranscriptBlockBase,
  TContext,
> {
  readonly turn: TTurn;
  readonly block: TBlock;
  readonly context: TContext;
}

export type TranscriptBlockRenderer<
  TTurn extends ConversationTurn,
  TBlock extends TranscriptBlockBase,
  TContext,
> = (props: TranscriptBlockRendererProps<TTurn, TBlock, TContext>) => ReactNode;

export type TranscriptBlockRendererRegistry<
  TTurn extends ConversationTurn,
  TBlock extends TranscriptBlockBase,
  TContext,
> = {
  readonly [Kind in TBlock["kind"]]: TranscriptBlockRenderer<
    TTurn,
    Extract<TBlock, { readonly kind: Kind }>,
    TContext
  >;
};

export function createTranscriptBlockRendererRegistry<
  TTurn extends ConversationTurn,
  TBlock extends TranscriptBlockBase,
  TContext,
>(
  registry: TranscriptBlockRendererRegistry<TTurn, TBlock, TContext>,
): TranscriptBlockRendererRegistry<TTurn, TBlock, TContext> {
  return registry;
}

export function renderTranscriptBlockFromRegistry<
  TTurn extends ConversationTurn,
  TBlock extends TranscriptBlockBase,
  TContext,
>(
  registry: TranscriptBlockRendererRegistry<TTurn, TBlock, TContext>,
  props: TranscriptBlockRendererProps<TTurn, TBlock, TContext>,
): ReactNode {
  const renderer = registry[props.block.kind as TBlock["kind"]] as TranscriptBlockRenderer<TTurn, TBlock, TContext>;
  return renderer(props);
}
