import { HTML_INTERACTIVE_SANDBOX, createInteractiveHtmlPreviewDocument } from "@ling-stack/contracts";
import { useState } from "react";
import { CodeBlock } from "../blocks/CodeBlock.js";
import { CopyActionButton } from "../feedback/CopyActionButton.js";
import { ImageCompareViewer } from "./ImageCompareViewer.js";
import { MessageBodyRenderer } from "../blocks/MessageBodyRenderer.js";
import { SpreadsheetGrid } from "./SpreadsheetGrid.js";
import { useI18n } from "../../../i18n.js";
import type { PreviewContentKind, PreviewContentResponse } from "../../../types.js";

export interface ArtifactPreviewProps {
  readonly preview: PreviewContentResponse;
  readonly cwd?: string;
}

export function ArtifactPreview({ preview, cwd }: ArtifactPreviewProps): React.JSX.Element {
  const { t } = useI18n();

  if (preview.kind === "image" && preview.imageUrl) {
    return <ImageCompareViewer current={{ label: preview.ref.label, imageUrl: preview.imageUrl }} compare={preview.compare} />;
  }

  if (preview.kind === "spreadsheet") {
    // The windowed route resolves the ref path against the workspace root and
    // enforces containment server-side, so any source with a known cwd works.
    const sourcePath = preview.ref.displayPath ?? preview.ref.label;
    if (cwd) {
      return <SpreadsheetGrid cwd={cwd} path={sourcePath} sheets={preview.spreadsheet?.sheets} />;
    }
    // Spreadsheet metadata without a workspace-relative source falls back to
    // a text listing until the harness wires artifact-scoped windows.
    if (preview.spreadsheet) {
      return (
        <div className="spreadsheet-grid spreadsheet-grid-note" data-ui2-spreadsheet-grid="true">
          {(preview.spreadsheet.sheets ?? []).map((sheet) => (
            <div key={sheet.index}>{sheet.name}</div>
          ))}
        </div>
      );
    }
  }

  if (preview.kind === "html_interactive" && preview.htmlInteractive) {
    return (
      <InteractiveHtmlPreview
        key={JSON.stringify([cwd, preview.ref.source, preview.ref.scope, preview.ref.id])}
        html={preview.htmlInteractive.html}
        title={preview.ref.label}
      />
    );
  }

  if (preview.text !== undefined) {
    if (preview.kind === "markdown_text" || preview.kind === "plain_text" || preview.kind === "pdf" || preview.kind === "office") {
      return (
        <div className="artifact-preview-text-panel">
          <div className="artifact-preview-text-actions">
            <span>{previewKindLabel(preview.kind)}</span>
            <CopyActionButton text={preview.text} label={t("Copy preview")} className="message-code-copy" />
          </div>
          {preview.kind === "markdown_text" || preview.kind === "plain_text" ? (
            <MessageBodyRenderer text={preview.text} compact={false} />
          ) : (
            <pre className="artifact-preview-document-text">{preview.text}</pre>
          )}
        </div>
      );
    }
    return <CodeBlock code={preview.text} language={previewKindLabel(preview.kind).toLowerCase()} copyLabel={t("Copy preview")} />;
  }

  return (
    <div className="artifact-preview-empty">
      <strong>{previewKindLabel(preview.kind)}</strong>
      <span>{t("Preview unavailable")}</span>
    </div>
  );
}

function InteractiveHtmlPreview({ html, title }: { readonly html: string; readonly title: string }): React.JSX.Element {
  const { t } = useI18n();
  const [consent, setConsent] = useState({ html, trusted: false });
  // Compare during render: an updated response must never execute using the
  // previous document's consent, even before effects have a chance to run.
  const allowScripts = consent.html === html && consent.trusted;
  if (consent.html !== html) setConsent({ html, trusted: false });
  return (
    <div className="artifact-preview-interactive-panel">
      <div className="artifact-preview-script-controls">
        <p>{t("Scripts can contact external services. Only run documents you trust.")}</p>
        <button type="button" className="button button-secondary"
          onClick={() => setConsent({ html, trusted: !allowScripts })}>
          {t(allowScripts ? "Stop interactive preview" : "Run interactive preview")}
        </button>
      </div>
      <iframe
        key={String(allowScripts)}
        className="artifact-preview-interactive-frame"
        data-ui2-artifact-interactive="true"
        sandbox={allowScripts ? HTML_INTERACTIVE_SANDBOX.join(" ") : ""}
        srcDoc={createInteractiveHtmlPreviewDocument(html, title, allowScripts)}
        title={title}
      />
    </div>
  );
}

function previewKindLabel(kind: PreviewContentKind): string {
  if (kind === "markdown_text") {
    return "Markdown";
  }
  if (kind === "plain_text") {
    return "Text";
  }
  if (kind === "json") {
    return "JSON";
  }
  if (kind === "diff") {
    return "Diff";
  }
  if (kind === "log") {
    return "Log";
  }
  if (kind === "code") {
    return "Code";
  }
  if (kind === "image") {
    return "Image";
  }
  if (kind === "pdf") {
    return "PDF";
  }
  if (kind === "office") {
    return "Office";
  }
  if (kind === "html_interactive") {
    return "Interactive";
  }
  return "Unsupported";
}
