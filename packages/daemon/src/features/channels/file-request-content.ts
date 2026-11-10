/** Literal payload parsing only; intent, target resolution and authority stay in the selector. */
export interface FileRequestCodeBlock {
  readonly language: string;
  readonly content: string;
}

export type FileRequestContentIssue = "unclosed_fence" | "unbound_trailing_content" | "empty_content";
export type RequestedFileContent =
  | { readonly status: "absent" }
  | { readonly status: "literal"; readonly content: string; readonly instructionText: string }
  | { readonly status: "unresolved"; readonly issue: FileRequestContentIssue };

/**
 * Keep authored bytes separate from the normalized text used to classify intent.
 * For an explicit multiline payload, consume only its one opening delimiter
 * newline. Inline requests retain the historical surrounding-whitespace rule.
 */
export function parseRequestedFileContent(text: string): RequestedFileContent {
  const marker = /(?:内容是|内容为|写入|写成|改成|如下|content\s*(?:is|:)|with\s+content)[\t ]*[:：]?[\t ]*/iu.exec(text);
  if (!marker) return { status: "absent" };
  const instructionPrefix = text.slice(0, marker.index);
  const remainder = text.slice(marker.index + marker[0].length);
  const multiline = /^(?:\r\n|\n)/u.exec(remainder);
  const payload = multiline ? remainder.slice(multiline[0].length) : remainder;

  // A closed fence is an explicit payload boundary. Do not apply workflow
  // suffix rules inside it: `;QA verify…` can be literal file content.
  const fence = readCodeFence(payload, 0);
  if (fence) {
    const trailing = payload.slice(fence.end);
    if (stripVerificationSuffix(trailing).trim()) {
      return { status: "unresolved", issue: "unbound_trailing_content" };
    }
    return fence.content.trim()
      ? { status: "literal", content: fence.content, instructionText: `${instructionPrefix}\n${trailing}` }
      : { status: "unresolved", issue: "empty_content" };
  }
  if (/^[\t ]*```/u.test(payload)) return { status: "unresolved", issue: "unclosed_fence" };

  const content = stripVerificationSuffix(payload);
  const literal = multiline ? content : content.trim();
  return literal.trim()
    ? { status: "literal", content: literal, instructionText: `${instructionPrefix}\n${payload.slice(content.length)}` }
    : { status: "unresolved", issue: "empty_content" };
}

/** Return code-block bytes untouched; trim is only a non-empty eligibility check. */
export function extractMarkdownCodeBlocks(text: string): readonly FileRequestCodeBlock[] {
  const blocks: FileRequestCodeBlock[] = [];
  const opener = /^```([a-z0-9_-]*)[^\r\n]*\r?\n/gimu;
  for (let match = opener.exec(text); match; match = opener.exec(text)) {
    const fence = readCodeFence(text, match.index);
    if (!fence) continue;
    if (fence.content.trim()) blocks.push({ language: fence.language, content: fence.content });
    opener.lastIndex = fence.end;
  }
  return blocks;
}

/** Opening-line newline is syntax; the content's newline before the closer is not. */
function readCodeFence(text: string, start: number): (FileRequestCodeBlock & { readonly end: number }) | undefined {
  const opener = /^```([a-z0-9_-]*)[^\r\n]*\r?\n/iu.exec(text.slice(start));
  if (!opener) return undefined;
  const contentStart = start + opener[0].length;
  const closer = /^[\t ]*```[\t ]*(?:\r?\n|$)/gmu;
  closer.lastIndex = contentStart;
  const match = closer.exec(text);
  if (!match) return undefined;
  return {
    language: (opener[1] ?? "").toLowerCase(),
    content: text.slice(contentStart, match.index),
    end: match.index + match[0].length,
  };
}

/** Only existing delimited handoff/verification clauses are request syntax. */
function stripVerificationSuffix(content: string): string {
  return content
    .replace(/(?:，|,|；|;)\s*(?:然后|接着|再|and\s+then|then)\s*(?:由\s+[^，。；;!?！？]{0,40}?\s*)?(?:运行|执行|跑|读取|读一下|查看|验证|测试|检查|run|execute|read|inspect|verify|test|check)[\s\S]*$/iu, "")
    .replace(/(?:，|,|；|;)\s*(?:由\s*)?(?:@?[\p{L}\p{N}_-]+)\s*(?:运行|执行|跑|读取|读一下|查看|验证|测试|检查|run|execute|read|inspect|verify|test|check)[\s\S]*$/iu, "")
    .replace(/(?:，|,|；|;)\s*(?:由\s*)?(?:@?[\p{L}\p{N}_-]+)\s*(?:(?:必须|需要|应当|应该|要|需).{0,40}?|must\s+|should\s+)?(?:在[^，。；;!?！？]{0,60}?(?:完成|写入|之后|后)\s*)?(?:运行|执行|跑|读取|读一下|查看|验证|测试|检查|run|execute|read|inspect|verify|test|check)[\s\S]*$/iu, "");
}
