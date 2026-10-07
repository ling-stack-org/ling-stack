import { createHash } from "node:crypto";
import { posix, resolve, win32 } from "node:path";
import { structuredPatch, formatPatch } from "diff";
import type { RunSession, RunStore } from "@ling-stack/core";
import type { WorkspaceChangeReview, WorkspaceChangeReviewFile, WorkspaceMutationRecord } from "@ling-stack/contracts";
import { redactTextWithSecrets } from "../../shared/redaction.js";
import { isRecord } from "../../shared/validation.js";
import { hashReviewContent, type WorkspaceReviewFileSnapshot } from "./workspace-review-snapshot.js";

const maxRecords = 2_000;
const maxDiffBytes = 512 * 1024;
const maxReviewBytes = 2 * 1024 * 1024;
const maxSnapshotBytes = 32 * 1024 * 1024;
const maxPaths = 128;

/** Read immutable Host snapshots, not current disk or Git status. GET performs no writes. */
export function buildWorkspaceChangeReview(store: RunStore, input: {
  readonly scope: WorkspaceChangeReview["scope"];
  readonly runs: readonly RunSession[];
  readonly threadId?: string;
  readonly workspaceId?: string;
  readonly turnId?: string;
}): WorkspaceChangeReview {
  const records: WorkspaceMutationRecord[] = [];
  for (const run of input.runs) {
    records.push(...store.listWorkspaceMutationRecords({ runId: run.id, limit: maxRecords + 1 - records.length }));
    if (records.length > maxRecords) break;
  }
  const workspaceId = input.workspaceId ?? (input.threadId ? store.getLingThread(input.threadId)?.workspaceId : undefined) ?? records[0]?.workspaceId ?? "";
  const revision = createHash("sha256").update(JSON.stringify([input.scope, records.map((record) => [record.id, record.provenanceSeq, record.beforeSha256, record.afterSha256, record.effectState])])).digest("hex");
  const base = { scope: input.scope, workspaceId, threadId: input.threadId, runIds: input.runs.map((run) => run.id), revision };
  const unavailable = (reason: string): WorkspaceChangeReview => ({ ...base, state: "unavailable", files: [], coveredPaths: [], unavailableReason: reason });
  if (!workspaceId || records.length === 0) return unavailable("No durable file-change snapshots are available for this work.");
  if (records.length > maxRecords) return unavailable("The historical change set exceeds its record budget.");
  if (new Set(input.runs.map((run) => resolve(run.cwd))).size !== 1) return unavailable("The requested work spans different working directories.");
  const runById = new Map(input.runs.map((run) => [run.id, run]));
  if (records.some((record) => {
    const run = runById.get(record.runId);
    return !run || record.workspaceId !== workspaceId || record.threadId !== run.threadId ||
      input.threadId && record.threadId !== input.threadId || input.turnId && record.turnId !== input.turnId ||
      resolve(record.cwd) !== resolve(run.cwd);
  })) return unavailable("File-change provenance does not match the requested conversation scope.");
  const ordered = [...records].sort((a, b) => a.provenanceSeq - b.provenanceSeq);
  const byPath = new Map<string, WorkspaceMutationRecord[]>();
  for (const record of ordered) {
    const path = reviewPathWithinCapturedCwd(record.cwd, record.path);
    if (!path) {
      return unavailable("File-change provenance includes a non-reviewable path.");
    }
    const changes = byPath.get(path) ?? [];
    changes.push(record);
    byPath.set(path, changes);
  }
  if (byPath.size > maxPaths) return unavailable("The historical change set exceeds its file budget.");
  let remainingBytes = maxReviewBytes;
  let snapshotBytes = 0;
  const snapshotCache = new Map<string, readonly WorkspaceReviewFileSnapshot[] | undefined>();
  const deadline = performance.now() + 750;
  const files: WorkspaceChangeReviewFile[] = [];
  for (const [path, changes] of byPath) {
    const id = createHash("sha256").update(JSON.stringify([input.scope, path])).digest("hex");
    const failed = (reason: string): WorkspaceChangeReviewFile => ({ id, path, kind: "modified", state: "unavailable", unavailableReason: reason });
    const snapshots: WorkspaceReviewFileSnapshot[] = [];
    let reason: string | undefined;
    for (const record of changes) {
      if (performance.now() > deadline) { reason = "Historical diff exceeded its computation budget."; break; }
      const artifactId = record.forwardPatchArtifactId;
      const cacheKey = `${record.runId}:${artifactId}`;
      if (!snapshotCache.has(cacheKey)) {
        const artifact = artifactId ? store.getArtifact(artifactId) : undefined;
        const sealed = artifact?.sealedPayload;
        const snapshot = isRecord(sealed) ? sealed.workspaceReviewSnapshot : undefined;
        const valid = artifact?.runId === record.runId && isRecord(snapshot) && snapshot.schemaVersion === 1 && snapshot.state === "exact" && Array.isArray(snapshot.files) && snapshot.files.length <= maxPaths
          && snapshot.files.every((file) => isRecord(file) && typeof file.path === "string" && (typeof file.before === "string" || file.before === null) && (typeof file.after === "string" || file.after === null));
        const entries = valid ? snapshot.files as unknown as readonly WorkspaceReviewFileSnapshot[] : undefined;
        snapshotBytes += entries?.reduce((sum, file) => sum + Buffer.byteLength(file.before ?? "", "utf8") + Buffer.byteLength(file.after ?? "", "utf8"), 0) ?? 0;
        if (snapshotBytes > maxSnapshotBytes) return unavailable("Historical snapshots exceed their read budget.");
        snapshotCache.set(cacheKey, entries);
      }
      const entries = snapshotCache.get(cacheKey);
      if (record.effectState !== "applied" || !entries) {
        reason = "A successful mutation has no complete historical diff snapshot.";
        break;
      }
      const matches = entries.filter((file) => file.path === record.path);
      const file = matches[0];
      if (matches.length !== 1 || !isRecord(file) || !(typeof file.before === "string" || file.before === null) || !(typeof file.after === "string" || file.after === null) ||
        hashReviewContent(file.before) !== record.beforeSha256 || hashReviewContent(file.after) !== record.afterSha256) {
        reason = "Historical content does not match its durable mutation fingerprints.";
        break;
      }
      const previous = snapshots.at(-1);
      if (previous && hashReviewContent(previous.after) !== record.beforeSha256) {
        reason = "File history has an intervening change outside this review scope.";
        break;
      }
      snapshots.push({ path, before: file.before, after: file.after });
    }
    if (reason) { files.push(failed(reason)); continue; }
    const before = snapshots[0]!.before;
    const after = snapshots.at(-1)!.after;
    if (before === after) continue; // Edited then restored is not a net changed file.
    if ((before ?? "").includes("\0") || (after ?? "").includes("\0")) {
      files.push(failed("Binary content has no text line statistics.")); continue;
    }
    const patch = structuredPatch(before === null ? "/dev/null" : `a/${path}`, after === null ? "/dev/null" : `b/${path}`,
      before ?? "", after ?? "", "", "", { context: 3, maxEditLength: 20_000, timeout: 100 });
    if (!patch) { files.push(failed("Historical diff exceeded its computation budget.")); continue; }
    const diff = redactTextWithSecrets(`diff --git a/${path} b/${path}\n${formatPatch(patch)}`);
    const bytes = Buffer.byteLength(diff, "utf8");
    if (bytes > maxDiffBytes || bytes > remainingBytes) { files.push(failed("Historical diff exceeds its display budget.")); continue; }
    remainingBytes -= bytes;
    const lines = patch.hunks.flatMap((hunk) => hunk.lines);
    files.push({ id, path, kind: before === null ? "added" : after === null ? "deleted" : "modified", state: "exact", diff,
      additions: lines.filter((line) => line.startsWith("+")).length,
      deletions: lines.filter((line) => line.startsWith("-")).length });
  }
  const exact = files.every((file) => file.state === "exact");
  return { ...base, files, coveredPaths: [...byPath.keys()], state: exact ? "exact" : files.some((file) => file.state === "exact") ? "partial" : "unavailable",
    ...(exact ? { additions: files.reduce((sum, file) => sum + file.additions!, 0), deletions: files.reduce((sum, file) => sum + file.deletions!, 0) }
      : { unavailableReason: "Some file changes cannot be reconstructed exactly; no aggregate statistics are shown." }) };
}

/**
 * Canonicalize display/group identity only, using the captured cwd and its OS
 * path semantics. No disk, symlink or Git lookup is needed. Raw record paths
 * remain authoritative for snapshot identity and fingerprint validation.
 */
function reviewPathWithinCapturedCwd(cwd: string, path: string): string | undefined {
  if (!cwd || !path || /[\0\r\n]/u.test(cwd) || /[\0\r\n]/u.test(path)) return undefined;
  const driveAbsolute = /^[A-Za-z]:[\\/]/u;
  const uncAbsolute = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u;
  const devicePath = /^[\\/]{2}[?.](?:[\\/]|$)/u;
  if (devicePath.test(cwd) || devicePath.test(path)) return undefined;
  const windows = driveAbsolute.test(cwd) || uncAbsolute.test(cwd);
  const paths = windows ? win32 : posix;
  if (!windows && (!posix.isAbsolute(cwd) || cwd.includes("\\"))) return undefined;
  if (windows) {
    const absolute = driveAbsolute.test(path) || uncAbsolute.test(path);
    // A drive-relative or rooted-without-drive path depends on ambient process
    // state; do not reinterpret it as a captured-root historical file identity.
    if ((/^[A-Za-z]:/u.test(path) || /^[\\/]/u.test(path)) && !absolute) return undefined;
  } else if (path.includes("\\") || /^[A-Za-z]:/u.test(path)) {
    // Backslash is a POSIX filename character, not a separator. Fail closed
    // rather than aliasing it to a different path in the slash-based review UI.
    return undefined;
  }
  const unsafeSegments = (value: string): boolean => value.split(windows ? /[\\/]/u : /\//u).some((part, index) =>
    part === ".." || part.toLowerCase() === ".ling-stack" || windows && part !== "." &&
      (/[. ]$/u.test(part) || part.includes(":") && !(index === 0 && /^[A-Za-z]:$/u.test(part))));
  // macOS commonly ignores case. Windows additionally aliases trailing dots /
  // spaces and uses colons for streams. These are not safe display identities.
  if (unsafeSegments(cwd) || unsafeSegments(path)) return undefined;
  const relativePath = paths.relative(paths.resolve(cwd), paths.resolve(cwd, path));
  if (!relativePath || paths.isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${paths.sep}`)) return undefined;
  return windows ? relativePath.replace(/\\/gu, "/") : relativePath;
}
