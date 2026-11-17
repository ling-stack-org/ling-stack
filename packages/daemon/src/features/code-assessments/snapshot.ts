import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, openSync, closeSync, readSync, realpathSync, fstatSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createTwoFilesPatch } from "diff";
import { redactSecrets } from "@ling-stack/core";
import { isCodeAssessmentPath, parseCodeAssessmentTarget } from "@ling-stack/contracts";
import type { CodeAssessmentSnapshot, CodeAssessmentSnapshotFile, CodeAssessmentTarget, CodeSnapshotExclusionReason } from "@ling-stack/contracts";
import { boundedGitDiff } from "../previews/workspace-changes.js";
import { git } from "../workspaces/managed-worktrees.js";

const gitPrefix = ["--literal-pathspecs", "--no-optional-locks", "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "submodule.recurse=false"];
const diffFlags = ["--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=none"];
const maxFiles = 80;
const maxDiffBytes = 256 * 1024;
const maxSourceBytes = 96 * 1024;
const emptyTreeSha = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function assessmentGitPrefix(cwd: string): Promise<readonly string[]> {
  const configured = await git(cwd, [...gitPrefix, "config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"])
    .then(result => result.stdout).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === 1) return "";
      throw error;
    });
  const filters = new Set<string>();
  for (const key of configured.split("\n").filter(Boolean)) {
    const match = /^(filter\.[^\r\n]+)\.(?:clean|smudge|process|required)$/iu.exec(key);
    if (!match) throw new Error("Git filter configuration is not supported for assessment capture.");
    filters.add(match[1]!);
  }
  return [...gitPrefix, ...[...filters].flatMap(name => ["-c", `${name}.clean=`, "-c", `${name}.smudge=`,
    "-c", `${name}.process=`, "-c", `${name}.required=false`])];
}

interface ChangedPath {
  readonly path: string;
  readonly originalPath?: string;
  readonly kind: CodeAssessmentSnapshotFile["kind"];
}

/** File contents with conventional credential names never enter a model snapshot. */
export function isSensitiveAssessmentPath(path: string): boolean {
  return path.split("/").some(part => /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.git|\.ling-stack|\.ssh|\.aws|\.gnupg|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/iu.test(part))
    || /\.(?:pem|key|p12|pfx|keystore)$/iu.test(path);
}

function redactAssessmentDiff(raw: string): string {
  const generic = redactSecrets(raw) as string;
  return generic
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|client[_-]?secret|secret)["']?\s*[:=]\s*)(["'`])([^\r\n]*?)\2/giu,
      (_match, prefix: string, quote: string) => `${prefix}${quote}[REDACTED]${quote}`)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
      block => block.split("\n").map(() => "[REDACTED]").join("\n"));
}

function parseNames(value: string): ChangedPath[] {
  const fields = value.split("\0");
  const result: ChangedPath[] = [];
  for (let index = 0; index < fields.length && fields[index];) {
    const status = fields[index++]!;
    const first = fields[index++];
    const renamed = status.startsWith("R") || status.startsWith("C");
    const path = renamed ? fields[index++] : first;
    if (!path || !first || !isCodeAssessmentPath(path) || !isCodeAssessmentPath(first)) {
      throw new Error("Git returned an unsupported file path.");
    }
    const kind = status.startsWith("A") ? "added" : status.startsWith("D") ? "deleted"
      : status.startsWith("R") ? "renamed" : status.startsWith("C") ? "copied"
      : status.startsWith("M") ? "modified" : "unknown";
    result.push({ path, ...(renamed ? { originalPath: first } : {}), kind });
  }
  return result;
}

function workingFile(cwd: string, path: string): { readonly content?: string; readonly excluded?: CodeSnapshotExclusionReason } {
  const full = join(cwd, path);
  const stat = lstatSync(full);
  if (!stat.isFile() || stat.isSymbolicLink()) return { excluded: "unsupported" };
  if (stat.size > maxSourceBytes) return { excluded: "truncated" };
  // Resolve parents as well as the final component; no symlink may leave this root.
  if (relative(cwd, realpathSync(full)).split(sep).join("/") !== path) return { excluded: "unsupported" };
  const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink > 1 || opened.size > maxSourceBytes || opened.ino !== stat.ino || opened.dev !== stat.dev) {
      return { excluded: "unsupported" };
    }
    const buffer = Buffer.alloc(maxSourceBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > maxSourceBytes) return { excluded: "truncated" };
    const bytes = buffer.subarray(0, size);
    return bytes.includes(0) ? { excluded: "binary" } : { content: bytes.toString("utf8") };
  } finally { closeSync(fd); }
}

async function capture(cwd: string, target: CodeAssessmentTarget): Promise<Omit<CodeAssessmentSnapshot, "id" | "capturedAt">> {
  const prefix = await assessmentGitPrefix(cwd);
  const readGit = async (root: string, args: readonly string[]) => (await git(root, [...prefix, ...args])).stdout;
  const root = realpathSync((await readGit(cwd, ["rev-parse", "--show-toplevel"])).trim());
  if (root !== realpathSync(cwd)) throw new Error("Open the repository root before starting an assessment.");
  const resolveCommit = async (ref: string) => (await readGit(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
  const headSha = await resolveCommit(target.type === "commit" ? target.commitSha : "HEAD");
  const branchName = target.type === "commit" ? undefined : (await readGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  let baseSha: string | undefined;
  if (target.type === "branch") baseSha = (await readGit(cwd, ["merge-base", headSha, await resolveCommit(target.baseRef)])).trim();
  if (target.type === "commit") {
    if (target.baseRef) baseSha = await resolveCommit(target.baseRef);
    else {
      // Raw headers retain parent identity even when shallow history hides it from traversal.
      const headers = (await readGit(cwd, ["cat-file", "-p", headSha])).split("\n\n", 1)[0]!;
      const parent = /^parent ([a-f0-9]{40})$/mu.exec(headers)?.[1];
      baseSha = parent ? await resolveCommit(parent) : emptyTreeSha;
    }
  }
  const revisions = baseSha ? [baseSha, headSha] : [headSha];
  const tracked = parseNames(await readGit(cwd, ["diff", ...diffFlags, "--name-status", "-z", "--find-renames", ...revisions, "--"]));
  const untracked = target.type === "working_tree"
    ? (await readGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean) : [];
  if (untracked.some(path => !isCodeAssessmentPath(path))) throw new Error("Git returned an unsupported file path.");
  const paths = new Map(tracked.map(file => [file.path, file]));
  for (const path of untracked) paths.set(path, { path, kind: "untracked" });
  const files: CodeAssessmentSnapshotFile[] = [];
  const exclusions: { path: string; reason: CodeSnapshotExclusionReason }[] = [];
  let bytes = 0;
  let unchanged = 0;
  for (const [index, file] of [...paths.values()].sort((a, b) => a.path.localeCompare(b.path)).entries()) {
    if (index >= maxFiles || bytes >= maxDiffBytes) { exclusions.push({ path: file.path, reason: "budget" }); continue; }
    if (isSensitiveAssessmentPath(file.path) || file.originalPath && isSensitiveAssessmentPath(file.originalPath)) {
      exclusions.push({ path: file.path, reason: "sensitive" }); continue;
    }
    let raw: string;
    if (file.kind === "untracked") {
      const result = workingFile(root, file.path);
      if (result.excluded) { exclusions.push({ path: file.path, reason: result.excluded }); continue; }
      const existsInHead = (await readGit(root, ["ls-tree", headSha, "--", file.path])).trim();
      if (/^120000|^160000/u.test(existsInHead)) { exclusions.push({ path: file.path, reason: "unsupported" }); continue; }
      const before = existsInHead ? await readGit(root, ["show", `${headSha}:${file.path}`]) : "";
      if (before.includes("\0")) { exclusions.push({ path: file.path, reason: "binary" }); continue; }
      if (before === result.content) { unchanged++; continue; }
      raw = createTwoFilesPatch(`a/${file.path}`, `b/${file.path}`, before, result.content!, undefined, undefined, { context: 3, timeout: 100 }) ?? "";
    } else {
      const preview = await boundedGitDiff(root, [...prefix, "diff", ...diffFlags, "--unified=3", ...revisions, "--",
        ...(file.originalPath ? [file.originalPath] : []), file.path]);
      if (preview.truncated) { exclusions.push({ path: file.path, reason: "truncated" }); continue; }
      raw = preview.diff;
    }
    if (!raw) { exclusions.push({ path: file.path, reason: "unsupported" }); continue; }
    if (/^Binary files |^GIT binary patch/mu.test(raw)) { exclusions.push({ path: file.path, reason: "binary" }); continue; }
    if (/^(?:old|new|deleted file|new file) mode 120000|^index .* (?:120000|160000)|^.*mode 160000|^Subproject commit /mu.test(raw)) {
      exclusions.push({ path: file.path, reason: "unsupported" }); continue;
    }
    if (Buffer.byteLength(raw) > maxSourceBytes || bytes + Buffer.byteLength(raw) > maxDiffBytes) {
      exclusions.push({ path: file.path, reason: "budget" }); continue;
    }
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(raw)) { exclusions.push({ path: file.path, reason: "sensitive" }); continue; }
    const diff = redactAssessmentDiff(raw);
    bytes += Buffer.byteLength(diff);
    files.push({ ...file, diff, contentDigest: hash(raw), redacted: raw !== diff });
  }
  const body = { target, ...(branchName ? { branchName } : {}), headSha, ...(baseSha ? { baseSha } : {}), files,
    totalFileCount: paths.size - unchanged, coverage: exclusions.length || files.some(file => file.redacted) ? "partial" as const : "complete" as const, exclusions };
  return { ...body, digest: hash(JSON.stringify(body)) };
}

/** Two equal captures reject edits during collection; excluded content cannot certify freshness. */
export async function captureCodeAssessmentSnapshot(cwd: string, input: CodeAssessmentTarget, capturedAt = new Date().toISOString()): Promise<CodeAssessmentSnapshot> {
  const target = parseCodeAssessmentTarget(input);
  const first = await capture(cwd, target);
  const second = await capture(cwd, target);
  if (first.digest !== second.digest) throw new Error("The repository changed during capture. Try again after edits finish.");
  return { ...second, id: `snapshot_${randomUUID()}`, capturedAt };
}
