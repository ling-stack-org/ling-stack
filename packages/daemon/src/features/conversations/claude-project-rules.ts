import { posix, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";

export function readClaudeRule(source: string): { readonly text: string; readonly pathPatterns?: readonly string[] } | undefined {
  const lines = source.split(/\r?\n/u);
  if (lines[0]?.trimEnd() !== "---") return { text: source };
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (end < 0) return undefined;
  try {
    const header = parseDocument(lines.slice(1, end).join("\n"), { uniqueKeys: true });
    if (header.errors.length) return undefined;
    const parsed: unknown = header.toJS({ maxAliasCount: 0 });
    if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) return undefined;
    const paths: unknown = (parsed as { paths?: unknown } | null)?.paths;
    const text = lines.slice(end + 1).join("\n");
    if (paths === undefined) return { text };
    if (!Array.isArray(paths) || !paths.length || paths.length > 32 || paths.some(pattern => !validPattern(pattern))) return undefined;
    return { text, pathPatterns: paths };
  } catch {
    return undefined;
  }
}

function validPattern(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160 && !value.startsWith("/")
    && !/[\\{}()!:\x00-\x1f]/u.test(value)
    && value.split("/").every(part => part && part !== "." && part !== "..");
}

export function claudeRuleApplies(patterns: readonly string[] | undefined, paths: readonly string[]): boolean {
  return !patterns || paths.some(path => patterns.some(pattern =>
    path === pattern || path.startsWith(pattern + "/") || posix.matchesGlob(path, pattern)));
}

export function ruleTargetPaths(root: string, paths: readonly string[]): string[] {
  return paths.map(path => relative(root, resolve(root, path)).split(sep).join("/") || ".")
    .filter(path => path !== ".." && !path.startsWith("../"));
}
