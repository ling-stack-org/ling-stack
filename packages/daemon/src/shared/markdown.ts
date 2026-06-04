export function parseMarkdownFrontmatter(content: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const parsed = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (parsed) {
      result[parsed[1] ?? ""] = (parsed[2] ?? "").replace(/^["']|["']$/g, "").trim();
    }
  }
  return result;
}

export function firstMarkdownParagraph(content: string): string | undefined {
  return content
    .replace(/^---\r?\n[\s\S]*?\r?\n---/, "")
    .split(/\r?\n\r?\n/)
    .map((block) => block.replace(/^#+\s+.*/gm, "").trim())
    .find((block) => block.length > 0)
    ?.slice(0, 300);
}

export function extractMarkdownTitle(content: string): string | undefined {
  const line = content.split(/\r?\n/).find((item) => /^#\s+\S/.test(item));
  const title = line?.replace(/^#\s+/, "").trim();
  return title || undefined;
}
