import { Fragment, type ReactNode } from "react";
import {
  parseMessageBody,
  type LocalFileReference,
  type MessageBodyBlock,
  type MessageInlineToken,
} from "@ling-stack/conversation-ui-core";
import { CopyActionButton } from "../feedback/CopyActionButton.js";
import { MathContent, MermaidBlock } from "./RichContent.js";

export interface MessageCodeBlockRenderInput {
  readonly code: string;
  readonly language?: string;
  readonly highlight: boolean;
}

export interface MessageDiffBlockRenderInput {
  readonly diff: string;
  readonly language?: string;
  readonly highlight: boolean;
}

export interface MessageLocalFileRenderInput {
  readonly reference: LocalFileReference;
  readonly onOpen?: (reference: LocalFileReference) => void;
}

export interface MessageBodyRendererProps {
  readonly text: string;
  readonly cwd?: string;
  readonly compact?: boolean;
  readonly allowMarkdown?: boolean;
  readonly streaming?: boolean;
  readonly className?: string;
  readonly renderCodeBlock?: (input: MessageCodeBlockRenderInput) => ReactNode;
  readonly renderDiffBlock?: (input: MessageDiffBlockRenderInput) => ReactNode;
  readonly renderLocalFile?: (input: MessageLocalFileRenderInput) => ReactNode;
  readonly onOpenLocalFile?: (reference: LocalFileReference) => void;
  readonly onDeferredContentReady?: (target: Element | null) => void;
}

export function MessageBodyRenderer({
  text,
  cwd,
  compact = false,
  allowMarkdown = true,
  streaming = false,
  className,
  renderCodeBlock,
  renderDiffBlock,
  renderLocalFile,
  onOpenLocalFile,
  onDeferredContentReady,
}: MessageBodyRendererProps): JSX.Element {
  const blocks = parseMessageBody(text, cwd, { allowMarkdown, streaming });
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
      {blocks.map((block, index) => renderBlock(block, index, {
        onOpenLocalFile,
        renderCodeBlock,
        renderDiffBlock,
        renderLocalFile,
        streaming,
        onDeferredContentReady,
      }))}
    </div>
  );
}

interface RenderBlockOptions {
  readonly onOpenLocalFile?: (reference: LocalFileReference) => void;
  readonly renderCodeBlock?: (input: MessageCodeBlockRenderInput) => ReactNode;
  readonly renderDiffBlock?: (input: MessageDiffBlockRenderInput) => ReactNode;
  readonly renderLocalFile?: (input: MessageLocalFileRenderInput) => ReactNode;
  readonly streaming: boolean;
  readonly onDeferredContentReady?: (target: Element | null) => void;
}

function renderBlock(
  block: MessageBodyBlock,
  index: number,
  options: RenderBlockOptions,
): ReactNode {
  switch (block.kind) {
    case "code": {
      const highlight = !options.streaming && block.complete;
      if (isDiffLanguage(block.language)) {
        return (
          <Fragment key={`diff-${index}`}>
            {options.renderDiffBlock?.({ diff: block.code, language: block.language, highlight }) ??
              <DefaultCodeBlock code={block.code} language={block.language ?? "diff"} copyLabel="Copy diff" kind="diff" />}
          </Fragment>
        );
      }
      return (
        <Fragment key={`code-${index}`}>
          {options.renderCodeBlock?.({ code: block.code, language: block.language, highlight }) ??
            <DefaultCodeBlock code={block.code} language={block.language} copyLabel="Copy code" kind="code" />}
        </Fragment>
      );
    }
    case "mermaid":
      return <MermaidBlock key={`mermaid-${index}`} source={block.source} complete={block.complete} onDeferredContentReady={options.onDeferredContentReady} />;
    case "math":
      return <MathContent key={`math-${index}`} source={block.source} display complete={block.complete} onDeferredContentReady={options.onDeferredContentReady} />;
    case "heading": {
      const HeadingTag = `h${block.depth}` as keyof JSX.IntrinsicElements;
      return <HeadingTag key={`heading-${index}`} className="message-body-heading">{renderInlineTokens(block.inlines, options)}</HeadingTag>;
    }
    case "quote":
      return <blockquote key={`quote-${index}`} className="message-body-quote">{block.blocks.map((child, childIndex) => renderBlock(child, childIndex, options))}</blockquote>;
    case "table":
      return (
        <div key={`table-${index}`} className="message-body-table-scroll">
          <table className="message-body-table">
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`row-${rowIndex}`}>
                  {row.map((cell, cellIndex) => {
                    const CellTag = rowIndex === 0 ? "th" : "td";
                    return <CellTag key={`cell-${cellIndex}`} style={{ textAlign: block.align[cellIndex] ?? undefined }}>{renderInlineTokens(cell, options)}</CellTag>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "thematic_break":
      return <hr key={`break-${index}`} className="message-body-thematic-break" />;
    case "list": {
      const ListTag = block.ordered ? "ol" : "ul";
      const listClassName = block.items.some((item) => item.checked !== undefined)
        ? "message-body-list message-body-task-list"
        : "message-body-list";
      return (
        <ListTag key={`list-${index}`} className={listClassName} start={block.ordered ? block.start : undefined}>
          {block.items.map((item, itemIndex) => (
            <li key={`item-${itemIndex}`} className={item.checked === undefined ? undefined : "message-body-task-item"}>
              {item.checked === undefined ? null : <input data-ling-control-native="true" type="checkbox" checked={item.checked} readOnly tabIndex={-1} aria-hidden="true" />}
              <div>{item.blocks.map((child, childIndex) => renderBlock(child, childIndex, options))}</div>
            </li>
          ))}
        </ListTag>
      );
    }
    case "paragraph":
      return (
        <p key={`paragraph-${index}`} className="message-body-paragraph">
          {renderInlineTokens(block.inlines, options)}
        </p>
      );
  }
}

function renderInlineTokens(
  tokens: readonly MessageInlineToken[],
  options: RenderBlockOptions,
): ReactNode {
  return tokens.map((token, index) => {
    switch (token.kind) {
      case "mention":
        return <span key={`mention-${index}`} className="message-mention-token">{token.text}</span>;
      case "strong":
        return <strong key={`strong-${index}`}>{renderInlineTokens(token.children, options)}</strong>;
      case "emphasis":
        return <em key={`emphasis-${index}`}>{renderInlineTokens(token.children, options)}</em>;
      case "delete":
        return <del key={`delete-${index}`}>{renderInlineTokens(token.children, options)}</del>;
      case "inline_code":
        return <code key={`code-${index}`} className="message-inline-code">{token.code}</code>;
      case "inline_math":
        return <MathContent key={`math-${index}`} source={token.source} display={false} onDeferredContentReady={options.onDeferredContentReady} />;
      case "line_break":
        return <br key={`break-${index}`} />;
      case "web_link":
        return (
          <a key={`link-${index}`} className="message-web-link" href={token.href} target="_blank" rel="noreferrer" title={token.href}>
            <span className="message-inline-token-icon" aria-hidden="true">L</span>
            <strong>{webLinkPrimaryLabel(token)}</strong>
            {webLinkSecondaryLabel(token) ? <small>{webLinkSecondaryLabel(token)}</small> : null}
          </a>
        );
      case "local_file":
        return (
          <Fragment key={`file-${index}`}>
            {options.renderLocalFile?.({ reference: token.reference, onOpen: options.onOpenLocalFile }) ??
              <DefaultLocalFileLink reference={token.reference} onOpen={options.onOpenLocalFile} />}
          </Fragment>
        );
      case "text":
        return token.text;
    }
  });
}

function DefaultCodeBlock({
  code,
  copyLabel,
  kind,
  language,
}: {
  readonly code: string;
  readonly copyLabel: string;
  readonly kind: "code" | "diff";
  readonly language?: string;
}): JSX.Element {
  const normalizedLanguage = language?.trim() || (kind === "diff" ? "diff" : "text");
  return (
    <figure className={kind === "diff" ? "message-diff-block" : "message-code-block"} data-language={normalizedLanguage}>
      <figcaption>
        <span>{normalizedLanguage}</span>
        <CopyActionButton text={code} label={copyLabel} className="message-code-copy" />
      </figcaption>
      <pre>
        <code>{code}</code>
      </pre>
    </figure>
  );
}

function DefaultLocalFileLink({
  reference,
  onOpen,
}: {
  readonly reference: LocalFileReference;
  readonly onOpen?: (reference: LocalFileReference) => void;
}): JSX.Element {
  const className = reference.insideWorkspace
    ? "message-local-file-link"
    : "message-local-file-link outside-workspace";
  const title = reference.insideWorkspace
    ? reference.raw
    : `${reference.raw} (outside workspace)`;
  const content = (
    <>
      <span className="message-inline-token-icon" aria-hidden="true">F</span>
      <strong>{localFilePrimaryLabel(reference)}</strong>
      {localFileSecondaryLabel(reference) ? <small>{localFileSecondaryLabel(reference)}</small> : null}
    </>
  );

  if (reference.insideWorkspace && onOpen) {
    return (
      <button className={className} type="button" title={title} onClick={() => onOpen(reference)}>
        {content}
      </button>
    );
  }

  return (
    <span className={className} title={title}>
      {content}
    </span>
  );
}

function isDiffLanguage(language: string | undefined): boolean {
  const normalized = language?.trim().toLowerCase();
  return normalized === "diff" || normalized === "patch";
}

function localFilePrimaryLabel(reference: LocalFileReference): string {
  const withoutLocation = reference.displayPath.replace(reference.location ?? "", "");
  const parts = withoutLocation.split("/").filter(Boolean);
  return parts.at(-1) ?? (withoutLocation || reference.displayPath);
}

function localFileSecondaryLabel(reference: LocalFileReference): string | undefined {
  const location = reference.location;
  const withoutLocation = reference.displayPath.replace(location ?? "", "");
  const parts = withoutLocation.split("/").filter(Boolean);
  const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
  if (location && folder) {
    return `${folder}${location}`;
  }
  return location ?? (folder || undefined);
}

function webLinkPrimaryLabel(token: Extract<MessageInlineToken, { readonly kind: "web_link" }>): string {
  const normalizedLabel = token.label.trim();
  const host = webLinkHost(token.href);
  if (!normalizedLabel || normalizedLabel === token.href || normalizedLabel.replace(/\/$/u, "") === token.href.replace(/\/$/u, "")) {
    return host ?? (normalizedLabel || token.href);
  }
  return normalizedLabel;
}

function webLinkSecondaryLabel(token: Extract<MessageInlineToken, { readonly kind: "web_link" }>): string | undefined {
  const host = webLinkHost(token.href);
  const primary = webLinkPrimaryLabel(token);
  if (!host || primary === host) {
    return undefined;
  }
  return host;
}

function webLinkHost(href: string): string | undefined {
  try {
    return new URL(href).hostname.replace(/^www\./iu, "");
  } catch {
    return undefined;
  }
}
