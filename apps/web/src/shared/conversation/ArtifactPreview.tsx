import { CodeBlock } from "./CodeBlock.js";
import { MessageBodyRenderer } from "./MessageBodyRenderer.js";
import { previewKindLabel } from "../../lib/previews.js";
import type { PreviewContentResponse } from "../../types.js";

export interface ArtifactPreviewProps {
  readonly preview: PreviewContentResponse;
}

export function ArtifactPreview({ preview }: ArtifactPreviewProps): JSX.Element {
  if (preview.kind === "image" && preview.imageUrl) {
    return (
      <div className="artifact-preview-image-frame">
        <img src={preview.imageUrl} alt={preview.ref.label} />
      </div>
    );
  }

  if (preview.text !== undefined) {
    if (preview.kind === "markdown_text" || preview.kind === "plain_text") {
      return <MessageBodyRenderer text={preview.text} compact={false} />;
    }
    return <CodeBlock code={preview.text} language={previewKindLabel(preview.kind).toLowerCase()} />;
  }

  return (
    <div className="artifact-preview-empty">
      <strong>{previewKindLabel(preview.kind)}</strong>
      <span>Preview unavailable</span>
    </div>
  );
}
