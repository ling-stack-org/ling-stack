import {
  MessageBodyRenderer as SharedMessageBodyRenderer,
  type MessageLocalFileRenderInput,
  type MessageBodyRendererProps as SharedMessageBodyRendererProps,
} from "@ling-stack/conversation-ui-react";
import type { ReactNode } from "react";
import type { LocalFileReference } from "../tokens/message-body.js";
import { CodeBlock } from "./CodeBlock.js";
import { DiffCodeBlock } from "./DiffCodeBlock.js";
import { LocalFileLink } from "./LocalFileLink.js";
import { notifyConversationDeferredContentReady } from "./deferred-rendering.js";
import { useI18n } from "../../../i18n.js";

export interface MessageBodyRendererProps {
  readonly text: string;
  readonly cwd?: string;
  readonly compact?: boolean;
  readonly allowMarkdown?: boolean;
  readonly streaming?: boolean;
  readonly className?: string;
  readonly renderLocalFile?: (input: MessageLocalFileRenderInput) => ReactNode;
  readonly onOpenLocalFile?: (reference: LocalFileReference) => void;
}

export function MessageBodyRenderer({
  onOpenLocalFile,
  renderLocalFile,
  ...props
}: MessageBodyRendererProps): React.JSX.Element {
  const { t } = useI18n();
  const sharedProps: SharedMessageBodyRendererProps = {
    ...props,
    onOpenLocalFile,
    onDeferredContentReady: notifyConversationDeferredContentReady,
    mermaidLabels: {
      expand: t("Expand details"), copy: t("Copy code"), copied: t("Copied"), unavailable: t("Preview unavailable"),
      title: t("Preview"), close: t("Close preview"),
    },
    renderCodeBlock: ({ code, language, highlight }) => (
      <CodeBlock code={code} language={language} highlight={highlight} />
    ),
    renderDiffBlock: ({ diff, language, highlight }) => (
      <DiffCodeBlock diff={diff} language={language} highlight={highlight} />
    ),
    renderLocalFile: renderLocalFile ?? (({ reference, onOpen }) => (
      <LocalFileLink reference={reference} onOpen={onOpen} />
    )),
  };

  return <SharedMessageBodyRenderer {...sharedProps} />;
}
