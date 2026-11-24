export interface BrowserHistoryEntry { readonly id: string; readonly url: string; readonly title: string; readonly visitedAt: number }
export const BROWSER_HISTORY_CLEAR_ALL_SINCE = Number.MAX_SAFE_INTEGER;

export function filterBrowserHistory(history: readonly BrowserHistoryEntry[], since: number, id?: string): BrowserHistoryEntry[] {
  if (id) return history.filter(item => item.id !== id);
  if (since === BROWSER_HISTORY_CLEAR_ALL_SINCE) return [];
  return history.filter(item => item.visitedAt < since);
}

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
