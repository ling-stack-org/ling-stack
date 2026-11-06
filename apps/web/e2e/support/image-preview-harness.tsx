import { createRoot } from "react-dom/client";
import type { ConversationTimelineImageViewItem } from "@ling-stack/conversation-ui-core";
import { I18nProvider } from "../../src/i18n.js";
import { ThemeProvider, useTheme } from "../../src/theme.js";
import { ConversationViewProvider } from "../../src/shared/conversation/view-store/conversation-view-provider.js";
import { LingUiProvider } from "../../src/shared/ui/index.js";
import { ConversationTimelineImageRenderer } from "../../src/shared/conversation/timeline/ConversationTimelineImageRenderer.js";
import type { ArtifactPreviewLoader, ArtifactPreviewRequest } from "../../src/shared/conversation/preview/ArtifactPreviewDrawer.js";
import type { PreviewContentResponse } from "../../src/types.js";

export function mountImagePreviewFixture(input: {
  readonly item?: Partial<ConversationTimelineImageViewItem>;
  readonly cwd?: string;
  readonly loader?: boolean;
} = {}) {
  const container = document.createElement("main");
  container.style.cssText = "padding:24px;width:100%;max-width:760px;box-sizing:border-box";
  container.dataset.conversationTimeline = "true";
  document.body.append(container);
  const root = createRoot(container);
  const baseItem: ConversationTimelineImageViewItem = {
    id: "image-preview", kind: "imageView", title: "workspace-preview.jpg", revision: 1,
    threadSequence: 1, partIndex: 0, status: "succeeded", turnId: "turn-image",
    runId: "run-image", attemptId: "attempt-image", actionId: "action-image", participantId: "ling-agent", workflowStepId: null,
    artifactRef: { kind: "artifact", id: "artifact-image" },
    sourceRefs: [{ kind: "artifact", id: "artifact-image" }],
    description: "Opened workspace-preview.jpg", alt: "workspace-preview.jpg", ...input.item,
  };
  const mergeItem = (patch: Partial<ConversationTimelineImageViewItem>): ConversationTimelineImageViewItem => ({
    ...baseItem,
    ...patch,
    attemptId: patch.attemptId ?? baseItem.attemptId,
    workflowStepId: patch.workflowStepId ?? baseItem.workflowStepId,
  });
  let item = mergeItem(input.item ?? {});
  const requests: ArtifactPreviewRequest[] = [];
  const pending: { resolve: (value: PreviewContentResponse) => void; reject: (reason: Error) => void }[] = [];
  const loadPreview: ArtifactPreviewLoader = (request) => {
    requests.push(request);
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  };
  let setTheme: (themeId: string) => Promise<void> = async () => { throw new Error("Theme not mounted"); };
  function ThemeControl() {
    setTheme = useTheme().setFixedTheme;
    return null;
  }
  const render = () => root.render(<I18nProvider><ThemeProvider><LingUiProvider><ThemeControl />
    <ConversationViewProvider surfaceId="image-preview-fixture" readingScopeKey="image-preview-reading">
      <ConversationTimelineImageRenderer item={item} depth={0} cwd={input.cwd ?? "/workspace"}
        loadPreview={input.loader === false ? undefined : loadPreview} />
    </ConversationViewProvider>
  </LingUiProvider></ThemeProvider></I18nProvider>);
  render();
  return {
    requests: () => requests,
    update: (patch: Partial<ConversationTimelineImageViewItem>) => { item = mergeItem({ ...item, ...patch }); render(); },
    resolve: (index: number, patch: Partial<PreviewContentResponse> = {}) => pending[index].resolve({
      ref: { id: "artifact-image", source: "artifact", scope: "run", label: item.title, previewable: true },
      kind: "image", imageUrl: "/e2e/fixtures/fronalpstock-3840.jpg", truncated: false, redactionNotes: [], ...patch,
    }),
    reject: (index: number) => pending[index].reject(new Error("Preview unavailable")),
    setTheme: (themeId: string) => setTheme(themeId),
    dispose: () => { root.unmount(); container.remove(); },
  };
}

declare global { interface Window { imagePreviewHarness: ReturnType<typeof mountImagePreviewFixture>; } }
