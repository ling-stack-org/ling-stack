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
  readonly source: "attachment" | "artifact";
  readonly scope: "channel" | "teammate_private" | "run" | "external_work";
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
  readonly imageUrl?: string;
  readonly truncated: boolean;
  readonly sizeBytes?: number;
  readonly redactionNotes: readonly string[];
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
