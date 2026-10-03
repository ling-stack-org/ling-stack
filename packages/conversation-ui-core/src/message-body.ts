import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

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
  | { readonly kind: "emphasis"; readonly children: readonly MessageInlineToken[] }
  | { readonly kind: "delete"; readonly children: readonly MessageInlineToken[] }
  | { readonly kind: "inline_code"; readonly code: string }
  | { readonly kind: "inline_math"; readonly source: string }
  | { readonly kind: "line_break" }
  | { readonly kind: "web_link"; readonly href: string; readonly label: string }
  | { readonly kind: "local_file"; readonly reference: LocalFileReference };

export interface MessageListItem {
  readonly blocks: readonly MessageBodyBlock[];
  readonly checked?: boolean;
}

export type MessageBodyBlock =
  | { readonly kind: "paragraph"; readonly inlines: readonly MessageInlineToken[] }
  | { readonly kind: "heading"; readonly depth: 1 | 2 | 3 | 4 | 5 | 6; readonly inlines: readonly MessageInlineToken[] }
  | { readonly kind: "quote"; readonly blocks: readonly MessageBodyBlock[] }
  | { readonly kind: "list"; readonly ordered: boolean; readonly start?: number; readonly items: readonly MessageListItem[] }
  | { readonly kind: "table"; readonly align: readonly ("left" | "center" | "right" | null)[]; readonly rows: readonly (readonly (readonly MessageInlineToken[])[])[] }
  | { readonly kind: "thematic_break" }
  | { readonly kind: "code"; readonly code: string; readonly language?: string; readonly complete: boolean }
  | { readonly kind: "mermaid"; readonly source: string; readonly complete: boolean }
  | { readonly kind: "math"; readonly source: string; readonly display: true; readonly complete: boolean };

export interface MessageBodyParseOptions {
  readonly allowMarkdown?: boolean;
  readonly streaming?: boolean;
}

interface MarkdownNode {
  readonly type: string;
  readonly value?: string;
  readonly lang?: string | null;
  readonly url?: string;
  readonly alt?: string | null;
  readonly depth?: number;
  readonly ordered?: boolean;
  readonly start?: number | null;
  readonly checked?: boolean | null;
  readonly align?: readonly ("left" | "center" | "right" | null)[];
  readonly children?: readonly MarkdownNode[];
  readonly position?: { readonly start?: { readonly offset?: number }; readonly end?: { readonly offset?: number } };
}

interface LocalPathMatch {
  readonly raw: string;
  readonly reference: LocalFileReference;
}

const markdownParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const mentionPattern = /^@[A-Za-z0-9][A-Za-z0-9_.-]*/;
const webUrlPattern = /^https?:\/\/[^\s<>"']+/i;
const markdownLinkPattern = /^\[([^\]\n]+)\]\(([^)\s]+)\)/;

export function parseMessageBody(
  text: string,
  cwd?: string,
  options: MessageBodyParseOptions = {},
): readonly MessageBodyBlock[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized.trim()) {
    return [];
  }
  if (options.allowMarkdown === false) {
    return [{ kind: "paragraph", inlines: splitInlineTokens(normalized, cwd, { allowMarkdown: false }) }];
  }
  const root = markdownParser.parse(normalized) as unknown as MarkdownNode;
  const incompleteFence = options.streaming === true && hasUnclosedFence(normalized);
  const incompleteMath = options.streaming === true && hasUnclosedDisplayMath(normalized);
  return convertBlockNodes(root.children ?? [], {
    cwd,
    sourceLength: normalized.length,
    incompleteFence,
    incompleteMath,
  });
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
    if (!value) {
      return;
    }
    const previous = tokens[tokens.length - 1];
    if (previous?.kind === "text") {
      tokens[tokens.length - 1] = { kind: "text", text: previous.text + value };
    } else {
      tokens.push({ kind: "text", text: value });
    }
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
    const webLink = readWebLink(remaining, true);
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
    if (isLocalPathStartBoundary(text[index - 1]) && !isHtmlClosingTagPathStart(text, index)) {
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

export function collectLocalFileReferences(blocks: readonly MessageBodyBlock[]): readonly LocalFileReference[] {
  const references: LocalFileReference[] = [];
  const seen = new Set<string>();
  const visitInlines = (tokens: readonly MessageInlineToken[]): void => {
    for (const token of tokens) {
      if (token.kind === "local_file") {
        const key = `${token.reference.raw}:${token.reference.location ?? ""}`;
        if (!seen.has(key)) {
          seen.add(key);
          references.push(token.reference);
        }
      } else if (token.kind === "strong" || token.kind === "emphasis" || token.kind === "delete") {
        visitInlines(token.children);
      }
    }
  };
  const visitBlocks = (items: readonly MessageBodyBlock[]): void => {
    for (const block of items) {
      if (block.kind === "paragraph" || block.kind === "heading") {
        visitInlines(block.inlines);
      } else if (block.kind === "quote") {
        visitBlocks(block.blocks);
      } else if (block.kind === "list") {
        for (const item of block.items) {
          visitBlocks(item.blocks);
        }
      } else if (block.kind === "table") {
        for (const row of block.rows) {
          for (const cell of row) {
            visitInlines(cell);
          }
        }
      }
    }
  };
  visitBlocks(blocks);
  return references;
}

function convertBlockNodes(
  nodes: readonly MarkdownNode[],
  context: {
    readonly cwd?: string;
    readonly sourceLength: number;
    readonly incompleteFence: boolean;
    readonly incompleteMath: boolean;
  },
): MessageBodyBlock[] {
  const blocks: MessageBodyBlock[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "paragraph":
        blocks.push({ kind: "paragraph", inlines: convertInlineNodes(node.children ?? [], context.cwd) });
        break;
      case "heading":
        blocks.push({
          kind: "heading",
          depth: clampHeadingDepth(node.depth),
          inlines: convertInlineNodes(node.children ?? [], context.cwd),
        });
        break;
      case "blockquote":
        blocks.push({ kind: "quote", blocks: convertBlockNodes(node.children ?? [], context) });
        break;
      case "list":
        blocks.push({
          kind: "list",
          ordered: node.ordered === true,
          start: node.ordered && typeof node.start === "number" ? node.start : undefined,
          items: (node.children ?? []).map((item) => ({
            blocks: convertBlockNodes(item.children ?? [], context),
            checked: typeof item.checked === "boolean" ? item.checked : undefined,
          })),
        });
        break;
      case "table":
        blocks.push({
          kind: "table",
          align: node.align ?? [],
          rows: (node.children ?? []).map((row) => (row.children ?? []).map((cell) => convertInlineNodes(cell.children ?? [], context.cwd))),
        });
        break;
      case "thematicBreak":
        blocks.push({ kind: "thematic_break" });
        break;
      case "code": {
        const language = node.lang?.trim() || undefined;
        const complete = !(context.incompleteFence && node.position?.end?.offset === context.sourceLength);
        if (language?.toLowerCase() === "mermaid") {
          blocks.push({ kind: "mermaid", source: node.value ?? "", complete });
        } else {
          blocks.push({ kind: "code", code: node.value ?? "", language, complete });
        }
        break;
      }
      case "math":
        blocks.push({
          kind: "math",
          source: node.value ?? "",
          display: true,
          complete: !(context.incompleteMath && node.position?.end?.offset === context.sourceLength),
        });
        break;
      case "html":
        blocks.push({ kind: "paragraph", inlines: [{ kind: "text", text: node.value ?? "" }] });
        break;
      default:
        if (node.children?.length) {
          blocks.push(...convertBlockNodes(node.children, context));
        } else if (node.value) {
          blocks.push({ kind: "paragraph", inlines: splitInlineTokens(node.value, context.cwd, { allowMarkdown: false }) });
        }
    }
  }
  return blocks;
}

function convertInlineNodes(nodes: readonly MarkdownNode[], cwd?: string): MessageInlineToken[] {
  const tokens: MessageInlineToken[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        tokens.push(...splitInlineTokens(node.value ?? "", cwd, { allowMarkdown: false }));
        break;
      case "strong":
        tokens.push({ kind: "strong", children: convertInlineNodes(node.children ?? [], cwd) });
        break;
      case "emphasis":
        tokens.push({ kind: "emphasis", children: convertInlineNodes(node.children ?? [], cwd) });
        break;
      case "delete":
        tokens.push({ kind: "delete", children: convertInlineNodes(node.children ?? [], cwd) });
        break;
      case "inlineCode":
        tokens.push({ kind: "inline_code", code: node.value ?? "" });
        break;
      case "inlineMath":
        tokens.push({ kind: "inline_math", source: node.value ?? "" });
        break;
      case "break":
        tokens.push({ kind: "line_break" });
        break;
      case "link": {
        const label = inlineTextContent(node.children ?? []) || node.url || "";
        const destination = node.url ?? "";
        if (isBareGfmLink(node, label, destination)) {
          const bareLink = readWebLink(destination, true);
          if (bareLink) {
            tokens.push({ kind: "web_link", href: bareLink.href, label: bareLink.href });
            tokens.push(...splitInlineTokens(destination.slice(bareLink.href.length), cwd, { allowMarkdown: false }));
          } else {
            tokens.push({ kind: "text", text: label });
          }
          break;
        }
        const webLink = readWebLink(destination);
        if (webLink?.href === destination) {
          tokens.push({ kind: "web_link", href: destination, label });
        } else if (isLikelyLocalPath(destination)) {
          tokens.push({ kind: "local_file", reference: parseLocalFileReference(destination, cwd) });
        } else {
          tokens.push({ kind: "text", text: label });
        }
        break;
      }
      case "image":
        tokens.push({ kind: "text", text: node.alt ? `[${node.alt}]` : "" });
        break;
      case "html":
        tokens.push({ kind: "text", text: node.value ?? "" });
        break;
      default:
        if (node.children?.length) {
          tokens.push(...convertInlineNodes(node.children, cwd));
        } else if (node.value) {
          tokens.push({ kind: "text", text: node.value });
        }
    }
  }
  return tokens;
}

function inlineTextContent(nodes: readonly MarkdownNode[]): string {
  return nodes.map((node) => node.value ?? inlineTextContent(node.children ?? [])).join("");
}

function isBareGfmLink(node: MarkdownNode, label: string, destination: string): boolean {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  return label === destination && typeof start === "number" && typeof end === "number" && end - start === destination.length;
}

function clampHeadingDepth(value: number | undefined): 1 | 2 | 3 | 4 | 5 | 6 {
  return Math.min(6, Math.max(1, value ?? 1)) as 1 | 2 | 3 | 4 | 5 | 6;
}

function hasUnclosedFence(text: string): boolean {
  let marker: string | undefined;
  for (const line of text.split("\n")) {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    if (!match) {
      continue;
    }
    const next = match[1] ?? "";
    if (!marker) {
      marker = next;
    } else if (next[0] === marker[0] && next.length >= marker.length) {
      marker = undefined;
    }
  }
  return Boolean(marker);
}

function hasUnclosedDisplayMath(text: string): boolean {
  const matches = text.match(/(^|[^\\])\$\$/g);
  return Boolean((matches?.length ?? 0) % 2);
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
  if (normalizedCwd) {
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
      const relativePath = normalizePath(pathOnly);
      insideWorkspace = relativePath !== ".." && !relativePath.startsWith("../");
      displayPath = pathOnly.replace(/^\.\//, "");
    }
  }
  return { raw, displayPath: `${displayPath}${location ?? ""}`, location, insideWorkspace };
}

function readInlineCode(text: string): { readonly value: string; readonly length: number } | undefined {
  if (!text.startsWith("`") || text.startsWith("```")) {
    return undefined;
  }
  const closingIndex = text.indexOf("`", 1);
  return closingIndex > 1 ? { value: text.slice(1, closingIndex), length: closingIndex + 1 } : undefined;
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
  return closingIndex > marker.length ? {
    children: splitInlineTokens(text.slice(marker.length, closingIndex), cwd, options),
    length: closingIndex + marker.length,
  } : undefined;
}

function readMarkdownLink(text: string, cwd?: string): { readonly token: MessageInlineToken; readonly length: number } | undefined {
  const match = markdownLinkPattern.exec(text);
  if (!match) {
    return undefined;
  }
  const label = match[1] ?? "";
  const destination = stripWrappingQuotes(match[2] ?? "");
  const webLink = readWebLink(destination);
  if (webLink?.href === destination) {
    return { token: { kind: "web_link", href: destination, label }, length: match[0].length };
  }
  if (isLikelyLocalPath(destination)) {
    return { token: { kind: "local_file", reference: parseLocalFileReference(destination, cwd) }, length: match[0].length };
  }
  return { token: { kind: "text", text: label }, length: match[0].length };
}

function readWebLink(text: string, bare = false): { readonly href: string } | undefined {
  const match = webUrlPattern.exec(text);
  if (!match) {
    return undefined;
  }
  const href = trimTrailingUrlPunctuation(bare ? trimBareUrlProse(match[0]) : match[0]);
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? { href } : undefined;
  } catch {
    return undefined;
  }
}

function trimBareUrlProse(value: string): string {
  const boundary = /[，。！？；：、\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.exec(value);
  return boundary && boundary.index > 0 ? value.slice(0, boundary.index) : value;
}

function readLocalPath(text: string, cwd?: string): LocalPathMatch | undefined {
  const match = /^(?:(?:~\/|\.{1,2}\/)[A-Za-z0-9._~@%+/#:-]+|\/[A-Za-z0-9._~@%+-][A-Za-z0-9._~@%+/#:-]*|(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.@+-][A-Za-z0-9._~@%+/#:-]*)/.exec(text);
  if (!match) {
    return undefined;
  }
  const raw = trimTrailingPathPunctuation(match[0]);
  return isLikelyLocalPath(raw) ? { raw, reference: parseLocalFileReference(raw, cwd) } : undefined;
}

function isLocalPathStartBoundary(previous: string | undefined): boolean {
  return previous === undefined || /\s/.test(previous) || "([{<\"'`|".includes(previous);
}

function isHtmlClosingTagPathStart(text: string, index: number): boolean {
  return text[index - 1] === "<" && /^\/[A-Za-z][A-Za-z0-9:-]*\s*>/.test(text.slice(index));
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
  return colonMatch ? { path: colonMatch[1] ?? "", location: colonMatch[2] } : { path: value };
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
  return ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) ? value.slice(1, -1) : value;
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
    } else {
      parts.push(rawPart);
    }
  }
  return `${absolute ? "/" : ""}${parts.join("/")}` || (absolute ? "/" : ".");
}
