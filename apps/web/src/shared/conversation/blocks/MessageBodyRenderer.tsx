import type { ReactNode } from "react";
import { CodeBlock } from "./CodeBlock.js";
import { DiffCodeBlock, isDiffLanguage } from "./DiffCodeBlock.js";
import { LocalFileLink } from "./LocalFileLink.js";
import { parseMessageBody, type LocalFileReference, type MessageBodyBlock, type MessageInlineToken } from "../tokens/message-body.js";

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
  text,
  cwd,
  compact = false,
  allowMarkdown = true,
  streaming = false,
  className,
  onOpenLocalFile,
}: MessageBodyRendererProps): JSX.Element {
  const blocks = parseMessageBody(text, cwd, { allowMarkdown });
  const rootClassName = [
    "message-body-renderer",
    compact ? "compact" : "",
    className,
  ].filter(Boolean).join(" ");

  if (blocks.length === 0) {
    return <div className={`${rootClassName} empty`} />;
  }

  return (
    <div className={rootClassName}>
      {blocks.map((block, index) => renderBlock(block, index, onOpenLocalFile, streaming))}
    </div>
  );
}

function renderBlock(
  block: MessageBodyBlock,
  index: number,
  onOpenLocalFile: ((reference: LocalFileReference) => void) | undefined,
  streaming: boolean,
): ReactNode {
  switch (block.kind) {
    case "code":
      return isDiffLanguage(block.language)
        ? <DiffCodeBlock key={`diff-${index}`} diff={block.code} language={block.language} highlight={!streaming} />
        : <CodeBlock key={`code-${index}`} code={block.code} language={block.language} highlight={!streaming} />;
    case "list": {
      const ListTag = block.ordered ? "ol" : "ul";
      return (
        <ListTag key={`list-${index}`} className="message-body-list">
          {block.items.map((item, itemIndex) => (
            <li key={`item-${itemIndex}`}>{renderInlineTokens(item, onOpenLocalFile)}</li>
          ))}
        </ListTag>
      );
    }
    case "paragraph":
      return (
        <p key={`paragraph-${index}`} className="message-body-paragraph">
          {renderInlineTokens(block.inlines, onOpenLocalFile)}
        </p>
      );
  }
}

function renderInlineTokens(
  tokens: readonly MessageInlineToken[],
  onOpenLocalFile: ((reference: LocalFileReference) => void) | undefined,
): ReactNode {
  return tokens.map((token, index) => {
    switch (token.kind) {
      case "mention":
        return <span key={`mention-${index}`} className="message-mention-token">{token.text}</span>;
      case "strong":
        return <strong key={`strong-${index}`}>{renderInlineTokens(token.children, onOpenLocalFile)}</strong>;
      case "inline_code":
        return <code key={`code-${index}`} className="message-inline-code">{token.code}</code>;
      case "web_link":
        return (
          <a key={`link-${index}`} className="message-web-link" href={token.href} target="_blank" rel="noreferrer">
            {token.label}
          </a>
        );
      case "local_file":
        return <LocalFileLink key={`file-${index}`} reference={token.reference} onOpen={onOpenLocalFile} />;
      case "text":
        return token.text;
    }
  });
}
