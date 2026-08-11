import { CodeBlock } from "../blocks/CodeBlock.js";
import { CopyActionButton } from "../feedback/CopyActionButton.js";
import { ImageCompareViewer } from "./ImageCompareViewer.js";
import { MessageBodyRenderer } from "../blocks/MessageBodyRenderer.js";
import { useI18n } from "../../../i18n.js";
import type { PreviewContentKind, PreviewContentResponse } from "../../../types.js";

export interface ArtifactPreviewProps {
  readonly preview: PreviewContentResponse;
}

export function ArtifactPreview({ preview }: ArtifactPreviewProps): React.JSX.Element {
  const { t } = useI18n();

  if (preview.kind === "image" && preview.imageUrl) {
    return <ImageCompareViewer current={{ label: preview.ref.label, imageUrl: preview.imageUrl }} compare={preview.compare} />;
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
  return "Unsupported";
}
