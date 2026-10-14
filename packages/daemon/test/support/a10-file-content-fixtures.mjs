/**
 * Explicit request grammar for A10's deterministic, source-preserving selector.
 * Expected bytes are authored here, never recovered from a normalized request.
 * A fence's opening-line terminator is syntax; a payload's final terminator is
 * content. Inline legacy syntax intentionally does not require ambiguous spaces.
 */
export const a10Participants = Object.freeze([
  { id: "teammate_builtin_engineer", label: "Engineer", kind: "ai-teammate" },
  { id: "teammate_builtin_qa", label: "QA", kind: "ai-teammate" },
]);

const directSuffix = "；QA 验证文件内容。";
const handoffSuffix = "；QA 必须在 Engineer 完成后验证文件内容。";
const transitionSuffix = "；然后由 QA 验证文件内容。";

function literal({ name, target, content, fenced = false, language = "text", newline = "\n", suffix = directSuffix }) {
  const payload = fenced ? `\`\`\`${language}${newline}${content}\`\`\`${newline}` : content;
  return Object.freeze({
    name,
    target,
    content,
    source: "current_message",
    body: `@Engineer @QA 请创建 ${target}，文件内容必须逐字保留，内容如下：${newline}${payload}${suffix}`,
  });
}

export const a10CurrentLiteralFixtures = Object.freeze([
  literal({
    name: "unfenced LF retains internal lines and blank line",
    target: "a10-lines.txt",
    content: "alpha\n\n  beta  \ngamma",
    suffix: transitionSuffix,
  }),
  literal({
    name: "unfenced CRLF retains original line endings",
    target: "a10-crlf.txt",
    content: "alpha\r\n\r\n\tbeta\r\ngamma",
    newline: "\r\n",
  }),
  literal({
    name: "unfenced opener removes one delimiter newline but not indentation",
    target: "a10-indent.txt",
    content: "  alpha\n    beta\n\tgamma",
    suffix: handoffSuffix,
  }),
  literal({
    name: "fenced JavaScript strips syntax and retains code and final LF",
    target: "a10-code.js",
    content: "  const answer = 42;\n\nconsole.log(answer);\n",
    fenced: true,
    language: "js",
    suffix: handoffSuffix,
  }),
  literal({
    name: "fenced CRLF strips opener CRLF and retains payload CRLF",
    target: "a10-fenced-crlf.txt",
    content: "first\r\n\r\n\tsecond  \r\n",
    fenced: true,
    newline: "\r\n",
    suffix: transitionSuffix,
  }),
  literal({
    name: "fenced leading and trailing payload whitespace is content",
    target: "a10-edge.txt",
    content: "\n  alpha \t\n\n",
    fenced: true,
  }),
  literal({
    name: "verification-like text inside a fence is not a workflow suffix",
    target: "a10-fence-suffix.txt",
    content: "literal;QA verify this record\nnext line\n",
    fenced: true,
  }),
  literal({
    name: "ordinary punctuation inside unfenced literal is not a suffix",
    target: "a10-punctuation.txt",
    content: "alpha;keep literal\nbeta,still literal",
    suffix: ";QA verify file content.",
  }),
  literal({
    name: "multiline Unicode retains UTF-8 characters and final LF",
    target: "a10-unicode.txt",
    content: "你好，Ling\nemoji: 🧪\n路径文本 C:\\qa\\file\n",
  }),
]);

function recent({ name, target, content, newline = "\n", otherBlock = "" }) {
  return Object.freeze({
    name,
    target,
    content,
    source: "recent_code_block",
    priorBody: `${target} 的代码：${newline}${otherBlock}\`\`\`js${newline}${content}\`\`\`${newline}`,
    body: `@Engineer @QA 请创建 ${target}，采用本会话上面的代码；QA 必须在 Engineer 完成后验证文件内容。`,
  });
}

export const a10RecentCodeFixtures = Object.freeze([
  recent({
    name: "recent same-thread code retains indentation blank lines and final LF",
    target: "a10-recent.js",
    content: "  const answer = 42;\n\nconsole.log(answer);\n",
  }),
  recent({
    name: "recent same-thread code retains leading blank and CRLF",
    target: "a10-recent-crlf.js",
    content: "\r\n\tconst answer = 42;\r\nconsole.log(answer);\r\n\r\n",
    newline: "\r\n",
  }),
  recent({
    name: "matching recent code block retains bytes without taking the other language",
    target: "a10-matched.js",
    content: "  const answer = 42;\nconsole.log(answer);\n",
    otherBlock: "```text\nnot the JavaScript payload\n```\n",
  }),
]);

export const a10InlineFixture = Object.freeze({
  name: "legacy inline syntax has the original one-line payload",
  target: "a10-inline.txt",
  content: "inline-proof",
  source: "current_message",
  body: "@Engineer @QA 请创建 a10-inline.txt，内容为 inline-proof；QA 验证文件内容。",
});

export const a10OverBudgetFixture = literal({
  name: "oversized exact-QA literal keeps the 512-character command cap",
  target: "a10-over-budget.txt",
  content: "z".repeat(360),
});

export const a10CompressibleOverBudgetFixture = literal({
  name: "whitespace compression cannot make an oversized literal eligible for exact QA",
  target: "a10-compressible.txt",
  content: `start\n${" ".repeat(360)}\nend\n`,
  fenced: true,
});
