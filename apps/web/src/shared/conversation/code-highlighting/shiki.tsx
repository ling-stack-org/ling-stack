import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ResolvedTheme } from "../../../theme.js";

export type ShikiTheme = "github-light-default" | "github-dark-default";

export interface ShikiHighlightedToken {
  readonly content: string;
  readonly color?: string;
  readonly fontStyle?: number;
}

export type ShikiHighlightStatus = "idle" | "loading" | "ready" | "failed";

export interface ShikiHighlightedCodeLines {
  readonly language: string;
  readonly lines: readonly (readonly ShikiHighlightedToken[])[];
  readonly status: ShikiHighlightStatus;
}

export function shikiThemeForResolvedTheme(theme: ResolvedTheme): ShikiTheme {
  return theme === "dark" ? "github-dark-default" : "github-light-default";
}

export function useShikiHighlightedCodeLines({
  enabled,
  language,
  source,
  theme,
}: {
  readonly enabled: boolean;
  readonly language: string | undefined;
  readonly source: string;
  readonly theme: ShikiTheme;
}): ShikiHighlightedCodeLines {
  const normalizedLanguage = useMemo(() => normalizeShikiLanguage(language) ?? "text", [language]);
  const [highlight, setHighlight] = useState<ShikiHighlightedCodeLines>(() => ({
    language: normalizedLanguage,
    lines: [],
    status: "idle",
  }));

  useEffect(() => {
    const trimmedSource = source.trim();
    if (!enabled || normalizedLanguage === "text" || trimmedSource.length === 0) {
      setHighlight({ language: normalizedLanguage, lines: [], status: "idle" });
      return undefined;
    }

    let cancelled = false;
    setHighlight({ language: normalizedLanguage, lines: [], status: "loading" });
    void tokenizeWithShiki(source, normalizedLanguage, theme).then((lines) => {
      if (!cancelled) {
        setHighlight({ language: normalizedLanguage, lines, status: "ready" });
      }
    }, () => {
      if (!cancelled) {
        setHighlight({ language: normalizedLanguage, lines: [], status: "failed" });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [enabled, normalizedLanguage, source, theme]);

  return highlight;
}

export function renderShikiCodeTokens(
  tokens: readonly ShikiHighlightedToken[] | undefined,
  className = "code-token shiki",
): ReactNode[] | undefined {
  if (!tokens || tokens.length === 0) {
    return undefined;
  }
  return tokens.map((token, index) => (
    <span
      key={`${index}:${token.content}`}
      className={className}
      style={{
        color: token.color,
        fontStyle: token.fontStyle && (token.fontStyle & 1) ? "italic" : undefined,
        fontWeight: token.fontStyle && (token.fontStyle & 2) ? 700 : undefined,
        textDecoration: token.fontStyle && (token.fontStyle & 4) ? "underline" : undefined,
      }}
    >
      {token.content}
    </span>
  ));
}

export function normalizeShikiLanguage(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const languages: Readonly<Record<string, string>> = {
    bash: "bash",
    css: "css",
    diff: "diff",
    htm: "html",
    html: "html",
    javascript: "javascript",
    js: "javascript",
    json: "json",
    jsx: "jsx",
    markdown: "markdown",
    md: "markdown",
    mjs: "javascript",
    patch: "diff",
    py: "python",
    shell: "bash",
    sh: "bash",
    ts: "typescript",
    tsx: "tsx",
    txt: "text",
    typescript: "typescript",
    yml: "yaml",
    yaml: "yaml",
    zsh: "bash",
  };
  return languages[normalized] ?? normalized;
}

async function tokenizeWithShiki(
  source: string,
  language: string,
  theme: ShikiTheme,
): Promise<readonly (readonly ShikiHighlightedToken[])[]> {
  const { codeToTokens } = await import("shiki");
  const result = await codeToTokens(source, {
    lang: language as Parameters<typeof codeToTokens>[1]["lang"],
    theme,
  });
  const tokenLines = "tokens" in result ? result.tokens : [];
  return tokenLines.map((line) => line.map((token) => ({
    content: token.content,
    color: token.color,
    fontStyle: token.fontStyle,
  })));
}
