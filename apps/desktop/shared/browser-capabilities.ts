import type { BrowserManagementState, BrowserDeviceRule } from "./browser-management.js";
import type { DesktopBrowserAnnotation } from "./browser-annotations.js";
import type { DesktopBrowserScope, DesktopBrowserTab } from "@ling-stack/contracts";

export interface DesktopBrowserWorkspace {
  readonly workspaceCwd: string;
  readonly scope: DesktopBrowserScope;
}

export interface DesktopBrowserWorkspaceState {
  readonly generation: number;
  readonly revision: number;
  readonly tabs: readonly DesktopBrowserTab[];
  readonly activeTabId?: string;
  readonly management?: BrowserManagementState;
  readonly preferences: DesktopBrowserPreferences;
  readonly persistenceError?: boolean;
  readonly annotation?: DesktopBrowserAnnotation;
  readonly annotationStatus?: "available" | "stale";
  readonly openedIn?: "in_app" | "system";
}

export interface DesktopBrowserPreferences {
  readonly websiteLinks: "in_app" | "system";
  readonly localhostLinks: "in_app" | "system";
  readonly restoreTabs: boolean;
}

export type DesktopBrowserUserAction = DesktopBrowserWorkspace & (
  | { readonly action: "activate_workspace" | "deactivate_workspace" }
  | { readonly action: "open"; readonly url: string }
  | { readonly action: "open_link"; readonly url: string }
  | { readonly action: "history_clear"; readonly since: number; readonly id?: string }
  | { readonly action: "clear_data"; readonly cookies: boolean; readonly cache: boolean; readonly storage: boolean; readonly history: boolean }
  | { readonly action: "download_preferences"; readonly askBeforeDownload: boolean }
  | { readonly action: "download_directory" }
  | { readonly action: "import_preview" }
  | { readonly action: "extension_install" }
  | { readonly action: "download_cancel"; readonly id: string }
  | { readonly action: "download_show"; readonly id: string }
  | { readonly action: "extension_remove"; readonly id: string }
  | { readonly action: "device_permission"; readonly rule: BrowserDeviceRule }
  | { readonly action: "import_apply"; readonly urls: readonly string[] }
  | { readonly action: "annotate"; readonly tabId: string; readonly kind: "element" | "region"; readonly screenshot: boolean }
  | { readonly action: "locate_annotation"; readonly annotation: DesktopBrowserAnnotation }
  | { readonly action: "navigate"; readonly tabId: string; readonly url: string }
  | { readonly action: "preferences"; readonly preferences: DesktopBrowserPreferences }
  | { readonly action: "activate" | "close" | "back" | "forward" | "reload" | "stop" | "take_control" | "release_control" | "open_external"; readonly tabId: string }
);

export interface DesktopBrowserViewport extends DesktopBrowserWorkspace {
  readonly generation: number;
  readonly tabId?: string;
  readonly visible: boolean;
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface DesktopBrowserCapabilities {
  getState(workspace: DesktopBrowserWorkspace): Promise<DesktopBrowserWorkspaceState>;
  act(request: DesktopBrowserUserAction): Promise<DesktopBrowserWorkspaceState>;
  reportViewport(viewport: DesktopBrowserViewport): void;
  onStateChanged(listener: () => void): () => void;
  onAddressFocusRequested(listener: () => void): () => void;
}
