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
  | "html_interactive"
  | "unsupported";

/**
 * Gen UI interactive HTML preview (ux-gap-roadmap-02). Rendered inside an
 * opaque-origin sandboxed iframe: scripts run, but the document gets no
 * same-origin access to Ling, the daemon, or storage.
 */
export const HTML_INTERACTIVE_SANDBOX: readonly string[] = ["allow-scripts"];
export const HTML_INTERACTIVE_MAX_BYTES = 2 * 1024 * 1024;

export interface PreviewHtmlInteractive {
  readonly html: string;
  readonly sandbox: readonly string[];
}

export interface InteractiveHtmlScanResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Bounded safety scan applied before an HTML document is offered as an
 * interactive preview. Remote subresources and script URLs are rejected —
 * artifacts are offline-first; remote loading is a future explicit opt-in.
 */
export function scanInteractiveHtml(html: string, maxBytes: number = HTML_INTERACTIVE_MAX_BYTES): InteractiveHtmlScanResult {
  if (new TextEncoder().encode(html).length > maxBytes) {
    return { ok: false, reason: "Interactive HTML exceeds the preview size cap." };
  }
  const remoteResource = /(?:src|href|poster|data)\s*=\s*(?:"\s*(?:https?:)?\/\/|'\s*(?:https?:)?\/\/|(?:https?:)?\/\/)/iu;
  if (remoteResource.test(html)) {
    return { ok: false, reason: "Interactive HTML must not reference remote resources." };
  }
  if (/javascript\s*:/iu.test(html)) {
    return { ok: false, reason: "Interactive HTML must not use javascript: URLs." };
  }
  return { ok: true };
}

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
  readonly htmlInteractive?: PreviewHtmlInteractive;
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
