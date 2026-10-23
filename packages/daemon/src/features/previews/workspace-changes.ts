import { createHash } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import type { ServerResponse } from "node:http";
import type { WorkspaceChangeFile, WorkspaceChangesResponse, WorkspaceGitStatusFile } from "@ling-stack/contracts";
import { writeJson } from "../../shared/response.js";
import { inspectWorkspaceGitStatus } from "../channels/git-status.js";
import { git } from "../workspaces/managed-worktrees.js";
import { resolveWorkspaceFileTarget, WorkspaceFileTargetError } from "./workspace-file-preview.js";
import { defineProtectedHostActorEntry } from "../../runtime/sandbox/protected-host-actor-inventory.js";

/** Original bounded diff producer. Git configuration and process exit do not certify a read-only protection profile. */
export const WORKSPACE_CHANGES_GIT_ACTOR_ENTRY = defineProtectedHostActorEntry("workspace_changes_git",
  (cwd: string, args: readonly string[]) => spawn("git", [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] }));

const maxChangedFiles = 160;
const maxDiffBytesPerFile = 96 * 1024;
const changedFileInspectionConcurrency = 8;

export async function handleGetWorkspaceChanges(response: ServerResponse, url: URL): Promise<void> {
  const cwd = url.searchParams.get("cwd")?.trim();
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    writeJson(response, 200, await inspectWorkspaceChanges(cwd, new Date().toISOString(), url.searchParams.get("baseline") === "head"));
  } catch (error) {
    writeJson(response, 400, {
      error: "workspace_changes_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function inspectWorkspaceChanges(cwd: string, checkedAt: string, netFromHead = false): Promise<WorkspaceChangesResponse> {
  const status = await inspectWorkspaceGitStatus(cwd, checkedAt);
  if (status.state !== "dirty") {
    return {
      cwd: status.cwd,
      state: status.state,
      repoRoot: status.repoRoot,
      branchName: status.branchName,
      upstream: status.upstream,
      headSha: status.headSha,
      additions: 0,
      deletions: 0,
      files: [],
      totalFileCount: 0,
      truncated: false,
      checkedAt: status.checkedAt,
      unavailableReason: status.unavailableReason,
      errorMessage: status.errorMessage,
    };
  }

  const inspectionRoot = status.repoRoot ?? cwd;
  const statusFiles = netFromHead ? [...new Map(status.files.map((file) => [file.path, file])).values()] : status.files;
  const selectedStatusFiles = statusFiles.slice(0, maxChangedFiles);
  const inspectedFiles = await mapWithConcurrency(
    selectedStatusFiles,
    changedFileInspectionConcurrency,
    (file) => inspectChangedFile(inspectionRoot, file, netFromHead, Boolean(status.headSha)),
  );
  const files = netFromHead ? inspectedFiles.filter((file) => file.diff || file.truncated) : inspectedFiles;
  return {
    cwd: status.cwd,
    state: status.state,
    repoRoot: status.repoRoot,
    branchName: status.branchName,
    upstream: status.upstream,
    headSha: status.headSha,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    files,
    totalFileCount: netFromHead ? files.length + Math.max(0, statusFiles.length - selectedStatusFiles.length) : status.files.length,
    truncated: selectedStatusFiles.length < statusFiles.length || (netFromHead && files.some((file) => file.truncated)),
    checkedAt: status.checkedAt,
  };
}

async function inspectChangedFile(cwd: string, file: WorkspaceGitStatusFile, netFromHead = false, hasHead = true): Promise<WorkspaceChangeFile> {
  const inspected = file.untracked || (netFromHead && !hasHead)
    ? netFromHead && hasHead ? await netUntrackedFileDiff(cwd, file.path) : untrackedFileDiff(cwd, file.path, netFromHead)
    : await trackedFileDiff(cwd, file, netFromHead);
  const bounded = truncateUtf8(inspected.diff, maxDiffBytesPerFile);
  return {
    path: file.path,
    originalPath: file.originalPath,
    kind: file.kind,
    staged: file.staged,
    unstaged: file.unstaged,
    untracked: file.untracked,
    additions: inspected.additions,
    deletions: inspected.deletions,
    diff: bounded.text || undefined,
    truncated: inspected.truncated || bounded.truncated,
  };
}

interface InspectedDiff {
  readonly diff: string;
  readonly additions: number;
  readonly deletions: number;
  readonly truncated: boolean;
}

async function netUntrackedFileDiff(cwd: string, path: string): Promise<InspectedDiff> {
  const before = await git(cwd, ["show", `HEAD:${path}`]).then((result) => result.stdout).catch((error) => {
    // Only a missing HEAD path is a new file. Other read failures must remain failures.
    if (/does not exist in|exists on disk, but not in/.test(String(error))) return undefined;
    throw error;
  });
  if (before === undefined) return untrackedFileDiff(cwd, path, true);
  const target = resolveWorkspaceFileTarget(cwd, path);
  const size = statSync(target.contentPath).size;
  if (size > maxDiffBytesPerFile || Buffer.byteLength(before) > maxDiffBytesPerFile) {
    return { diff: "", additions: 0, deletions: 0, truncated: true };
  }
  const descriptor = openSync(target.contentPath, "r");
  const content = Buffer.alloc(size);
  try { readSync(descriptor, content, 0, size, 0); } finally { closeSync(descriptor); }
  if (content.includes(0) || before.includes("\0")) {
    const blobSha = (await git(cwd, ["rev-parse", `HEAD:${path}`])).stdout.trim();
    const contentSha = createHash(blobSha.length === 64 ? "sha256" : "sha1")
      .update(Buffer.from(`blob ${content.length}\0`)).update(content).digest("hex");
    return blobSha === contentSha ? emptyDiff()
      : { diff: `Binary file changed: ${path}`, additions: 0, deletions: 0, truncated: false };
  }
  const after = content.toString("utf8");
  if (before === after) return emptyDiff();
  const patch = createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after, undefined, undefined, { context: 3, timeout: 100 });
  if (!patch) return { diff: "", additions: 0, deletions: 0, truncated: true };
  return { diff: patch, ...diffStats(patch), truncated: false };
}

async function trackedFileDiff(cwd: string, file: WorkspaceGitStatusFile, netFromHead = false): Promise<InspectedDiff> {
  const paths = file.originalPath ? [file.originalPath, file.path] : [file.path];
  const modes: readonly (readonly string[])[] = netFromHead ? [["HEAD"]] : [
    ...(file.staged ? [["--cached"]] : []),
    ...(file.unstaged ? [[]] : []),
  ];
  const layers = await Promise.all((modes.length > 0 ? modes : [["HEAD"]]).map((mode) => trackedDiffLayer(cwd, mode, paths)));
  return {
    diff: layers.map((layer) => layer.diff).filter(Boolean).join("\n"),
    additions: layers.reduce((sum, layer) => sum + layer.additions, 0),
    deletions: layers.reduce((sum, layer) => sum + layer.deletions, 0),
    truncated: layers.some((layer) => layer.truncated),
  };
}

async function trackedDiffLayer(cwd: string, mode: readonly string[], paths: readonly string[]): Promise<InspectedDiff> {
  const preview = await boundedGitDiff(cwd, ["diff", ...mode, "--no-ext-diff", "--no-color", "--unified=3", "--", ...paths]);
  const stats = await git(cwd, ["diff", ...mode, "--numstat", "--", ...paths])
    .then((result) => numstat(result.stdout))
    .catch(() => diffStats(preview.diff));
  return {
    diff: preview.diff,
    additions: stats.additions,
    deletions: stats.deletions,
    truncated: preview.truncated,
  };
}

function boundedGitDiff(cwd: string, args: readonly string[]): Promise<{ readonly diff: string; readonly truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = WORKSPACE_CHANGES_GIT_ACTOR_ENTRY.invoke(undefined, cwd, args);
    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;
    let stderrBytes = 0;
    let truncated = false;

    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = maxDiffBytesPerFile - capturedBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const captured = chunk.subarray(0, remaining);
      chunks.push(captured);
      capturedBytes += captured.length;
      truncated ||= captured.length < chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = 64 * 1024 - stderrBytes;
      if (remaining > 0) {
        const captured = chunk.subarray(0, remaining);
        stderrChunks.push(captured);
        stderrBytes += captured.length;
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderrChunks).toString("utf8").trim() || `git diff exited with code ${code ?? "unknown"}`));
        return;
      }
      resolve({ diff: Buffer.concat(chunks).toString("utf8"), truncated });
    });
  });
}

function numstat(value: string): { readonly additions: number; readonly deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of value.split(/\r?\n/gu)) {
    const [added, deleted] = line.split("\t", 3);
    const parsedAdded = Number.parseInt(added ?? "", 10);
    const parsedDeleted = Number.parseInt(deleted ?? "", 10);
    additions += Number.isFinite(parsedAdded) ? parsedAdded : 0;
    deletions += Number.isFinite(parsedDeleted) ? parsedDeleted : 0;
  }
  return { additions, deletions };
}

function untrackedFileDiff(cwd: string, path: string, preserveOpaque = false): InspectedDiff {
  let target: ReturnType<typeof resolveWorkspaceFileTarget>;
  try {
    target = resolveWorkspaceFileTarget(cwd, path);
  } catch (error) {
    if (error instanceof WorkspaceFileTargetError) {
      return { ...emptyDiff(), truncated: preserveOpaque };
    }
    throw error;
  }
  const stats = statSync(target.contentPath);
  if (!stats.isFile()) {
    return emptyDiff();
  }
  const maxSourceBytes = maxDiffBytesPerFile;
  const content = Buffer.alloc(Math.min(stats.size, maxSourceBytes));
  const descriptor = openSync(target.contentPath, "r");
  try {
    readSync(descriptor, content, 0, content.length, 0);
  } finally {
    closeSync(descriptor);
  }
  if (content.includes(0)) {
    return { ...emptyDiff(), diff: `Binary file changed: ${path}` };
  }
  const text = content.toString("utf8");
  const lines = text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const diff = [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
  return {
    diff,
    additions: lines.length,
    deletions: 0,
    truncated: stats.size > content.length,
  };
}

function emptyDiff(): InspectedDiff {
  return { diff: "", additions: 0, deletions: 0, truncated: false };
}

function diffStats(diff: string): { readonly additions: number; readonly deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/gu)) {
    if (line.startsWith("+") && !/^\+\+\+\s/u.test(line)) {
      additions += 1;
    } else if (line.startsWith("-") && !/^---\s/u.test(line)) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

function truncateUtf8(value: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= maxBytes) {
    return { text: value, truncated: false };
  }
  const buffer = Buffer.from(value, "utf8").subarray(0, maxBytes);
  return { text: buffer.toString("utf8"), truncated: true };
}

async function mapWithConcurrency<Input, Output>(
  items: readonly Input[],
  concurrency: number,
  mapper: (item: Input) => Promise<Output>,
): Promise<readonly Output[]> {
  const results = new Array<Output>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, concurrency));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index] as Input);
    }
  }));
  return results;
}
