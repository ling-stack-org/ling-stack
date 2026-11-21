import { createHash } from "node:crypto";
import { posix } from "node:path";
import { isCodeAssessmentPath, type CodeAssessmentReviewRules, type CodeAssessmentSnapshot } from "@ling-stack/contracts";
import { redactSecrets } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { isolatedGit } from "../workspaces/managed-worktrees.js";

const maxScopes = 24;
const maxRuleBytes = 24 * 1024;
const maxGuidanceBytes = 32 * 1024;

export function parseReviewRuleRefs(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxScopes || !value.every(path =>
    typeof path === "string" && isCodeAssessmentPath(path) && posix.basename(path) === "REVIEW.md")) {
    throw new HttpError(400, "invalid_params", "Review rule references must be repository-relative REVIEW.md paths.");
  }
  return [...new Set<string>(value)].sort();
}

export async function readBaselineReviewRules(
  cwd: string, snapshot: CodeAssessmentSnapshot, refs: readonly string[] = [],
): Promise<CodeAssessmentReviewRules | undefined> {
  const baseSha = snapshot.baseSha ?? snapshot.headSha;
  if (!baseSha) return undefined;
  const scopes = new Set(["."]);
  for (const file of snapshot.files) {
    for (const path of [file.path, file.originalPath]) {
      if (!path) continue;
      for (let scope = posix.dirname(path); scope !== "."; scope = posix.dirname(scope)) scopes.add(scope);
    }
  }
  const ordered = [...scopes].sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
  const selected = ordered.slice(0, maxScopes);
  const namesByScope = selected.map(scope => ["AGENTS.override.md", "AGENTS.md"].map(name => posix.join(scope, name)));
  const paths = [...namesByScope.flat(), ...refs.filter(path => selected.includes(posix.dirname(path)))];
  const { stdout } = await isolatedGit(cwd, ["ls-tree", "-z", baseSha, "--", ...paths]);
  const objects = new Map<string, { mode: string; id: string }>();
  for (const line of stdout.split("\0")) {
    const entry = /^(\d+) \S+ ([a-f0-9]{40,64})\t(.+)$/u.exec(line);
    if (entry) objects.set(entry[3]!, { mode: entry[1]!, id: entry[2]! });
  }
  const omitted = [...ordered.slice(maxScopes)];
  const sources: CodeAssessmentReviewRules["sources"][number][] = [];
  let remaining = maxGuidanceBytes;
  const rulePaths = [...namesByScope.flatMap(names => names.find(path => objects.has(path)) ?? []), ...refs];
  for (const path of rulePaths) {
    const object = objects.get(path);
    if (!object || (object.mode !== "100644" && object.mode !== "100755") || !remaining
      || Number((await isolatedGit(cwd, ["cat-file", "-s", object.id])).stdout) > maxRuleBytes) {
      omitted.push(path);
      continue;
    }
    const content = (await isolatedGit(cwd, ["cat-file", "blob", object.id])).stdout;
    const section = posix.basename(path) === "REVIEW.md" ? content.trim() : codeReviewSection(content);
    if (!section) continue;
    const guidance = redactSecrets(section) as string;
    const size = Buffer.byteLength(guidance);
    if (size > remaining || guidance.includes("\0") || /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(guidance)) {
      omitted.push(path);
      continue;
    }
    remaining -= size;
    sources.push({ path, scope: posix.dirname(path), digest: createHash("sha256").update(content).digest("hex"), guidance });
  }
  return sources.length || omitted.length ? { baseSha, sources, omitted } : undefined;
}

function codeReviewSection(content: string): string {
  const lines = content.split(/\r?\n/u);
  let depth: number | undefined;
  let fence: string | undefined;
  const section: string[] = [];
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker && !fence) fence = marker;
    else if (marker && fence && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    const header = fence || marker ? null : /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (depth !== undefined) {
      if (header && header[1]!.length <= depth) break;
      section.push(line);
    } else if (header?.[2]?.toLowerCase() === "code review rules") {
      depth = header[1]!.length;
    }
  }
  return section.join("\n").trim();
}
