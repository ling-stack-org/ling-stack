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
  | "spreadsheet"
  | "unsupported";

import type { SpreadsheetWorkbook } from "./deliverables.js";

/**
 * Gen UI interactive HTML preview (ux-gap-roadmap-02). Rendered inside an
 * opaque-origin sandboxed iframe: scripts require explicit trust and the document gets no
 * same-origin access to Ling, the daemon, or storage.
 */
export const HTML_INTERACTIVE_SANDBOX: readonly string[] = ["allow-scripts"];
export const HTML_INTERACTIVE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Restrict resource loading and form submission. CSP does not block every
 * browser networking API (notably WebRTC), so it is not a network sandbox.
 */
const HTML_INTERACTIVE_RESOURCE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";
export const HTML_INTERACTIVE_CSP = `${HTML_INTERACTIVE_RESOURCE_CSP}; frame-src 'none'`;

/**
 * The trusted outer document controls navigation of the untrusted inner frame.
 * A document's own resource CSP alone does not prevent its self-navigation.
 * Scripts stay disabled by default. Enabling them requires explicit trust in
 * the exact document, including its ability to use browser networking APIs.
 * Callers must also sandbox this outer document, allowing scripts only after trust.
 */
export function createInteractiveHtmlPreviewDocument(html: string, title: string, allowScripts = false): string {
  const escapeAttribute = (value: string): string => value.replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("'", "&#39;");
  const resources = allowScripts ? HTML_INTERACTIVE_RESOURCE_CSP
    : HTML_INTERACTIVE_RESOURCE_CSP.replace("script-src 'unsafe-inline'", "script-src 'none'");
  const outerCsp = `${resources}; frame-src about:`;
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="' + outerCsp + '">'
    + '<style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style>'
    + '</head><body><iframe sandbox="' + (allowScripts ? "allow-scripts" : "") + '" title="' + escapeAttribute(title)
    + '" srcdoc="' + escapeAttribute(injectInteractiveHtmlCsp(html)) + '"></iframe></body></html>';
}

/**
 * Attach the resource CSP to a scanned document. Always injects: skipping on a
 * content substring match would let a document smuggle the policy text and
 * opt out of enforcement. Repeated injection only repeats the same strict
 * directive, which CSP combines restrictively.
 */
export function injectInteractiveHtmlCsp(html: string): string {
  const meta = '<meta http-equiv="Content-Security-Policy" content="' + HTML_INTERACTIVE_CSP + '">';
  const headEnd = findTagEnd(html, "head");
  if (headEnd !== undefined) return html.slice(0, headEnd) + meta + html.slice(headEnd);
  const htmlEnd = findTagEnd(html, "html");
  if (htmlEnd !== undefined) return html.slice(0, htmlEnd) + "<head>" + meta + "</head>" + html.slice(htmlEnd);
  return meta + html;
}

/** Linear scan for the closing ">" of an opening tag; no regex backtracking. */
function findTagEnd(html: string, tag: string): number | undefined {
  const lower = html.toLowerCase();
  let search = 0;
  for (;;) {
    const start = lower.indexOf("<" + tag, search);
    if (start === -1) return undefined;
    const next = lower[start + 1 + tag.length];
    if (next === ">" || next === " " || next === "\t" || next === "\n" || next === "\r" || next === "\f") {
      const end = lower.indexOf(">", start + 1);
      return end === -1 ? undefined : end + 1;
    }
    search = start + 1;
  }
}

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
  readonly spreadsheet?: SpreadsheetWorkbook;
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
