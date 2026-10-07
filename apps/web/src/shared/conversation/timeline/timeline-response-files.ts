import { isUserVisibleTerminalReportArtifact, isUserVisibleTerminalReportSourceRef, visibleTerminalReportTimelineItem } from "@ling-stack/conversation-ui-core";
import type { ConversationOperationSourceRef, ConversationTimelineFileChangeItem } from "@ling-stack/conversation-ui-core";
import type { ConversationTimelineResponse } from "./timeline-response-presentation.js";
import type { ConversationWorkspaceRecoveryTarget } from "@ling-stack/conversation-ui-core";
import type { WorkspaceChangeReview, WorkspaceChangeReviewFile } from "@ling-stack/contracts";

export function timelineResponseRecoveryTarget(response: ConversationTimelineResponse, depth: 0 | 1): ConversationWorkspaceRecoveryTarget | undefined {
  const runId = response.message?.runId ?? response.report?.runId ?? response.items.find((item) => item.runId)?.runId;
  if (depth === 1) return runId ? { kind: "run", id: runId } : undefined;
  const workflows = new Set([...(response.report?.sourceRefs ?? []), ...(response.report?.outcomeSourceRefs ?? [])].filter((ref) => ref.kind === "workflow").map((ref) => ref.id));
  if (workflows.size === 1) return { kind: "workflow", id: [...workflows][0]! };
  const turnId = response.report?.turnId ?? response.message?.turnId;
  return turnId ? { kind: "turn", id: turnId } : runId ? { kind: "run", id: runId } : undefined;
}

/** Display filtering never manufactures a diff or treats unknown lines as zero. */
export function projectTimelineResponseReview(response: ConversationTimelineResponse, review: WorkspaceChangeReview | undefined): WorkspaceChangeReview | undefined {
  if (!review) return undefined;
  const pathKey = responseFilePathIdentity(response);
  const visible = projectTimelineResponseFiles(response);
  const declaredPaths = [...(response.report?.changes ?? []).flatMap((change) => change.paths), ...response.items.flatMap((item) => item.kind === "fileChange" ? item.files.flatMap((file) => file.fileRef.path ? [file.fileRef.path] : []) : [])];
  const visiblePaths = new Set(visible.map((file) => pathKey(file.path)));
  const hidden = new Set(declaredPaths.map(pathKey).filter((path) => !visiblePaths.has(path)));
  const permitted = (path: string): boolean => !hidden.has(pathKey(path)) && isUserVisibleTerminalReportArtifact({ id: path, title: "", path, sourceRefs: response.report?.sourceRefs ?? [] });
  const coveredPaths = review.coveredPaths.filter(permitted);
  const covered = new Set(coveredPaths.map(pathKey));
  const files: WorkspaceChangeReviewFile[] = review.files.filter((file) => permitted(file.path));
  for (const file of visible) {
    if (!covered.has(pathKey(file.path))) files.push({ id: `unknown:${file.path}`, path: file.path, kind: "modified", state: "unavailable", unavailableReason: review.unavailableReason ?? "Historical diff evidence is unavailable for this file." });
  }
  const exact = review.state === "exact" && files.every((file) => file.state === "exact" && validCount(file.additions) && validCount(file.deletions));
  const { additions: _additions, deletions: _deletions, ...base } = review;
  return { ...base, coveredPaths, files, state: exact ? "exact" : files.some((file) => file.state === "exact") ? "partial" : "unavailable",
    ...(exact ? { additions: files.reduce((sum, file) => sum + file.additions!, 0), deletions: files.reduce((sum, file) => sum + file.deletions!, 0) } : {}) };
}

export interface ConversationResponseFile {
  readonly path: string;
  readonly fileRef: ConversationOperationSourceRef;
  readonly item?: ConversationTimelineFileChangeItem;
  readonly additions?: number;
  readonly deletions?: number;
  readonly diffRef?: ConversationOperationSourceRef;
  readonly diffs?: readonly {
    readonly ref: ConversationOperationSourceRef;
    readonly item: ConversationTimelineFileChangeItem;
  }[];
}

const normalizePath = (path: string): string => path.replace(/\\/gu, "/").replace(/^\.\//u, "");
const validCount = (value: number | undefined): value is number => value !== undefined && Number.isSafeInteger(value) && value >= 0;

/** Join aliases only through Host file identity, never basename or an ambient cwd. */
function responseFilePathIdentity(response: ConversationTimelineResponse): (path: string) => string {
  const targets = response.items.flatMap((item) => item.kind === "fileChange" && item.status === "succeeded"
    ? item.files.flatMap((file) => file.fileRef.path ? [{ id: file.fileRef.id, path: normalizePath(file.fileRef.path), actionId: item.actionId }] : [])
    : []);
  const candidates = new Map<string, Set<string>>();
  for (const change of response.report?.changes ?? []) {
    const fileIds = new Set(change.sourceRefs.filter((ref) => ref.kind === "file").map((ref) => ref.id));
    const actionIds = new Set(change.sourceRefs.filter((ref) => ref.kind === "operation").map((ref) => ref.id));
    for (const path of change.paths) {
      const key = normalizePath(path);
      if (!key || /^(?:\/|[a-z]:)/iu.test(key) || key.split("/").some((part) => !part || part === "." || part === "..")) continue;
      for (const target of targets) {
        if (!fileIds.has(target.id) || (actionIds.size > 0 && !actionIds.has(target.actionId)) ||
          (target.path !== key && !target.path.endsWith(`/${key}`))) continue;
        const matches = candidates.get(key) ?? new Set<string>();
        matches.add(target.path);
        candidates.set(key, matches);
      }
    }
  }
  return (path) => {
    const key = normalizePath(path);
    const matches = candidates.get(key);
    return matches?.size === 1 ? [...matches][0]! : key;
  };
}

/** Applied facts only. Unknown or repeat-edit totals must not pretend to be net diff. */
export function projectTimelineResponseFiles(response: ConversationTimelineResponse): readonly ConversationResponseFile[] {
  const pathKey = responseFilePathIdentity(response);
  const report = response.report ? visibleTerminalReportTimelineItem(response.report) : undefined;
  const visibleReportPaths = new Set(report?.changes.flatMap((change) => change.paths).map(pathKey));
  const hiddenPaths = new Set(response.report?.changes.flatMap((change) => change.paths.map(pathKey)
    .filter((path) => change.sourceRefs.some((ref) => ref.visibility === "private" || ref.visibility === "developer_only" ||
      ref.visibility === "audit" || ref.sensitivity === "secret_adjacent") || !visibleReportPaths.has(path))));
  const files = new Map<string, ConversationResponseFile>();
  const seenActions = new Set<string>();
  for (const item of response.items) {
    if (item.kind !== "fileChange" || item.status !== "succeeded") continue;
    for (const file of item.files) {
      const path = file.fileRef.path;
      if (!path?.trim() || !isUserVisibleTerminalReportSourceRef(file.fileRef) ||
        !isUserVisibleTerminalReportArtifact({ id: file.fileRef.id, title: file.fileRef.label ?? "", path, sourceRefs: item.sourceRefs }) ||
        hiddenPaths.has(pathKey(path))) continue;
      const key = pathKey(path);
      const actionKey = JSON.stringify([item.actionId, key]);
      if (seenActions.has(actionKey)) continue;
      seenActions.add(actionKey);
      const previous = files.get(key);
      // changePreview is populated from resultArtifactIds, not an approval
      // preview. A multi-file result needs explicit per-file diff refs.
      const diffRef = file.diffRef ?? (item.files.length === 1 && item.changePreview
        ? item.sourceRefs.find((ref) => ref.id === item.changePreview?.artifactId && (ref.kind === "artifact" || ref.kind === "diff"))
        : undefined);
      files.set(key, {
        path, fileRef: file.fileRef, item,
        diffRef: diffRef && isUserVisibleTerminalReportSourceRef(diffRef) ? diffRef : undefined,
        diffs: [...(previous?.diffs ?? []), ...(diffRef && isUserVisibleTerminalReportSourceRef(diffRef) ? [{ ref: diffRef, item }] : [])],
        ...(previous ? {} : validCount(file.additions) && validCount(file.deletions)
          ? { additions: file.additions, deletions: file.deletions } : {}),
      });
    }
  }
  for (const change of report?.changes ?? []) {
    for (const path of change.paths) {
      const key = pathKey(path);
      if (!path.trim() || files.has(key) || hiddenPaths.has(key)) continue;
      // A report path enriches presentation, never the capability scope.
      files.set(key, { path, fileRef: { kind: "file", id: `report-path:${change.id}:${path}`, path } });
    }
  }
  return [...files.values()];
}
