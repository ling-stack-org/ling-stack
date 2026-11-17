import { createRequire } from "node:module";
import { basename, join, extname } from "node:path";
import { lstatSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { BrowserWindow, DownloadItem, Event, Session, WebContents } from "electron";
import { parseDesktopBrowserUrl } from "@ling-stack/contracts";
import type { BrowserDevicePermission, BrowserDeviceRule, BrowserManagementState } from "../../shared/browser-management.js";
import { BrowserDataStore } from "./data-store.js";
import { loadBrowserNativeMessages, type BrowserNativeTranslate } from "./native-messages.js";

export class BrowserManagement {
  readonly store: BrowserDataStore;
  private readonly electron = createRequire(import.meta.url)("electron") as typeof import("electron");
  private readonly downloads = new Map<string, DownloadItem>();
  private readonly downloadOwners = new Map<string, { contentsId: number; agent: boolean }>();
  private readonly gestures = new Map<number, number>();
  private readonly grants = new Map<number, { readonly url: string; readonly deadline: number }>();
  private preview?: { url: string; title: string }[];
  private translate: BrowserNativeTranslate = key => key;
  private readonly messages: Promise<void>;
  constructor(private readonly options: { readonly session: Session; readonly workspaceCwd: string; readonly directory?: string; readonly getMainWindow: () => BrowserWindow | undefined;
    readonly tab: (id: number) => { readonly url: string; readonly control: "human" | "agent" } | undefined; readonly changed: () => void }) {
    this.store = new BrowserDataStore(options.directory, options.workspaceCwd, this.electron.app.getPath("downloads"));
    this.messages = loadBrowserNativeMessages(this.electron.app.getLocale()).then(t => { this.translate = t; });
  }
  ready(): Promise<void> { return this.messages; }
  state(): BrowserManagementState { return { ...this.store.data, error: this.store.error, extensions: this.options.session.extensions.getAllExtensions().map(({ id, name, version }) => ({ id, name, version })), ...(this.preview ? { importPreview: this.preview } : {}) }; }
  recordGesture(id: number): void { this.gestures.set(id, Date.now() + 1500); }
  pauseAgent(id: number): void {
    this.grants.delete(id);
    for (const [downloadId, owner] of this.downloadOwners) if (owner.contentsId === id && owner.agent) this.downloads.get(downloadId)?.cancel();
  }
  authorizeDownload(contents: WebContents, url: string): void { this.grants.set(contents.id, { url, deadline: Date.now() + 5000 }); contents.downloadURL(url); }
  willDownload(event: Event, item: DownloadItem, contents: WebContents | undefined): void {
    const tab = contents && this.options.tab(contents.id), url = item.getURL();
    const grant = contents && this.grants.get(contents.id); if (contents) this.grants.delete(contents.id);
    const trustedGesture = contents && (this.gestures.get(contents.id) ?? 0) >= Date.now(); if (contents) this.gestures.delete(contents.id);
    const validGrant = grant && grant.url === url && grant.deadline >= Date.now();
    const forbidden = !tab || (!validGrant && (tab.control === "agent" || !trustedGesture)) || new URL(parseDesktopBrowserUrl(url)).origin !== new URL(tab.url).origin;
    if (forbidden || this.downloads.size >= 8) { event.preventDefault(); item.cancel(); return; }
    const filename = basename(item.getFilename()).replace(/[\x00-\x1f<>:"/\\|?*]/gu, "_").slice(0, 200) || "download";
    let path: string | undefined;
    if (this.store.data.askBeforeDownload) {
      const owner = this.options.getMainWindow();
      const args = { title: this.translate("Download from {origin}", { origin: new URL(url).origin }), defaultPath: join(this.store.data.downloadDirectory, filename) };
      path = owner ? this.electron.dialog.showSaveDialogSync(owner, args) : this.electron.dialog.showSaveDialogSync(args);
    } else {
      try { const dir = lstatSync(this.store.data.downloadDirectory); if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error("browser_download_directory_invalid");
        path = join(this.store.data.downloadDirectory, filename);
        if (existsSync(path)) path = join(this.store.data.downloadDirectory, `${basename(filename, extname(filename))}-${randomUUID().slice(0, 8)}${extname(filename)}`);
      } catch { path = undefined; }
    }
    if (!path) { event.preventDefault(); item.cancel(); return; }
    item.setSavePath(path);
    const id = randomUUID(), startedAt = Date.now(); this.downloads.set(id, item); this.downloadOwners.set(id, { contentsId: contents!.id, agent: tab!.control === "agent" });
    const update = (status: "progressing" | "completed" | "cancelled" | "interrupted"): void => {
      const entry = { id, startedAt, url: parseDesktopBrowserUrl(url), filename, path: path!, status, received: Math.max(0, item.getReceivedBytes()), total: Math.max(0, item.getTotalBytes()) };
      this.store.data.downloads = [entry, ...this.store.data.downloads.filter(item => item.id !== id)].slice(0, 100); this.store.save(); this.options.changed();
    };
    update("progressing"); item.on("updated", (_event, state) => update(state === "interrupted" ? "interrupted" : "progressing"));
    item.once("done", (_event, state) => { this.downloads.delete(id); this.downloadOwners.delete(id); update(state); });
  }
  permission(id: number, permission: string, origin: string): boolean {
    const tab = this.options.tab(id); if (!tab || tab.control !== "human" || new URL(tab.url).origin !== origin) return false;
    return this.store.data.devices.some(rule => rule.origin === origin && rule.permission === permission && rule.decision === "allow");
  }
  async setDeviceRule(rule: BrowserDeviceRule): Promise<void> {
    const names: Record<BrowserDevicePermission, string> = { camera: "Camera", microphone: "Microphone", geolocation: "Location", notifications: "Notifications" };
    if (rule.decision === "allow" && !await this.confirm(this.translate("Allow {permission} for {origin}?", { permission: this.translate(names[rule.permission]), origin: rule.origin }))) return;
    this.store.data.devices = [...this.store.data.devices.filter(item => item.origin !== rule.origin || item.permission !== rule.permission), rule].slice(-100); this.changed();
  }
  async clear(input: { readonly cookies: boolean; readonly cache: boolean; readonly storage: boolean; readonly history: boolean }): Promise<boolean> {
    if (!await this.confirm(this.translate("Clear selected browser data for {workspace}? Cookies and site storage can sign you out.", { workspace: this.options.workspaceCwd }))) return false;
    for (const item of this.downloads.values()) item.cancel();
    if (input.cookies) await this.options.session.clearStorageData({ storages: ["cookies"] });
    if (input.storage) await this.options.session.clearStorageData({ storages: ["filesystem", "indexdb", "localstorage", "serviceworkers", "cachestorage", "shadercache"] });
    if (input.cache) await this.options.session.clearCache();
    if (input.history) this.store.data.history = [];
    await this.options.session.closeAllConnections(); this.changed(); return true;
  }
  async chooseDownloadDirectory(): Promise<void> {
    const result = await this.electron.dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    if (!result.canceled && result.filePaths[0]) { this.store.data.downloadDirectory = realpathSync(result.filePaths[0]); this.changed(); }
  }
  downloadAction(id: string, action: "cancel" | "show"): void {
    if (action === "cancel") this.downloads.get(id)?.cancel();
    else { const item = this.store.data.downloads.find(item => item.id === id); if (item?.status === "completed" && existsSync(item.path)) this.electron.shell.showItemInFolder(item.path); }
  }
  clearHistory(since: number, id?: string): void { this.store.data.history = this.store.data.history.filter(item => id ? item.id !== id : item.visitedAt < since); this.changed(); }
  async previewImport(): Promise<void> {
    const result = await this.electron.dialog.showOpenDialog({ properties: ["openFile"], filters: [{ name: this.translate("Chromium bookmarks JSON"), extensions: ["json", "*"] }] });
    if (result.canceled || !result.filePaths[0]) return;
    const path = result.filePaths[0], stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error("browser_import_invalid");
    const value: unknown = JSON.parse(readFileSync(path, "utf8")), entries: { url: string; title: string }[] = []; let count = 0;
    const walk = (value: unknown, depth: number): void => {
      if (depth > 30 || ++count > 10_000 || entries.length >= 100 || !value || typeof value !== "object" || Array.isArray(value)) return;
      const item = value as Record<string, unknown>;
      if (item.type === "url" && typeof item.url === "string") try { entries.push({ url: parseDesktopBrowserUrl(item.url), title: typeof item.name === "string" ? item.name.slice(0, 512) : "" }); } catch { /* Unsupported bookmark URL. */ }
      if (Array.isArray(item.children)) item.children.forEach(child => walk(child, depth + 1));
    };
    if (!value || typeof value !== "object" || !("roots" in value) || !value.roots || typeof value.roots !== "object") throw new Error("browser_import_invalid");
    Object.values(value.roots).forEach(root => walk(root, 0)); this.preview = entries; this.options.changed();
  }
  applyImport(urls: readonly string[]): void {
    if (!this.preview || urls.some(url => !this.preview!.some(entry => entry.url === url))) throw new Error("browser_import_preview_stale");
    for (const entry of this.preview) if (urls.includes(entry.url)) this.store.record(entry.url, entry.title);
    this.preview = undefined; this.changed();
  }
  async installExtension(): Promise<void> {
    const selection = await this.electron.dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (selection.canceled || !selection.filePaths[0]) return;
    const path = realpathSync(selection.filePaths[0]), manifestPath = join(path, "manifest.json"), stat = lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error("browser_extension_invalid");
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!manifest || typeof manifest !== "object" || !("manifest_version" in manifest) || manifest.manifest_version !== 3) throw new Error("browser_extension_mv3_required");
    const detail = JSON.stringify(manifest, null, 2).slice(0, 16000);
    if (!await this.confirm(`${this.translate("Load this unpacked extension into the current browser profile? It may read websites you visit. It must be loaded again after restart.")}\n${path}\n${detail}`)) return;
    await this.options.session.extensions.loadExtension(path, { allowFileAccess: false }); this.options.changed();
  }
  removeExtension(id: string): void { this.options.session.extensions.removeExtension(id); this.options.changed(); }
  async confirmCdp(origin: string, method: string, params: object): Promise<boolean> {
    const owner = this.options.getMainWindow();
    const options = { type: "warning" as const, message: this.translate("Allow this tab debugging command on {origin}? It can expose page data or change the page.", { origin }),
      detail: JSON.stringify({ method, params }).slice(0, 16000), buttons: [this.translate("Deny"), this.translate("Allow once")], defaultId: 0, cancelId: 0, noLink: true };
    return (owner ? await this.electron.dialog.showMessageBox(owner, options) : await this.electron.dialog.showMessageBox(options)).response === 1;
  }
  dispose(): void { for (const item of this.downloads.values()) item.cancel(); this.downloads.clear(); this.downloadOwners.clear(); this.grants.clear(); this.gestures.clear(); this.store.save(); }
  private changed(): void { this.store.save(); this.options.changed(); }
  private async confirm(message: string): Promise<boolean> { const owner = this.options.getMainWindow(); const options = { message, type: "question" as const, buttons: [this.translate("Cancel"), this.translate("Continue")], defaultId: 0, cancelId: 0, noLink: true };
    return (owner ? await this.electron.dialog.showMessageBox(owner, options) : await this.electron.dialog.showMessageBox(options)).response === 1; }
}
