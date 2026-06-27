export interface LocalFileReference {
  readonly raw: string;
  readonly displayPath: string;
  readonly location?: string;
  readonly insideWorkspace: boolean;
}

export type MessageInlineToken =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "mention"; readonly text: string }
  | { readonly kind: "strong"; readonly children: readonly MessageInlineToken[] }
  | { readonly kind: "inline_code"; readonly code: string }
  | { readonly kind: "web_link"; readonly href: string; readonly label: string }
  | { readonly kind: "local_file"; readonly reference: LocalFileReference };

export type MessageBodyBlock =
  | { readonly kind: "paragraph"; readonly inlines: readonly MessageInlineToken[] }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: readonly (readonly MessageInlineToken[])[] }
  | { readonly kind: "code"; readonly code: string; readonly language?: string };

export interface MessageBodyParseOptions {
  readonly allowMarkdown?: boolean;
}

interface LocalPathMatch {
  readonly raw: string;
  readonly reference: LocalFileReference;
}

const mentionPattern = /^@[A-Za-z0-9][A-Za-z0-9_.-]*/;
const webUrlPattern = /^https?:\/\/[^\s<>"']+/i;
const markdownLinkPattern = /^\[([^\]\n]+)\]\(([^)\s]+)\)/;
const fencePattern = /^\s*```([A-Za-z0-9_+.#-]*)\s*$/;
const fenceClosePattern = /^\s*```\s*$/;
const unorderedListItemPattern = /^\s*[-*+]\s+(.+)$/;
const orderedListItemPattern = /^\s*\d+[.)]\s+(.+)$/;

export function parseMessageBody(
  text: string,
  cwd?: string,
  options: MessageBodyParseOptions = {},
): readonly MessageBodyBlock[] {
  const allowMarkdown = options.allowMarkdown !== false;
  const normalized = text.replace(/\r\n?/g, "\n");
  if (normalized.trim().length === 0) {
    return [];
  }

  const lines = normalized.split("\n");
  const blocks: MessageBodyBlock[] = [];
  let paragraphLines: string[] = [];

  function flushParagraph(): void {
    if (paragraphLines.length === 0) {
      return;
    }
    blocks.push({
      kind: "paragraph",
      inlines: splitInlineTokens(paragraphLines.join("\n"), cwd, options),
    });
    paragraphLines = [];
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (allowMarkdown) {
      const fenceMatch = fencePattern.exec(line);
      if (fenceMatch) {
        flushParagraph();
        const codeLines: string[] = [];
        index += 1;
        for (; index < lines.length; index += 1) {
          const codeLine = lines[index] ?? "";
          if (fenceClosePattern.test(codeLine)) {
            break;
          }
          codeLines.push(codeLine);
        }
        blocks.push({
          kind: "code",
          code: codeLines.join("\n"),
          language: fenceMatch[1] ? fenceMatch[1] : undefined,
        });
        continue;
      }

      const listMatch = readListItem(line);
      if (listMatch) {
        flushParagraph();
        const ordered = listMatch.ordered;
        const items: (readonly MessageInlineToken[])[] = [];
        for (; index < lines.length; index += 1) {
          const current = readListItem(lines[index] ?? "");
          if (!current || current.ordered !== ordered) {
            index -= 1;
            break;
          }
          items.push(splitInlineTokens(current.text, cwd, options));
        }
        blocks.push({ kind: "list", ordered, items });
        continue;
      }
    }

    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }

    paragraphLines.push(line);
  }

  flushParagraph();
  return blocks;
}

export function splitInlineTokens(
  text: string,
  cwd?: string,
  options: MessageBodyParseOptions = {},
): readonly MessageInlineToken[] {
  const allowMarkdown = options.allowMarkdown !== false;
  const tokens: MessageInlineToken[] = [];
  let index = 0;

  function appendText(value: string): void {
    if (value.length === 0) {
      return;
    }
    const previous = tokens[tokens.length - 1];
    if (previous?.kind === "text") {
      tokens[tokens.length - 1] = { kind: "text", text: previous.text + value };
      return;
    }
    tokens.push({ kind: "text", text: value });
  }

  while (index < text.length) {
    const remaining = text.slice(index);

    if (allowMarkdown) {
      const inlineCode = readInlineCode(remaining);
      if (inlineCode) {
        tokens.push({ kind: "inline_code", code: inlineCode.value });
        index += inlineCode.length;
        continue;
      }

      const strong = readStrong(remaining, cwd, options);
      if (strong) {
        tokens.push({ kind: "strong", children: strong.children });
        index += strong.length;
        continue;
      }

      const markdownLink = readMarkdownLink(remaining, cwd);
      if (markdownLink) {
        tokens.push(markdownLink.token);
        index += markdownLink.length;
        continue;
      }
    }

    const webLink = readWebLink(remaining);
    if (webLink) {
      tokens.push({ kind: "web_link", href: webLink.href, label: webLink.href });
      index += webLink.href.length;
      continue;
    }

    const mention = mentionPattern.exec(remaining);
    if (mention) {
      tokens.push({ kind: "mention", text: mention[0] });
      index += mention[0].length;
      continue;
    }

    if (isLocalPathStartBoundary(text[index - 1])) {
      const localPath = readLocalPath(remaining, cwd);
      if (localPath) {
        tokens.push({ kind: "local_file", reference: localPath.reference });
        index += localPath.raw.length;
        continue;
      }
    }

    appendText(text[index] ?? "");
    index += 1;
  }

  return tokens;
}

export function parseLocalFileReference(raw: string, cwd?: string): LocalFileReference {
  const cleaned = stripFileScheme(raw.trim());
  const locationParts = splitLocationSuffix(cleaned);
  const pathOnly = locationParts.path;
  const location = locationParts.location;
  const normalizedCwd = cwd ? normalizePath(cwd) : "";
  const normalizedPath = pathOnly.startsWith("/") ? normalizePath(pathOnly) : pathOnly;

  let displayPath = pathOnly;
  let insideWorkspace = false;

  if (normalizedCwd.length > 0) {
    if (pathOnly.startsWith("/")) {
      if (normalizedPath === normalizedCwd) {
        insideWorkspace = true;
        displayPath = ".";
      } else if (normalizedPath.startsWith(`${normalizedCwd}/`)) {
        insideWorkspace = true;
        displayPath = normalizedPath.slice(normalizedCwd.length + 1);
      } else {
        displayPath = normalizedPath;
      }
    } else if (!pathOnly.startsWith("~/")) {
      insideWorkspace = true;
      displayPath = pathOnly.replace(/^\.\//, "");
    }
  }

  return {
    raw,
    displayPath: `${displayPath}${location ?? ""}`,
    location,
    insideWorkspace,
  };
}

function readListItem(line: string): { readonly ordered: boolean; readonly text: string } | undefined {
  const ordered = orderedListItemPattern.exec(line);
  if (ordered) {
    return { ordered: true, text: ordered[1] ?? "" };
  }
  const unordered = unorderedListItemPattern.exec(line);
  if (unordered) {
    return { ordered: false, text: unordered[1] ?? "" };
  }
  return undefined;
}

function readInlineCode(text: string): { readonly value: string; readonly length: number } | undefined {
  if (!text.startsWith("`") || text.startsWith("```")) {
    return undefined;
  }
  const closingIndex = text.indexOf("`", 1);
  if (closingIndex <= 1) {
    return undefined;
  }
  return {
    value: text.slice(1, closingIndex),
    length: closingIndex + 1,
  };
}

function readStrong(
  text: string,
  cwd: string | undefined,
  options: MessageBodyParseOptions,
): { readonly children: readonly MessageInlineToken[]; readonly length: number } | undefined {
  const marker = text.startsWith("**") ? "**" : text.startsWith("__") ? "__" : "";
  if (!marker) {
    return undefined;
  }
  const closingIndex = text.indexOf(marker, marker.length);
  if (closingIndex <= marker.length) {
    return undefined;
  }
  const innerText = text.slice(marker.length, closingIndex);
  return {
    children: splitInlineTokens(innerText, cwd, options),
    length: closingIndex + marker.length,
  };
}

function readMarkdownLink(
  text: string,
  cwd?: string,
): { readonly token: MessageInlineToken; readonly length: number } | undefined {
  const match = markdownLinkPattern.exec(text);
  if (!match) {
    return undefined;
  }

  const label = match[1] ?? "";
  const destination = stripWrappingQuotes(match[2] ?? "");
  const safeWebUrl = readWebLink(destination);
  if (safeWebUrl && safeWebUrl.href === destination) {
    return {
      token: { kind: "web_link", href: safeWebUrl.href, label },
      length: match[0].length,
    };
  }

  if (isLikelyLocalPath(destination)) {
    return {
      token: { kind: "local_file", reference: parseLocalFileReference(destination, cwd) },
      length: match[0].length,
    };
  }

  return {
    token: { kind: "text", text: label },
    length: match[0].length,
  };
}

function readWebLink(text: string): { readonly href: string } | undefined {
  const match = webUrlPattern.exec(text);
  if (!match) {
    return undefined;
  }
  const href = trimTrailingUrlPunctuation(match[0]);
  if (href.length === 0) {
    return undefined;
  }
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return { href };
}

function readLocalPath(text: string, cwd?: string): LocalPathMatch | undefined {
  const startsLikePath = /^(?:~\/|\.{1,2}\/|\/[A-Za-z0-9._~@%+-]|(?:[A-Za-z0-9_.-]+\/))/.test(text);
  if (!startsLikePath) {
    return undefined;
  }
  const match = /^(?:(?:~\/|\.{1,2}\/)[A-Za-z0-9._~@%+/#:-]+|\/[A-Za-z0-9._~@%+-][A-Za-z0-9._~@%+/#:-]*|(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.@+-][A-Za-z0-9._~@%+/#:-]*)/.exec(text);
  if (!match) {
    return undefined;
  }
  const raw = trimTrailingPathPunctuation(match[0]);
  if (!isLikelyLocalPath(raw)) {
    return undefined;
  }
  return {
    raw,
    reference: parseLocalFileReference(raw, cwd),
  };
}

function isLocalPathStartBoundary(previous: string | undefined): boolean {
  return previous === undefined || /\s/.test(previous) || "([{<\"'`|".includes(previous);
}

function isLikelyLocalPath(value: string): boolean {
  const cleaned = stripFileScheme(value.trim());
  if (cleaned.length < 3 || cleaned.startsWith("http://") || cleaned.startsWith("https://")) {
    return false;
  }
  const pathOnly = splitLocationSuffix(cleaned).path;
  if (pathOnly.startsWith("/") || pathOnly.startsWith("./") || pathOnly.startsWith("../") || pathOnly.startsWith("~/")) {
    return pathOnly.includes("/");
  }
  return pathOnly.includes("/") && /\.[A-Za-z0-9]{1,12}$/.test(pathOnly);
}

function splitLocationSuffix(value: string): { readonly path: string; readonly location?: string } {
  const hashMatch = /^(.*?)(#L\d+(?:-L?\d+)?)$/.exec(value);
  if (hashMatch) {
    return { path: hashMatch[1] ?? "", location: hashMatch[2] };
  }
  const colonMatch = /^(.*?)(:\d+(?::\d+)?)$/.exec(value);
  if (colonMatch) {
    return { path: colonMatch[1] ?? "", location: colonMatch[2] };
  }
  return { path: value };
}

function stripFileScheme(value: string): string {
  if (!value.startsWith("file://")) {
    return value;
  }
  try {
    return decodeURI(value.slice("file://".length));
  } catch {
    return value.slice("file://".length);
  }
}

function stripWrappingQuotes(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function trimTrailingUrlPunctuation(value: string): string {
  return value.replace(/[),.;!?]+$/g, "");
}

function trimTrailingPathPunctuation(value: string): string {
  return value.replace(/[),.;!?]+$/g, "");
}

function normalizePath(value: string): string {
  const absolute = value.startsWith("/");
  const parts: string[] = [];
  for (const rawPart of value.split("/")) {
    if (!rawPart || rawPart === ".") {
      continue;
    }
    if (rawPart === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!absolute) {
        parts.push(rawPart);
      }
      continue;
    }
    parts.push(rawPart);
  }
  const normalized = `${absolute ? "/" : ""}${parts.join("/")}`;
  return normalized || (absolute ? "/" : ".");
}
