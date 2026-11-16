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
}

export type DesktopBrowserUserAction = DesktopBrowserWorkspace & (
  | { readonly action: "open"; readonly url: string }
  | { readonly action: "navigate"; readonly tabId: string; readonly url: string }
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
