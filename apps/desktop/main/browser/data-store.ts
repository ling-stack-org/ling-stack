import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { browserRecord, browserString, browserInteger, parseDesktopBrowserUrl } from "@ling-stack/contracts";
import type { BrowserDeviceRule, BrowserDownloadEntry, BrowserHistoryEntry } from "../../shared/browser-management.js";

interface Data { history: BrowserHistoryEntry[]; downloads: BrowserDownloadEntry[]; devices: BrowserDeviceRule[]; downloadDirectory: string; askBeforeDownload: boolean }
export function parseBrowserData(value: unknown): Data {
  const r = browserRecord(value, ["version", "history", "downloads", "devices", "downloadDirectory", "askBeforeDownload"]);
  if (r.version !== 1 || !Array.isArray(r.history) || r.history.length > 500 || !Array.isArray(r.downloads) || r.downloads.length > 100 || !Array.isArray(r.devices) || r.devices.length > 100 || typeof r.askBeforeDownload !== "boolean") throw new Error("browser_data_invalid");
  const history = r.history.map(value => { const e = browserRecord(value, ["id", "url", "title", "visitedAt"]); return { id: browserString(e.id, 128), url: parseDesktopBrowserUrl(e.url), title: browserString(e.title, 512, true), visitedAt: browserInteger(e.visitedAt) }; });
  const downloads = r.downloads.map(value => {
    const e = browserRecord(value, ["id", "url", "filename", "path", "startedAt", "status", "received", "total"]);
    if (!["progressing", "completed", "cancelled", "interrupted"].includes(String(e.status))) throw new Error("browser_data_invalid");
    return { id: browserString(e.id, 128), url: parseDesktopBrowserUrl(e.url), filename: browserString(e.filename, 255), path: browserString(e.path, 4096), startedAt: browserInteger(e.startedAt),
      status: e.status as BrowserDownloadEntry["status"], received: browserInteger(e.received), total: browserInteger(e.total) };
  });
  const devices = r.devices.map(value => {
    const e = browserRecord(value, ["origin", "permission", "decision"]), origin = new URL(parseDesktopBrowserUrl(e.origin)).origin;
    if (origin !== e.origin || !["camera", "microphone", "geolocation", "notifications"].includes(String(e.permission)) || !["ask", "allow", "deny"].includes(String(e.decision))) throw new Error("browser_data_invalid");
    return { origin, permission: e.permission as BrowserDeviceRule["permission"], decision: e.decision as BrowserDeviceRule["decision"] };
  });
  return { history, downloads, devices, downloadDirectory: browserString(r.downloadDirectory, 4096), askBeforeDownload: r.askBeforeDownload };
}

/** Profile-owned history and download records contain no Chromium credentials. */
export class BrowserDataStore {
  readonly data: Data;
  error = false;
  private readonly path?: string;
  constructor(private readonly directory: string | undefined, workspaceCwd: string, downloadDirectory: string) {
    this.path = directory ? join(directory, `${createHash("sha256").update(workspaceCwd).digest("hex")}.data.json`) : undefined;
    this.data = { history: [], downloads: [], devices: [], downloadDirectory, askBeforeDownload: true };
    if (this.path) try {
      const stat = lstatSync(this.path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error("browser_data_invalid");
      this.data = parseBrowserData(JSON.parse(readFileSync(this.path, "utf8")));
      this.data.downloads = this.data.downloads.map(item => item.status === "progressing" ? { ...item, status: "interrupted" } : item);
    } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) this.error = true; }
  }
  save(): void {
    if (!this.path || !this.directory || this.error) return;
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      writeFileSync(temp, JSON.stringify({ version: 1, ...parseBrowserData({ version: 1, ...this.data }) }), { mode: 0o600, flag: "wx" }); renameSync(temp, this.path);
    } catch { this.error = true; }
    finally { try { unlinkSync(temp); } catch { /* Renamed or unwritten temporary file. */ } }
  }
  updateTitle(url: string, title: string): void {
    const index = this.data.history.findIndex(item => item.url === url);
    if (index >= 0) { this.data.history[index] = { ...this.data.history[index]!, title: title.slice(0, 512) }; this.save(); }
  }
  record(url: string, title: string): void {
    const canonical = parseDesktopBrowserUrl(url);
    const previous = this.data.history.at(0);
    if (previous?.url === canonical && Date.now() - previous.visitedAt < 3000) this.data.history[0] = { ...previous, title: title.slice(0, 512) };
    else this.data.history.unshift({ id: randomUUID(), url: canonical, title: title.slice(0, 512), visitedAt: Date.now() });
    this.data.history = this.data.history.slice(0, 500); this.save();
  }
}
