export type DockSurfaceKind =
  | "channel"
  | "normal_conversation"
  | "teammate_direct"
  | "run_detail";

export type DockPageKind =
  | "launcher"
  | "review"
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

export interface DockReviewItem {
  readonly id: string;
  readonly group: DockReviewGroup;
  readonly severity: Exclude<DockSeverity, "neutral">;
  readonly status: DockReviewStatus;
  readonly title: string;
  readonly reason: string;
  readonly sourceLabel?: string;
  readonly actionLabel?: string;
  readonly timestampLabel?: string;
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
  readonly sourceLabel?: string;
  readonly timestampLabel?: string;
}

export interface DockEvidenceGroupView {
  readonly id: DockEvidenceKind;
  readonly label: string;
  readonly items: readonly DockEvidenceItem[];
}

export interface DockFileItem {
  readonly id: string;
  readonly name: string;
  readonly pathLabel?: string;
  readonly kind: "attachment" | "reference" | "artifact" | "change";
  readonly status?: "available" | "generated" | "changed" | "missing";
}
