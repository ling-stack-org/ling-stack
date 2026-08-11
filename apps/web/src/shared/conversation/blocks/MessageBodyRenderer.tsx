import {
  MessageBodyRenderer as SharedMessageBodyRenderer,
  type MessageBodyRendererProps as SharedMessageBodyRendererProps,
} from "@ling-stack/conversation-ui-react";
import type { LocalFileReference } from "../tokens/message-body.js";
import { CodeBlock } from "./CodeBlock.js";
import { DiffCodeBlock } from "./DiffCodeBlock.js";
import { LocalFileLink } from "./LocalFileLink.js";
import { notifyConversationDeferredContentReady } from "./deferred-rendering.js";

export interface MessageBodyRendererProps {
  readonly text: string;
  readonly cwd?: string;
  readonly compact?: boolean;
  readonly allowMarkdown?: boolean;
  readonly streaming?: boolean;
  readonly className?: string;
  readonly onOpenLocalFile?: (reference: LocalFileReference) => void;
}

export function MessageBodyRenderer({
  onOpenLocalFile,
  ...props
}: MessageBodyRendererProps): React.JSX.Element {
  const sharedProps: SharedMessageBodyRendererProps = {
    ...props,
    onOpenLocalFile,
    onDeferredContentReady: notifyConversationDeferredContentReady,
    renderCodeBlock: ({ code, language, highlight }) => (
      <CodeBlock code={code} language={language} highlight={highlight} />
    ),
    renderDiffBlock: ({ diff, language, highlight }) => (
      <DiffCodeBlock diff={diff} language={language} highlight={highlight} />
    ),
    renderLocalFile: ({ reference, onOpen }) => (
      <LocalFileLink reference={reference} onOpen={onOpen} />
    ),
  };

  return <SharedMessageBodyRenderer {...sharedProps} />;
}
