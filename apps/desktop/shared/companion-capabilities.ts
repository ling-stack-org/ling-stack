import type { DesktopCommandResult } from "./desktop-capabilities.js";

export interface DesktopCompanionWindowCapabilities {
  open(cwd: string): Promise<DesktopCommandResult>;
  onSettingsRequested(listener: () => void): () => void;
}

export interface CompanionDesktopCapabilities {
  readonly cwd: string;
  readonly daemonBaseUrl: string;
  close(): Promise<DesktopCommandResult>;
  openSettings(): Promise<DesktopCommandResult>;
}
