import {
  ThemeStudioPreviewFixture,
  lingDarkTheme,
  lingLightTheme,
  themeTokensToCssVariables,
  type ThemeStudioPreviewSurface,
  type ThemeStudioPreviewViewport,
} from "@ling-stack/ui-react";
import { createRoot, type Root } from "react-dom/client";

let root: Root | undefined;
let artworkUrl: string | undefined;

export interface ThemeStudioPreviewHarnessInput {
  readonly artwork?: boolean;
  readonly scale: number;
  readonly surface: ThemeStudioPreviewSurface;
  readonly theme: "dark" | "light";
  readonly viewport: ThemeStudioPreviewViewport;
}

export async function mountThemeStudioPreviewHarness(input: ThemeStudioPreviewHarnessInput): Promise<void> {
  const container = ensureContainer();
  root ??= createRoot(container);
  if (input.artwork && !artworkUrl) artworkUrl = await createArtworkUrl();
  const manifest = input.theme === "dark" ? lingDarkTheme : lingLightTheme;
  document.documentElement.dataset.uiTheme = manifest.id;
  root.render(
    <ThemeStudioPreviewFixture
      artworkUrl={input.artwork ? artworkUrl : undefined}
      copy={previewCopy}
      presentationPolicy={{ artwork: "ambient", decorations: true, surfaceRecipe: "translucent" }}
      scale={input.scale}
      surface={input.surface}
      variableMap={themeTokensToCssVariables(manifest.tokens)}
      viewport={input.viewport}
    />,
  );
}

export function unmountThemeStudioPreviewHarness(): void {
  root?.unmount();
  root = undefined;
  if (artworkUrl) URL.revokeObjectURL(artworkUrl);
  artworkUrl = undefined;
}

function ensureContainer(): HTMLDivElement {
  document.body.style.margin = "0";
  document.body.style.padding = "24px";
  document.body.style.background = "#e8ebee";
  let container = document.querySelector<HTMLDivElement>("#theme-studio-preview-harness");
  if (!container) {
    container = document.createElement("div");
    container.id = "theme-studio-preview-harness";
    container.style.width = "min(100%, 820px)";
    container.style.height = "520px";
    container.style.margin = "0 auto";
    document.body.append(container);
  }
  return container;
}

async function createArtworkUrl(): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 90;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is unavailable.");
  context.fillStyle = "#53736b";
  context.fillRect(0, 0, 160, 90);
  context.fillStyle = "#a6b7aa";
  context.fillRect(0, 0, 92, 90);
  context.fillStyle = "#d5b56d";
  context.fillRect(118, 16, 24, 24);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Preview artwork encoding failed.")), "image/png");
  });
  return URL.createObjectURL(blob);
}

const previewCopy = {
  ariaLabel: "Candidate theme preview",
  navigation: {
    home: "Home",
    conversations: "Conversations",
    settings: "Settings",
  },
  shared: {
    workspace: "Ling workspace",
    ready: "Ready",
    search: "Search",
    summary: "Summary",
    terminal: "Terminal",
    details: "Details",
  },
  home: {
    eyebrow: "Workspace",
    title: "Good morning",
    body: "Continue the work that matters.",
    primaryAction: "Start conversation",
    composerPlaceholder: "Ask Ling anything",
    recentTitle: "Recent work",
    recentSummary: "Theme Studio planning",
  },
  conversation: {
    title: "Design review",
    status: "Context ready",
    userMessage: "Review the current interface.",
    assistantMessage: "The main actions are now easier to scan.",
    composerPlaceholder: "Message Ling",
    dockTitle: "Conversation details",
    dockSummary: "Review, evidence, files and context",
    terminalTitle: "Workspace terminal",
  },
  settings: {
    title: "Interface preferences",
    sectionTitle: "Appearance",
    fieldLabel: "Response language",
    fieldValue: "English",
    rowLabel: "Current theme",
    rowSummary: "Candidate theme",
    rowStatus: "Preview",
    inspectorTitle: "Technical details",
    inspectorSummary: "Tokens and contrast",
    inspectorBody: "Semantic values remain isolated inside this preview.",
  },
  dialog: {
    pageTitle: "Theme settings",
    title: "Delete local theme?",
    body: "This permanently removes the installed theme.",
    fieldLabel: "Theme name",
    fieldValue: "Quiet Forest",
    statusTitle: "Theme is in use",
    statusBody: "Ling Light will be restored before deletion.",
    cancel: "Cancel",
    confirm: "Delete theme",
    toast: "Theme preview updated",
  },
} as const;
