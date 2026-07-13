export type ArtifactType = "file" | "diff" | "log" | "json" | "markdown" | "image" | "video";

export interface RunArtifact {
  readonly id: string;
  readonly runId?: string;
  readonly mediaJobId?: string;
  readonly externalWorkId?: string;
  readonly type: ArtifactType;
  readonly path: string;
  readonly title?: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
  readonly createdAt: string;
}

export type PreviewContentKind =
  | "markdown_text"
  | "plain_text"
  | "code"
  | "json"
  | "log"
  | "diff"
  | "image"
  | "pdf"
  | "office"
  | "unsupported";

export interface PreviewFileRef {
  readonly id: string;
  readonly source: "attachment" | "artifact" | "workspace_file";
  readonly scope: "channel" | "conversation" | "teammate_private" | "run" | "external_work" | "workspace";
  readonly label: string;
  readonly displayPath?: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
  readonly previewable: boolean;
  readonly redacted?: boolean;
}

export interface PreviewContentResponse {
  readonly ref: PreviewFileRef;
  readonly kind: PreviewContentKind;
  readonly text?: string;
  readonly textStartLine?: number;
  readonly imageUrl?: string;
  readonly compare?: PreviewImageCompare;
  readonly truncated: boolean;
  readonly sizeBytes?: number;
  readonly redactionNotes: readonly string[];
}

export type PreviewImageCompareMode = "single" | "side_by_side" | "slider" | "diff_overlay";

export interface PreviewImageCompareSource {
  readonly label: string;
  readonly imageUrl: string;
}

export interface PreviewImageCompare {
  readonly before: PreviewImageCompareSource;
  readonly after: PreviewImageCompareSource;
  readonly defaultMode?: PreviewImageCompareMode;
}

export interface RunArtifactListResponse {
  readonly runId: string;
  readonly artifacts: readonly RunArtifact[];
}

export interface MediaJobArtifactListResponse {
  readonly mediaJobId: string;
  readonly artifacts: readonly RunArtifact[];
}

export interface RunArtifactResponse {
  readonly artifact: RunArtifact;
}

export interface ArtifactsDomainSnapshot {
  readonly counts: {
    readonly recent: number;
    readonly byKind: Record<string, number>;
  };
  readonly recent: readonly ArtifactSummary[];
}

export interface ArtifactSummary {
  readonly id: string;
  readonly runId?: string;
  readonly mediaJobId?: string;
  readonly externalWorkId?: string;
  readonly title: string;
  readonly kind: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly contentHref: string;
}
