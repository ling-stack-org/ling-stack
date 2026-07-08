import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../../../i18n.js";
import { useTheme } from "../../../theme.js";
import {
  renderShikiCodeTokens,
  shikiThemeForResolvedTheme,
  useShikiHighlightedCodeLines,
  type ShikiHighlightedToken,
} from "../code-highlighting/shiki.js";
import { CopyActionButton } from "../feedback/CopyActionButton.js";
import { notifyConversationDeferredContentReady } from "./deferred-rendering.js";

export interface CodeBlockProps {
  readonly code: string;
  readonly language?: string;
  readonly highlight?: boolean;
  readonly maxCollapsedLines?: number;
  readonly maxCollapsedCharacters?: number;
  readonly copyLabel?: string;
}

const defaultCollapsedLines = 24;
const defaultCollapsedCharacters = 3_600;
const deferredHighlightLines = 300;
const deferredHighlightCharacters = 24_000;

export function CodeBlock({
  code,
  language,
  highlight = true,
  maxCollapsedLines = defaultCollapsedLines,
  maxCollapsedCharacters = defaultCollapsedCharacters,
  copyLabel,
}: CodeBlockProps): JSX.Element {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const rootRef = useRef<HTMLElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const normalizedLanguage = normalizeCodeLanguage(language);
  const stats = useMemo(() => codeStats(code), [code]);
  const shouldDeferBody = stats.lines > deferredHighlightLines || stats.characters > deferredHighlightCharacters;
  const shouldCollapse = !shouldDeferBody && (stats.lines > maxCollapsedLines || stats.characters > maxCollapsedCharacters);
  const visibleCode = !expanded && shouldCollapse
    ? takeLines(code, maxCollapsedLines)
    : code;
  const hiddenLineCount = Math.max(0, stats.lines - maxCollapsedLines);
  const bodyMounted = !shouldDeferBody || expanded;
  const highlightLanguage = inferCodeHighlightLanguage(code, normalizedLanguage);
  const shouldAttemptShiki = highlight && bodyMounted;
  const shouldUseFallbackHighlighter = highlight && !shouldDeferBody;
  const shikiHighlight = useShikiHighlightedCodeLines({
    enabled: shouldAttemptShiki,
    language: highlightLanguage,
    source: bodyMounted ? visibleCode : "",
    theme: shikiThemeForResolvedTheme(resolvedTheme),
  });

  useEffect(() => {
    if (!bodyMounted) {
      return;
    }
    const frameId = globalThis.requestAnimationFrame(() => {
      notifyConversationDeferredContentReady(rootRef.current);
    });
    return () => globalThis.cancelAnimationFrame(frameId);
  }, [bodyMounted, shikiHighlight.status, stats.characters]);

  return (
    <figure
      ref={rootRef}
      className={[
        "message-code-block",
        shouldCollapse && !expanded ? "collapsed" : "",
        shouldDeferBody && !expanded ? "deferred" : "",
      ].filter(Boolean).join(" ")}
      data-language={normalizedLanguage}
      data-highlight-engine={shikiHighlight.status === "ready" ? "shiki" : shouldUseFallbackHighlighter ? "fallback" : "plain"}
    >
      <figcaption>
        <span>{normalizedLanguage}</span>
        <small>{t("{count} lines", { count: stats.lines })} · {formatCodeSize(stats.characters)}</small>
        <CopyActionButton text={code} label={copyLabel ?? t("Copy code")} className="message-code-copy" />
      </figcaption>
      {bodyMounted ? (
        <pre>
          <code>
            {shikiHighlight.status === "ready"
              ? renderShikiHighlightedCode(visibleCode, shikiHighlight.lines)
              : shouldUseFallbackHighlighter
              ? renderHighlightedCode(visibleCode, highlightLanguage)
              : visibleCode}
          </code>
        </pre>
      ) : (
        <div className="message-deferred-body-shell">
          <strong>{t("Large code block deferred")}</strong>
          <span>{t("Full body stays available inline without pre-rendering every line.")}</span>
          <button
            className="message-code-expand"
            type="button"
            aria-expanded={false}
            onClick={() => setExpanded(true)}
          >
            {t("Show full code")}
          </button>
        </div>
      )}
      {shouldDeferBody && expanded ? (
        <button
          className="message-code-expand"
          type="button"
          aria-expanded={true}
          onClick={() => setExpanded(false)}
        >
          {t("Collapse code")}
        </button>
      ) : shouldCollapse ? (
        <button
          className="message-code-expand"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? t("Collapse code")
            : hiddenLineCount > 0
              ? t("Show full code ({count} more lines)", { count: hiddenLineCount })
              : t("Show full code")}
        </button>
      ) : null}
    </figure>
  );
}

function renderShikiHighlightedCode(
  code: string,
  tokenLines: readonly (readonly ShikiHighlightedToken[])[],
): ReactNode {
  const lines = code.replace(/\r\n?/g, "\n").split("\n");
  return lines.map((line, index) => (
    <span key={`${index}:${line}`} className="message-code-line">
      {renderShikiCodeTokens(tokenLines[index]) ?? (line || " ")}
    </span>
  ));
}

interface CodeStats {
  readonly characters: number;
  readonly lines: number;
}

function codeStats(code: string): CodeStats {
  if (code.length === 0) {
    return { characters: 0, lines: 0 };
  }
  let lines = 1;
  for (let index = 0; index < code.length; index += 1) {
    if (code.charCodeAt(index) === 10) {
      lines += 1;
    }
  }
  return { characters: code.length, lines };
}

function takeLines(code: string, count: number): string {
  if (count <= 0) {
    return "";
  }
  let seen = 0;
  for (let index = 0; index < code.length; index += 1) {
    if (code.charCodeAt(index) !== 10) {
      continue;
    }
    seen += 1;
    if (seen >= count) {
      return code.slice(0, index);
    }
  }
  return code;
}

function formatCodeSize(characters: number): string {
  if (characters < 1024) {
    return `${characters} B`;
  }
  if (characters < 1024 * 1024) {
    return `${(characters / 1024).toFixed(1)} KB`;
  }
  return `${(characters / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizeCodeLanguage(language?: string): string {
  const normalized = language?.trim().toLowerCase();
  if (!normalized) {
    return "text";
  }
  if (normalized === "typescript") {
    return "ts";
  }
  if (normalized === "javascript") {
    return "js";
  }
  if (normalized === "shell" || normalized === "zsh" || normalized === "sh") {
    return "bash";
  }
  if (normalized === "patch") {
    return "diff";
  }
  return normalized;
}

function inferCodeHighlightLanguage(code: string, language: string): string {
  if (language !== "text" && language !== "bash") {
    return language;
  }
  const sample = code.trimStart();
  if (/^(?:<!doctype\s+html\b|<html[\s>])/iu.test(sample) || /<head[\s>][\s\S]*<body[\s>]/iu.test(sample)) {
    return "html";
  }
  return language;
}

function renderHighlightedCode(code: string, language: string): ReactNode {
  const lines = code.replace(/\r\n?/g, "\n").split("\n");
  let embeddedLanguage: "css" | "js" | undefined;
  return lines.map((line, index) => {
    const lineLanguage = htmlEmbeddedLanguageForLine(line, language, embeddedLanguage);
    const node = (
      <span key={`${index}:${line}`} className="message-code-line">
        {renderHighlightedLine(line, lineLanguage)}
      </span>
    );
    embeddedLanguage = nextHtmlEmbeddedLanguage(line, language, embeddedLanguage);
    return node;
  });
}

function htmlEmbeddedLanguageForLine(line: string, language: string, embeddedLanguage: "css" | "js" | undefined): string {
  if (language !== "html" && language !== "xml") {
    return language;
  }
  if (embeddedLanguage === "css" && !/^\s*<\/style\b/iu.test(line)) {
    return "css";
  }
  if (embeddedLanguage === "js" && !/^\s*<\/script\b/iu.test(line)) {
    return "js";
  }
  return language;
}

function nextHtmlEmbeddedLanguage(line: string, language: string, current: "css" | "js" | undefined): "css" | "js" | undefined {
  if (language !== "html" && language !== "xml") {
    return current;
  }
  if (current === "css") {
    return /<\/style>/iu.test(line) ? undefined : current;
  }
  if (current === "js") {
    return /<\/script>/iu.test(line) ? undefined : current;
  }
  if (/<style\b/iu.test(line) && !/<\/style>/iu.test(line)) {
    return "css";
  }
  if (/<script\b/iu.test(line) && !/<\/script>/iu.test(line)) {
    return "js";
  }
  return undefined;
}

function renderHighlightedLine(line: string, language: string): ReactNode {
  if (language === "text") {
    return line || " ";
  }

  const tokens = tokenizeCodeLine(line, language);
  if (tokens.length === 0) {
    return " ";
  }
  return tokens.map((token, index) => token.kind === "plain"
    ? token.text
    : <span key={`${index}:${token.kind}:${token.text}`} className={`code-token ${token.kind}`}>{token.text}</span>);
}

type CodeTokenKind = "plain" | "comment" | "string" | "keyword" | "number" | "property" | "function" | "punctuation" | "tag" | "attribute";

interface CodeToken {
  readonly kind: CodeTokenKind;
  readonly text: string;
}

function tokenizeCodeLine(line: string, language: string): readonly CodeToken[] {
  const specs = tokenSpecsForLanguage(language);
  if (specs.length === 0) {
    return [{ kind: "plain", text: line }];
  }

  const tokens: CodeToken[] = [];
  let remaining = line;
  while (remaining.length > 0) {
    let matched = false;
    for (const spec of specs) {
      const match = spec.pattern.exec(remaining);
      if (!match) {
        continue;
      }
      tokens.push({ kind: spec.kind, text: match[0] });
      remaining = remaining.slice(match[0].length);
      matched = true;
      break;
    }
    if (!matched) {
      tokens.push({ kind: "plain", text: remaining[0] ?? "" });
      remaining = remaining.slice(1);
    }
  }
  return coalescePlainTokens(tokens);
}

function tokenSpecsForLanguage(language: string): readonly { readonly kind: CodeTokenKind; readonly pattern: RegExp }[] {
  if (language === "json") {
    return [
      { kind: "property", pattern: /^"(?:\\.|[^"\\])*"(?=\s*:)/u },
      { kind: "string", pattern: /^"(?:\\.|[^"\\])*"/u },
      { kind: "number", pattern: /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/iu },
      { kind: "keyword", pattern: /^(?:true|false|null)\b/u },
      { kind: "punctuation", pattern: /^[{}[\]:,]/u },
    ];
  }
  if (language === "html" || language === "xml") {
    return [
      { kind: "comment", pattern: /^<!--.*?-->/u },
      { kind: "tag", pattern: /^<!doctype\b/iu },
      { kind: "tag", pattern: /^<\/?[A-Za-z][A-Za-z0-9:-]*/u },
      { kind: "attribute", pattern: /^[A-Za-z_:][A-Za-z0-9:_.-]*(?==)/u },
      { kind: "string", pattern: /^"(?:\\.|[^"\\])*"|^'(?:\\.|[^'\\])*'/u },
      { kind: "punctuation", pattern: /^[=<>/]/u },
    ];
  }
  if (language === "css") {
    return [
      { kind: "comment", pattern: /^\/\*.*?\*\//u },
      { kind: "property", pattern: /^(?:--)?[A-Za-z][A-Za-z0-9-]*(?=\s*:)/u },
      { kind: "string", pattern: /^"(?:\\.|[^"\\])*"|^'(?:\\.|[^'\\])*'/u },
      { kind: "number", pattern: /^#[0-9a-f]{3,8}\b/iu },
      { kind: "number", pattern: /^-?\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|s|ms)?\b/iu },
      { kind: "function", pattern: /^[A-Za-z-]+(?=\()/u },
      { kind: "punctuation", pattern: /^[{}():;,]/u },
    ];
  }
  if (language === "bash") {
    return [
      { kind: "comment", pattern: /^#.*/u },
      { kind: "string", pattern: /^"(?:\\.|[^"\\])*"|^'(?:\\.|[^'\\])*'/u },
      { kind: "keyword", pattern: /^(?:if|then|else|elif|fi|for|while|do|done|case|esac|function|export|readonly|local|return|exit|set)\b/u },
      { kind: "property", pattern: /^\$[A-Za-z_][A-Za-z0-9_]*|\$\{[^}]+\}/u },
      { kind: "number", pattern: /^\b\d+\b/u },
      { kind: "punctuation", pattern: /^[|&;()<>{}[\]=]/u },
    ];
  }
  if (language === "ts" || language === "tsx" || language === "js" || language === "jsx") {
    return [
      { kind: "comment", pattern: /^\/\/.*/u },
      { kind: "comment", pattern: /^\/\*.*?\*\//u },
      { kind: "string", pattern: /^`(?:\\.|[^`\\])*`|^"(?:\\.|[^"\\])*"|^'(?:\\.|[^'\\])*'/u },
      { kind: "keyword", pattern: /^(?:abstract|as|async|await|break|case|catch|class|const|continue|default|delete|do|else|enum|export|extends|finally|for|from|function|if|implements|import|in|instanceof|interface|let|new|null|of|private|protected|public|return|satisfies|static|super|switch|this|throw|true|try|type|typeof|undefined|void|while|yield)\b/u },
      { kind: "number", pattern: /^\b\d+(?:\.\d+)?\b/u },
      { kind: "function", pattern: /^[A-Za-z_$][A-Za-z0-9_$]*(?=\s*\()/u },
      { kind: "punctuation", pattern: /^[{}()[\].,;:?<>+\-*/%=&|!]/u },
    ];
  }
  return [];
}

function coalescePlainTokens(tokens: readonly CodeToken[]): readonly CodeToken[] {
  const result: CodeToken[] = [];
  for (const token of tokens) {
    const previous = result[result.length - 1];
    if (token.kind === "plain" && previous?.kind === "plain") {
      result[result.length - 1] = { kind: "plain", text: previous.text + token.text };
      continue;
    }
    result.push(token);
  }
  return result;
}
