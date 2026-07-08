export type DockSurfaceKind =
  | "channel"
  | "normal_conversation"
  | "teammate_direct"
  | "run_detail";

export type DockPageKind =
  | "launcher"
  | "context"
  | "review"
  | "plans"
  | "evidence"
  | "files"
  | "activity"
  | "terminal"
  | "browser"
  | "detail";

export type DockSeverity = "neutral" | "info" | "warning" | "danger";

export interface DockPageStackEntry {
  readonly id: string;
  readonly page: DockPageKind;
  readonly title: string;
  readonly subtitle?: string;
  readonly sourceId?: string;
  readonly parentId?: string;
}

export interface DockLauncherItem {
  readonly id: DockPageKind;
  readonly label: string;
  readonly description?: string;
  readonly statusLabel?: string;
  readonly count?: number;
  readonly severity?: DockSeverity;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
}

export type DockReviewGroup =
  | "action_required"
  | "risk"
  | "memory"
  | "evidence"
  | "files"
  | "runtime"
  | "channel_protocol";

export type DockReviewStatus = "pending" | "passed" | "blocked" | "failed";

export type DockReviewKind =
  | "approval_gate"
  | "code_change"
  | "runtime_issue"
  | "evidence_gap"
  | "message_issue"
  | "protocol_signal";

export type DockReviewCodeLineKind =
  | "add"
  | "delete"
  | "hunk"
  | "meta"
  | "context"
  | "command";

export interface DockReviewCodeLine {
  readonly kind: DockReviewCodeLineKind;
  readonly text: string;
  readonly lineNumber?: number;
  readonly oldLineNumber?: number;
  readonly newLineNumber?: number;
}

export interface DockReviewChangeStats {
  readonly additions: number;
  readonly deletions: number;
}

export type DockReviewInlineNoteSeverity = "suggestion" | "risk" | "blocker";

export interface DockReviewInlineNote {
  readonly id: string;
  readonly severity: DockReviewInlineNoteSeverity;
  readonly label?: string;
  readonly authorLabel?: string;
  readonly body: string;
  readonly oldLineNumber?: number;
  readonly newLineNumber?: number;
  readonly lineKind?: DockReviewCodeLineKind;
}

export interface DockReviewCodePreview {
  readonly title: string;
  readonly language?: string;
  readonly pathLabel?: string;
  readonly lines: readonly DockReviewCodeLine[];
  readonly stats?: DockReviewChangeStats;
  readonly inlineNotes?: readonly DockReviewInlineNote[];
  readonly truncated?: boolean;
}

export interface DockReviewFact {
  readonly label: string;
  readonly value: string;
  readonly tone?: DockSeverity;
}

export interface DockReviewArtifactRef {
  readonly id: string;
  readonly type?: "file" | "diff" | "log" | "json" | "markdown" | "image" | "video";
  readonly path?: string;
  readonly title?: string;
}

export interface DockReviewItem {
  readonly id: string;
  readonly group: DockReviewGroup;
  readonly kind?: DockReviewKind;
  readonly severity: Exclude<DockSeverity, "neutral">;
  readonly status: DockReviewStatus;
  readonly title: string;
  readonly reason: string;
  readonly pathLabel?: string;
  readonly sourceLabel?: string;
  readonly actionLabel?: string;
  readonly timestampLabel?: string;
  readonly stats?: DockReviewChangeStats;
  readonly codePreview?: DockReviewCodePreview;
  readonly facts?: readonly DockReviewFact[];
  readonly artifactRef?: DockReviewArtifactRef;
}

export type DockEvidenceKind =
  | "run"
  | "source"
  | "file"
  | "shell"
  | "browser"
  | "approval"
  | "teammate_note"
  | "raw";

export interface DockEvidenceItem {
  readonly id: string;
  readonly kind: DockEvidenceKind;
  readonly title: string;
  readonly summary?: string;
  readonly status?: "available" | "loading" | "failed";
  readonly statusLabel?: string;
  readonly sourceLabel?: string;
  readonly href?: string;
  readonly originalUrl?: string;
  readonly finalUrl?: string;
  readonly failureReason?: string;
  readonly timestampLabel?: string;
}

export interface DockEvidenceGroupView {
  readonly id: DockEvidenceKind;
  readonly label: string;
  readonly items: readonly DockEvidenceItem[];
}

export type DockFileOwnerScopeKind = "workflow" | "workflow_step" | "task" | "run" | "message" | "channel";

export interface DockFileOwnerScope {
  readonly kind: DockFileOwnerScopeKind;
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly parentId?: string;
  readonly order?: number;
}

export interface DockFileItem {
  readonly id: string;
  readonly name: string;
  readonly pathLabel?: string;
  readonly kind: "attachment" | "reference" | "artifact" | "change";
  readonly status?: "available" | "generated" | "changed" | "missing";
  readonly ownerScope?: DockFileOwnerScope;
}
