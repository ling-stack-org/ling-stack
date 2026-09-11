export interface TerminalReportVisibilitySourceRef {
  readonly kind: string;
  readonly id: string;
  readonly label?: string;
  readonly href?: string;
  readonly path?: string;
  readonly visibility?: "conversation" | "folded_evidence" | "developer_only" | "private" | "audit";
  readonly sensitivity?: "normal" | "private" | "secret_adjacent";
}

export interface TerminalReportVisibilityArtifact {
  readonly id: string;
  readonly title: string;
  readonly path?: string;
}

export interface TerminalReportVisibilityChange {
  readonly paths: readonly string[];
}

const INTERNAL_TERMINAL_REPORT_REFERENCE_KINDS = new Set([
  "approval",
  "check",
  "message",
  "operation",
  "run",
  "task",
  "turn",
  "workflow",
  "workflow_step",
]);

const CONVERSATION_TERMINAL_REPORT_REFERENCE_KINDS = new Set([
  "artifact",
  "diff",
  "file",
  "image",
  "memory",
  "path",
]);

export function isUserVisibleTerminalReportSourceRef(ref: TerminalReportVisibilitySourceRef): boolean {
  if (ref.visibility === "developer_only" || ref.visibility === "private" || ref.visibility === "audit") {
    return false;
  }
  if (ref.sensitivity === "secret_adjacent") {
    return false;
  }
  if (INTERNAL_TERMINAL_REPORT_REFERENCE_KINDS.has(ref.kind)) {
    return false;
  }
  if (isInternalTerminalReportArtifactText(ref.label ?? "")) {
    return false;
  }
  if (ref.kind === "external") {
    return Boolean(ref.href);
  }
  return CONVERSATION_TERMINAL_REPORT_REFERENCE_KINDS.has(ref.kind) || Boolean(ref.href);
}

export function isUserVisibleTerminalReportArtifact(artifact: TerminalReportVisibilityArtifact): boolean {
  return !isInternalTerminalReportArtifactText([artifact.title, artifact.path].filter(Boolean).join(" "));
}

/**
 * Removes paths that point at a run's internal artifact storage rather than at
 * the user's workspace. The caller keeps the original change identity and
 * metadata, while changes that only contain internal paths disappear from the
 * visible report entirely.
 */
export function userVisibleTerminalReportChanges<TChange extends TerminalReportVisibilityChange>(
  changes: readonly TChange[],
  sourceRefs: readonly TerminalReportVisibilitySourceRef[],
): readonly TChange[] {
  const artifactStoragePrefixes = sourceRefs
    .filter((ref) => ref.kind === "run")
    .map((ref) => `${ref.id}/`);
  if (artifactStoragePrefixes.length === 0) {
    return changes;
  }
  return changes.flatMap((change) => {
    const paths = change.paths.filter(
      (path) => !artifactStoragePrefixes.some((prefix) => path.startsWith(prefix)),
    );
    return paths.length > 0 ? [{ ...change, paths }] : [];
  });
}

export function isInternalTerminalReportArtifactText(value: string): boolean {
  return /^(Generated file metadata|Workflow step context|Workflow step output|Action preview):/iu.test(value.trim()) ||
    /^Unified exec (?:stdout|stderr|result)\b/iu.test(value.trim()) ||
    /\bcontent log\b/iu.test(value);
}
