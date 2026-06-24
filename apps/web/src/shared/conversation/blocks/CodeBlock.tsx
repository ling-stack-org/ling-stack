import { useMemo, useState, type ReactNode } from "react";
import { useI18n } from "../../../i18n.js";
import { CopyActionButton } from "../feedback/CopyActionButton.js";

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

export function CodeBlock({
  code,
  language,
  highlight = true,
  maxCollapsedLines = defaultCollapsedLines,
  maxCollapsedCharacters = defaultCollapsedCharacters,
  copyLabel,
}: CodeBlockProps): JSX.Element {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const normalizedLanguage = normalizeCodeLanguage(language);
  const lines = useMemo(() => code.replace(/\r\n?/g, "\n").split("\n"), [code]);
  const shouldCollapse = lines.length > maxCollapsedLines || code.length > maxCollapsedCharacters;
  const visibleCode = !expanded && shouldCollapse
    ? lines.slice(0, maxCollapsedLines).join("\n")
    : code;
  const hiddenLineCount = Math.max(0, lines.length - maxCollapsedLines);
  const shouldHighlight = highlight && !shouldCollapse || highlight && expanded;

  return (
    <figure className={`message-code-block${shouldCollapse && !expanded ? " collapsed" : ""}`} data-language={normalizedLanguage}>
      <figcaption>
        <span>{normalizedLanguage}</span>
        <CopyActionButton text={code} label={copyLabel ?? t("Copy code")} className="message-code-copy" />
      </figcaption>
      <pre>
        <code>
          {shouldHighlight
            ? renderHighlightedCode(visibleCode, normalizedLanguage)
            : visibleCode}
        </code>
      </pre>
      {shouldCollapse ? (
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

function renderHighlightedCode(code: string, language: string): ReactNode {
  const lines = code.replace(/\r\n?/g, "\n").split("\n");
  return lines.map((line, index) => (
    <span key={`${index}:${line}`} className="message-code-line">
      {renderHighlightedLine(line, language)}
    </span>
  ));
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
      { kind: "tag", pattern: /^<\/?[A-Za-z][A-Za-z0-9:-]*/u },
      { kind: "attribute", pattern: /^[A-Za-z_:][A-Za-z0-9:_.-]*(?==)/u },
      { kind: "string", pattern: /^"(?:\\.|[^"\\])*"|^'(?:\\.|[^'\\])*'/u },
      { kind: "punctuation", pattern: /^[=<>/]/u },
    ];
  }
  if (language === "css") {
    return [
      { kind: "comment", pattern: /^\/\*.*?\*\//u },
      { kind: "property", pattern: /^--?[A-Za-z][A-Za-z0-9-]*(?=\s*:)/u },
      { kind: "string", pattern: /^"(?:\\.|[^"\\])*"|^'(?:\\.|[^'\\])*'/u },
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
