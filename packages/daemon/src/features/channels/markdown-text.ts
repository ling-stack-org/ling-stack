/**
 * Normalize transport line endings without changing Markdown structure.
 *
 * User and agent bodies are rendered as Markdown later. Collapsing all
 * whitespace here destroys paragraph, list, and fenced-code boundaries, so
 * this helper only removes noisy trailing spaces and excessive blank lines.
 */
export function preserveMarkdownLayout(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/gu, ""))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/^\n+/u, "")
    .replace(/\n+$/u, "");
}

/**
 * Bound a user-visible Markdown body while preserving its paragraph and code
 * layout for the shared conversation renderer.
 */
export function boundedMarkdownText(value: string, maxCharacters: number): string {
  const normalized = preserveMarkdownLayout(value);
  if (normalized.length <= maxCharacters) {
    return normalized;
  }
  const suffix = "...";
  const limit = Math.max(0, maxCharacters - suffix.length);
  return `${normalized.slice(0, limit).trimEnd()}${suffix}`;
}
