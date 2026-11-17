export interface BrowserHistoryEntry { readonly id: string; readonly url: string; readonly title: string; readonly visitedAt: number }
export interface BrowserDownloadEntry {
  readonly id: string; readonly url: string; readonly filename: string; readonly path: string; readonly startedAt: number;
  readonly status: "progressing" | "completed" | "cancelled" | "interrupted"; readonly received: number; readonly total: number;
}
export type BrowserDevicePermission = "camera" | "microphone" | "geolocation" | "notifications";
export interface BrowserDeviceRule { readonly origin: string; readonly permission: BrowserDevicePermission; readonly decision: "ask" | "allow" | "deny" }
export interface BrowserManagementState {
  readonly history: readonly BrowserHistoryEntry[];
  readonly downloads: readonly BrowserDownloadEntry[];
  readonly devices: readonly BrowserDeviceRule[];
  readonly downloadDirectory: string;
  readonly askBeforeDownload: boolean;
  readonly extensions: readonly { readonly id: string; readonly name: string; readonly version: string }[];
  readonly importPreview?: readonly { readonly url: string; readonly title: string }[];
  readonly error?: boolean;
}
