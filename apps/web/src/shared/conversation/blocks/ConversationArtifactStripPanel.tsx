import type { ConversationArtifactStripItem } from "../../../lib/conversation-work-cell.js";
import type { ArtifactPreviewLoader } from "../preview/ArtifactPreviewDrawer.js";
import {
  ConversationArtifactStrip,
  type ConversationWorkspaceReviewTarget,
} from "./ConversationArtifactStrip.js";

export function ConversationArtifactStripPanel({
  items,
  cwd,
  recoveryTarget,
  loadPreview,
  onOpenWorkspaceReview,
}: {
  readonly items: readonly ConversationArtifactStripItem[];
  readonly cwd?: string;
  readonly recoveryTarget?: ConversationArtifactStripItem["recoveryTarget"];
  readonly loadPreview: ArtifactPreviewLoader;
  readonly onOpenWorkspaceReview?: (target: ConversationWorkspaceReviewTarget) => void;
}): React.JSX.Element | null {
  const visibleItems = items.filter((item) => item.kind === "artifact" || item.kind === "changed");
  if (visibleItems.length === 0) return null;
  return (
    <ConversationArtifactStrip
      items={visibleItems}
      cwd={cwd}
      recoveryTarget={recoveryTarget}
      loadPreview={loadPreview}
      onOpenWorkspaceReview={onOpenWorkspaceReview}
    />
  );
}
