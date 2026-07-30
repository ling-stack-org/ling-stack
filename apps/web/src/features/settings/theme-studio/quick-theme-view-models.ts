import type { Translate } from "../../../i18n.js";
import type {
  ThemeStudioPreviewCopy,
  ThemeStudioPreviewSurface,
} from "../../../shared/ui/index.js";
import type { QuickThemeState } from "./quick-theme-state.js";

export function quickThemeIssueMessage(issue: QuickThemeState["issue"], t: Translate): string | undefined {
  if (!issue) return undefined;
  const key = issue.code === "invalid-extension" ? "Choose a PNG, JPEG, or WebP image."
    : issue.code === "file-too-large" ? "Images cannot exceed 16 MB."
      : issue.code === "dimensions-too-large" ? "This image is too large to analyze safely."
        : issue.code === "invalid-mime" ? "The file type does not match its filename."
          : issue.code === "decode-failed" ? "This image could not be opened. Choose another file."
            : issue.code === "source-required" ? "Choose an image first."
              : issue.code === "name-required" ? "Enter a theme name."
                : issue.code === "publish-failed" ? "The theme could not be installed. Your draft is still available."
                  : issue.code === "compile-failed" ? "The theme could not be generated from this image."
                    : undefined;
  return key ? t(key) : issue.message;
}

export function previewSurfacePolicy(surface: ThemeStudioPreviewSurface): "conversation" | "home" | "overlay" | "settings" {
  return surface === "dialog" ? "overlay" : surface;
}

export function quickThemePreviewCopy(t: Translate): ThemeStudioPreviewCopy {
  return {
    ariaLabel: t("Theme preview"),
    navigation: {
      home: t("Home"),
      conversations: t("Conversations"),
      settings: t("Settings"),
    },
    shared: {
      workspace: t("Ling workspace"),
      ready: t("Ready"),
      search: t("Search"),
      refresh: t("Refresh"),
      summary: t("Summary"),
      terminal: t("Terminal"),
      details: t("Details"),
    },
    home: {
      eyebrow: t("Workspace"),
      title: t("Start a conversation"),
      body: t("Work with Ling using the theme colors generated from your image."),
      primaryAction: t("New conversation"),
      composerPlaceholder: t("Message Ling"),
      recentTitle: t("Recent work"),
      recentSummary: t("A quiet preview of your workspace."),
    },
    conversation: {
      title: t("Ling"),
      status: t("Ready"),
      userMessage: t("Show how this theme reads in a conversation."),
      assistantMessage: t("The preview uses semantic colors only. Your image is not used as a background."),
      composerPlaceholder: t("Message Ling"),
      dockTitle: t("Details"),
      dockSummary: t("Supporting information stays visually secondary."),
      terminalTitle: t("Terminal"),
    },
    settings: {
      title: t("Settings"),
      sectionTitle: t("Appearance"),
      fieldLabel: t("Theme name"),
      fieldValue: t("Quick theme"),
      rowLabel: t("Follow system"),
      rowSummary: t("Use the matching light or dark theme."),
      rowStatus: t("Ready"),
      inspectorTitle: t("Theme details"),
      inspectorSummary: t("Generated locally"),
      inspectorBody: t("Only palette and design tokens are installed."),
    },
    dialog: {
      pageTitle: t("Settings"),
      title: t("Confirm changes"),
      body: t("Dialog text remains readable with the generated semantic colors."),
      fieldLabel: t("Theme name"),
      fieldValue: t("Quick theme"),
      statusTitle: t("Ready"),
      statusBody: t("No background image will be published."),
      cancel: t("Cancel"),
      confirm: t("Confirm"),
      toast: t("Theme saved"),
    },
  };
}
