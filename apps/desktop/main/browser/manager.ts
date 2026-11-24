import { BrowserDebugLog, debugUrl } from "./debug.js";
import { BrowserWebMcp } from "./webmcp.js";
import { BrowserManagement } from "./management.js";
import { measureBrowserProfileSize } from "./profile-size.js";
import { browserAnnotationScript } from "./annotation-runtime.js";
import { parseBrowserAnnotationAnchor, type DesktopBrowserAnnotation } from "../../shared/browser-annotations.js";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { BrowserWindow, WebContentsView, Session } from "electron";
import {
  DESKTOP_BROWSER_MAX_TABS, DESKTOP_BROWSER_PROTOCOL, parseDesktopBrowserUrl, sameDesktopBrowserScope,
  type DesktopBrowserScope, type DesktopBrowserState, type DesktopBrowserTab, type DesktopBrowserCommand,
} from "@ling-stack/contracts";
import type { DesktopBrowserPreferences, DesktopBrowserSettingsAction, DesktopBrowserUserAction, DesktopBrowserViewport, DesktopBrowserWorkspace, DesktopBrowserWorkspaceState } from "../../shared/browser-capabilities.js";
import type { BrowserManagementState } from "../../shared/browser-management.js";
import type { DeviceStorageCategorySize, DeviceStorageScope } from "@ling-stack/contracts";
import { createWorkspaceRegistryStore } from "@ling-stack/core";
import { browserPageScript } from "./page-runtime.js";
import { assertBrowserNetworkUrl, isBrowserLoopback } from "./url-policy.js";
import { configureBrowserSession } from "./session.js";
import { BrowserProfileStore, defaultBrowserPreferences, parseBrowserPreferences, type BrowserProfileMetadata } from "./profile-store.js";

interface Tab {
  readonly id: string;
  readonly scope: DesktopBrowserScope;
  readonly view: WebContentsView;
  readonly debug: BrowserDebugLog;
  readonly webMcp: BrowserWebMcp;
  url: string;
  allowedOrigin: string;
  navigationRevision: number;
  control: "human" | "agent";
  error?: string;
  busy: boolean;
}

export class BrowserPageError extends Error {
  constructor(readonly code: string, readonly effect: "none" | "unknown" = "none") { super(code); }
}

export function desktopBrowserPartition(workspaceCwd: string): string {
  return `persist:ling-browser-${createHash("sha256").update(workspaceCwd).digest("hex").slice(0, 32)}`;
}

export class DesktopBrowserManager {
  private generationValue = Date.now();
  private revision = 0;
  private readonly tabs = new Map<string, Tab>();
  private readonly activeTabs = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly addressFocusListeners = new Set<() => void>();
  private readonly session: Session;
  private readonly management: BrowserManagement;
  private clearing = false;
  private readonly electron: typeof import("electron");
  private owner?: BrowserWindow;
  private attached?: Tab;
  private layoutTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private readonly profileStore: BrowserProfileStore;
  private preferences: DesktopBrowserPreferences = { ...defaultBrowserPreferences };
  private restoration: BrowserProfileMetadata["tabs"] = [];
  private restoring = false;
  private persistenceError = false;
  private closingWindow = false;
  private selecting?: Tab;
  private workspaceActive = true;

  constructor(private readonly options: {
    readonly workspaceCwd: string; readonly desktopInstanceId: string; readonly daemonBaseUrl: string;
    readonly getMainWindow: () => BrowserWindow | undefined;
    readonly profileDirectory?: string;
    readonly onDiagnostic?: (code: string) => void;
  }) {
    this.profileStore = new BrowserProfileStore(options.workspaceCwd, options.profileDirectory);
    try {
      const metadata = this.profileStore.read();
      this.preferences = metadata.preferences; this.restoration = metadata.preferences.restoreTabs ? metadata.tabs : [];
    } catch { this.persistenceError = true; options.onDiagnostic?.("browser_profile_unreadable"); }
    this.electron = createRequire(import.meta.url)("electron") as typeof import("electron");
    this.session = this.electron.session.fromPartition(desktopBrowserPartition(options.workspaceCwd), { cache: true });
    this.management = new BrowserManagement({ session: this.session, workspaceCwd: options.workspaceCwd, directory: options.profileDirectory,
      getMainWindow: options.getMainWindow, tab: id => { const tab = [...this.tabs.values()].find(tab => tab.view.webContents.id === id); return tab ? { url: tab.url, control: tab.control } : undefined; }, changed: () => this.changed() });
    configureBrowserSession(this.session, {
      requestCompleted: (id, url, status, method, type) => [...this.tabs.values()].find(tab => tab.view.webContents.id === id)?.debug.add({ kind: "network", url: debugUrl(url), status, method, type }),
      permission: (id, permission, origin) => this.management.permission(id, permission, origin),
      download: (event, item, contents) => this.management.willDownload(event, item, contents),
      forbiddenOrigins: [new URL(options.daemonBaseUrl).origin],
      tabOrigin: id => [...this.tabs.values()].find(tab => tab.view.webContents.id === id)?.allowedOrigin,
      reportBlocked: (id, code) => {
        const tab = [...this.tabs.values()].find(item => item.view.webContents.id === id);
        if (tab) { tab.error = code; this.changed(); }
      },
    });
  }

  get generation(): number { return this.generationValue; }
  prepareWindowClose(): void { this.pause(); this.persistProfile(); this.closingWindow = true; this.hide(); }
  resumePersistence(): void { this.closingWindow = false; }
  state(): DesktopBrowserState {
    return { protocol: DESKTOP_BROWSER_PROTOCOL, desktopInstanceId: this.options.desktopInstanceId, generation: this.generation,
      revision: this.revision, workspaceCwd: this.options.workspaceCwd, tabs: [...this.tabs.values()].map(tab => this.project(tab)) };
  }
  workspace(input: DesktopBrowserWorkspace): DesktopBrowserWorkspaceState {
    this.assertWorkspace(input);
    const tabs = [...this.tabs.values()].filter(tab => sameDesktopBrowserScope(tab.scope, input.scope)).map(tab => this.project(tab));
    const activeTabId = this.activeTabs.get(scopeKey(input.scope));
    return { generation: this.generation, revision: this.revision, tabs, management: this.management.state(), preferences: { ...this.preferences },
      ...(this.persistenceError ? { persistenceError: true } : {}), ...(activeTabId ? { activeTabId } : {}) };
  }

  async settingsState(workspaceCwd: string): Promise<BrowserManagementState> {
    this.assertWorkspaceCwd(workspaceCwd);
    await this.management.ready();
    return this.management.state();
  }
  async profileSize(workspaceCwd: string, scope: DeviceStorageScope = "current"): Promise<DeviceStorageCategorySize> {
    this.assertWorkspaceCwd(workspaceCwd);
    if (scope === "current") return measureBrowserProfileSize(this.session.getStoragePath(), this.profileStore.metadataPath);
    const registry = createWorkspaceRegistryStore();
    const workspaces = new Set<string>([workspaceCwd]);
    try {
      let cursor = "";
      for (;;) {
        const page = registry.listWorkspaces(cursor, 500);
        for (const entry of page) workspaces.add(entry.canonicalCwd);
        if (page.length < 500 || workspaces.size >= 5_000) break;
        cursor = page.at(-1)!.workspaceId;
      }
    } finally { registry.close(); }
    let bytes = 0;
    let incomplete = workspaces.size >= 5_000;
    const deadline = Date.now() + 20_000;
    for (const cwd of workspaces) {
      if (Date.now() >= deadline) { incomplete = true; break; }
      const partition = this.electron.session.fromPartition(desktopBrowserPartition(cwd));
      const metadata = new BrowserProfileStore(cwd, this.options.profileDirectory);
      const result = await measureBrowserProfileSize(partition.getStoragePath(), metadata.metadataPath, deadline);
      bytes += result.knownBytes;
      incomplete ||= result.status !== "complete";
    }
    return { category: "browser", knownBytes: bytes, status: incomplete ? "partial" : "complete",
      ...(incomplete ? { reason: "browser_profile_unavailable" as const } : {}) };
  }

  async actSettings(input: DesktopBrowserSettingsAction, assertCurrent: () => void = () => {}): Promise<BrowserManagementState> {
    this.assertWorkspaceCwd(input.workspaceCwd);
    await this.management.ready();
    assertCurrent();
    if (this.clearing) throw new BrowserPageError("browser_data_clearing");
    if (input.action === "history_clear") this.management.clearHistory(input.since, input.id);
    else if (input.action === "download_preferences") { this.management.store.data.askBeforeDownload = input.askBeforeDownload; this.management.store.save(); this.changed(); }
    else if (input.action === "download_directory") await this.management.chooseDownloadDirectory();
    else if (input.action === "device_permission") {
      this.pause(); await this.management.setDeviceRule(input.rule);
      for (const tab of this.tabs.values()) if (new URL(tab.url).origin === input.rule.origin) { this.invalidate(tab); tab.view.webContents.reload(); }
    } else if (input.action === "clear_data") {
      this.clearing = true; this.pause(); this.hide();
      try { if (await this.management.clear(input)) { for (const tab of [...this.tabs.values()]) this.closeTab(tab); this.rotateGeneration(); } }
      finally { this.clearing = false; }
    }
    assertCurrent();
    return this.management.state();
  }

  async restore(): Promise<void> {
    if (this.restoring || !this.restoration.length || this.disposed) return;
    this.restoring = true;
    const metadata = this.restoration; this.restoration = [];
    try {
      const restored = await Promise.all(metadata.map(async item => {
        try { return { item, tab: await this.createTab(item.scope, item.url, "human", () => {
          if (this.disposed) throw new BrowserPageError("browser_closed");
        }) }; } catch { this.options.onDiagnostic?.("browser_tab_restore_failed"); return undefined; }
      }));
      const ids = new Set(restored.flatMap(item => item ? [item.tab.id] : []));
      for (const entry of restored) if (entry?.item.active && ids.has(this.activeTabs.get(scopeKey(entry.item.scope)) ?? "")) {
        this.activeTabs.set(scopeKey(entry.item.scope), entry.tab.id);
      }
    } finally { this.restoring = false; if (!this.disposed) this.changed(); }
  }
  onChanged(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onAddressFocusRequested(listener: () => void): () => void { this.addressFocusListeners.add(listener); return () => this.addressFocusListeners.delete(listener); }

  async act(input: DesktopBrowserUserAction, assertCurrent: () => void = () => {}): Promise<DesktopBrowserWorkspaceState> {
    this.assertWorkspace(input);
    await this.management.ready();
    assertCurrent();
    if (this.clearing) throw new BrowserPageError("browser_data_clearing");
    if (input.action === "activate_workspace" || input.action === "deactivate_workspace") return this.workspace(input);
    if (input.action === "history_clear" || input.action === "download_preferences" || input.action === "download_directory"
      || input.action === "device_permission" || input.action === "clear_data") {
      await this.actSettings(input, assertCurrent);
      return this.workspace(input);
    }
    if (input.action === "download_cancel" || input.action === "download_show") this.management.downloadAction(input.id, input.action === "download_cancel" ? "cancel" : "show");
    else if (input.action === "import_preview") await this.management.previewImport();
    else if (input.action === "import_apply") this.management.applyImport(input.urls);
    else if (input.action === "extension_install") { this.pause(); await this.management.installExtension(); }
    else if (input.action === "extension_remove") { this.pause(); this.management.removeExtension(input.id); }
    else return this.actPage(input as Exclude<DesktopBrowserUserAction, { action: "activate_workspace" | "deactivate_workspace" | "history_clear" | "clear_data" | "download_preferences" | "download_directory" | "download_cancel" | "download_show" | "device_permission" | "import_preview" | "import_apply" | "extension_install" | "extension_remove" }>, assertCurrent);
    assertCurrent(); return this.workspace(input);
  }

  private async actPage(input: Exclude<DesktopBrowserUserAction, { action: "activate_workspace" | "deactivate_workspace" | "history_clear" | "clear_data" | "download_preferences" | "download_directory" | "download_cancel" | "download_show" | "device_permission" | "import_preview" | "import_apply" | "extension_install" | "extension_remove" }>, assertCurrent: () => void): Promise<DesktopBrowserWorkspaceState> {
    if (input.action === "annotate") return this.annotate(input, assertCurrent);
    if (input.action === "locate_annotation") {
      const a = input.annotation;
      if (a.workspaceCwd !== input.workspaceCwd || !sameDesktopBrowserScope(a.scope, input.scope)) throw new BrowserPageError("browser_annotation_forbidden");
      const tab = this.tabs.get(a.tabId);
      const available = Boolean(tab && sameDesktopBrowserScope(tab.scope, input.scope) && !tab.view.webContents.isDestroyed() && a.generation === this.generation && a.navigationRevision === tab.navigationRevision && a.url === tab.url
        && await tab.view.webContents.executeJavaScriptInIsolatedWorld(1008, [{ code: browserAnnotationScript({ action: "locate", anchor: a.anchor }) }]));
      assertCurrent(); return { ...this.workspace(input), annotationStatus: available ? "available" : "stale" };
    }
    if (input.action === "open_link") {
      const url = parseDesktopBrowserUrl(input.url);
      const openedIn = isBrowserLoopback(new URL(url).hostname) ? this.preferences.localhostLinks : this.preferences.websiteLinks;
      if (openedIn === "system") await this.electron.shell.openExternal(url);
      else await this.createTab(input.scope, url, "human", assertCurrent);
      return { ...this.workspace(input), openedIn };
    }
    if (input.action === "preferences") { this.preferences = parseBrowserPreferences(input.preferences); this.changed(); }
    else if (input.action === "open") await this.createTab(input.scope, input.url, "human", assertCurrent);
    else {
      const tab = this.getTab(input.tabId, input.scope);
      if (input.action === "activate") {
        this.hide(); this.activeTabs.set(scopeKey(input.scope), tab.id); this.changed();
      } else if (input.action === "close") this.closeTab(tab);
      else if (input.action === "open_external") await this.electron.shell.openExternal(parseDesktopBrowserUrl(tab.url));
      else if (input.action === "release_control") { this.invalidate(tab); tab.control = "agent"; if (this.management.store.data.devices.some(rule => rule.origin === new URL(tab.url).origin && rule.decision === "allow")) tab.view.webContents.reload(); this.changed(); }
      else {
        this.takeControl(tab);
        if (input.action === "navigate") await this.navigate(tab, input.url, assertCurrent);
        else if (input.action === "back" && tab.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack();
        else if (input.action === "forward" && tab.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward();
        else if (input.action === "reload") tab.view.webContents.reload();
        else if (input.action === "stop") tab.view.webContents.stop();
      }
    }
    return this.workspace(input);
  }

  reportViewport(input: DesktopBrowserViewport): void {
    this.assertWorkspace(input);
    const window = this.options.getMainWindow();
    if (this.clearing || !input.visible || !input.tabId || input.generation !== this.generation || !window || window.isDestroyed()
      || !window.isVisible() || window.isMinimized() || this.activeTabs.get(scopeKey(input.scope)) !== input.tabId) { this.hide(); return; }
    const tab = this.getTab(input.tabId, input.scope), zoom = window.webContents.getZoomFactor();
    const [width, height] = window.getContentSize();
    const x = Math.max(0, Math.round(input.bounds.x * zoom)), y = Math.max(0, Math.round(input.bounds.y * zoom));
    const bounds = { x, y, width: Math.min(Math.round(input.bounds.width * zoom), width - x), height: Math.min(Math.round(input.bounds.height * zoom), height - y) };
    if (bounds.width < 1 || bounds.height < 1) { this.hide(); return; }
    if (this.owner !== window || this.attached !== tab) {
      this.hide(); this.owner = window; this.attached = tab;
      window.contentView.addChildView(tab.view);
    }
    tab.view.setBounds(bounds); tab.view.setVisible(true);
    if (this.layoutTimer) clearTimeout(this.layoutTimer);
    this.layoutTimer = setTimeout(() => this.hide(), 1500);
  }

  async execute(command: DesktopBrowserCommand, signal: AbortSignal): Promise<unknown> {
    await this.management.ready();
    this.assertCommand(command, signal);
    if (command.method === "browser_history") {
      const query = command.params.query?.toLowerCase() ?? "";
      return this.management.store.data.history.filter(item => `${item.url} ${item.title}`.toLowerCase().includes(query)).slice(0, command.params.limit ?? 20);
    }
    if (command.method === "browser_tabs") return this.workspace({ workspaceCwd: command.workspaceCwd, scope: command.scope }).tabs;
    if (command.method === "browser_navigate" && !command.params.tabId) {
      const tab = await this.createTab(command.scope, command.params.url, "agent", () => this.assertCommand(command, signal));
      return this.project(tab);
    }
    const params = command.params;
    if (!("tabId" in params) || !params.tabId) throw new BrowserPageError("browser_target_required");
    const tab = this.getTab(params.tabId, command.scope);
    const assertCurrent = (): void => {
      this.assertCommand(command, signal);
      if (!this.tabs.has(tab.id) || tab.control !== "agent" || tab.navigationRevision !== params.navigationRevision) throw new BrowserPageError("browser_target_stale_or_paused");
    };
    assertCurrent();
    if (tab.busy) throw new BrowserPageError("browser_tab_busy");
    if (tab.view.webContents.isLoading()) throw new BrowserPageError("browser_page_loading");
    tab.busy = true;
    let effectStarted = false;
    try {
      if (command.method === "browser_navigate") {
        await this.navigate(tab, command.params.url, () => { assertCurrent(); effectStarted = true; });
        return this.project(tab);
      }
      if (command.method === "browser_download") {
        const url = parseDesktopBrowserUrl(command.params.url); await this.assertUrl(url); assertCurrent();
        if (new URL(url).origin !== new URL(tab.url).origin) throw new BrowserPageError("browser_download_origin_mismatch");
        effectStarted = true; this.management.authorizeDownload(tab.view.webContents, url); return { requested: true, url };
      }
      if (command.method === "browser_debug") { const result = await tab.debug.read(); assertCurrent(); return result; }
      if (command.method === "browser_webmcp_tools") { const result = await tab.webMcp.list(); assertCurrent(); return result; }
      if (command.method === "browser_webmcp_call") { effectStarted = true; const result = await tab.webMcp.call(command.params.name, command.params.arguments, command.params.toolRevision, signal); assertCurrent(); return result; }
      if (command.method === "browser_cdp") {
        const allowed = await this.management.confirmCdp(new URL(tab.url).origin, command.params.method, command.params.params);
        assertCurrent(); if (!allowed) throw new BrowserPageError("browser_cdp_denied");
        effectStarted = true; const result = await tab.debug.cdp(command.params.method, command.params.params); assertCurrent(); return { result };
      }
      if (command.method === "browser_screenshot") {
        const image = await tab.view.webContents.capturePage(undefined, { stayHidden: true });
        assertCurrent();
        if (image.isEmpty()) throw new BrowserPageError("browser_screenshot_empty");
        const size = image.getSize();
        const scale = Math.min(1, 1600 / size.width, 1200 / size.height);
        const normalized = scale < 1 ? image.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale), quality: "good" }) : image;
        const data = normalized.toJPEG(70).toString("base64");
        if (data.length > 1024 * 1024) throw new BrowserPageError("browser_screenshot_too_large");
        return { tabId: tab.id, navigationRevision: tab.navigationRevision, mimeType: "image/jpeg", data };
      }
      const request = command.method === "browser_snapshot" ? { action: "snapshot" as const, revision: randomUUID() }
        : { action: command.method === "browser_click" ? "click" as const : "type" as const, revision: command.params.snapshotRevision,
          ref: command.params.ref, ...(command.method === "browser_type" ? { text: command.params.text } : {}) };
      assertCurrent();
      effectStarted = command.method === "browser_click" || command.method === "browser_type";
      const response: unknown = await tab.view.webContents.executeJavaScriptInIsolatedWorld(1007, [{ code: browserPageScript(request) }]);
      if (!response || typeof response !== "object" || !("ok" in response)) throw new BrowserPageError("browser_page_result_invalid");
      if (!response.ok) throw new BrowserPageError("error" in response && typeof response.error === "string" ? response.error : "browser_page_execution_failed");
      const value = "value" in response ? response.value : undefined;
      this.assertCommand(command, signal);
      if (command.method === "browser_snapshot") {
        assertCurrent();
        return { ...(value as object), tabId: tab.id, navigationRevision: tab.navigationRevision, url: tab.url, title: this.project(tab).title };
      }
      return { ok: true, tabId: tab.id, navigationRevision: tab.navigationRevision, snapshotInvalidated: true };
    } catch (error) {
      if (error instanceof BrowserPageError) throw new BrowserPageError(error.code, effectStarted ? "unknown" : error.effect);
      const message = error instanceof Error ? error.message : "";
      const code = /browser_[a-z_]+/u.exec(message)?.[0] ?? "browser_operation_failed";
      throw new BrowserPageError(code, effectStarted ? "unknown" : "none");
    } finally { tab.busy = false; }
  }

  pause(): void { for (const tab of this.tabs.values()) if (tab.control === "agent") this.takeControl(tab); }
  setWorkspaceActive(active: boolean): void { if (this.workspaceActive === active) return; this.workspaceActive = active; this.rotateGeneration(); }
  rotateGeneration(): void { this.pause(); this.generationValue = Math.max(Date.now(), this.generationValue + 1); this.hide(); this.changed(); }
  hide(): void {
    if (this.layoutTimer) clearTimeout(this.layoutTimer);
    this.layoutTimer = undefined;
    if (this.selecting && !this.selecting.view.webContents.isDestroyed()) {
      void this.selecting.view.webContents.executeJavaScriptInIsolatedWorld(1008, [{ code: browserAnnotationScript({ action: "cancel" }) }]).catch(() => undefined); this.selecting = undefined;
    }
    if (this.attached) {
      this.attached.view.setVisible(false);
      if (this.owner && !this.owner.isDestroyed()) this.owner.contentView.removeChildView(this.attached.view);
    }
    this.attached = undefined; this.owner = undefined;
  }
  dispose(): void {
    if (this.disposed) return;
    this.persistProfile();
    this.management.dispose();
    this.closingWindow = true;
    this.disposed = true; this.hide();
    for (const tab of [...this.tabs.values()]) this.closeTab(tab);
    this.listeners.clear(); this.addressFocusListeners.clear();
  }

  private async annotate(input: Extract<DesktopBrowserUserAction, { action: "annotate" }>, assertCurrent: () => void): Promise<DesktopBrowserWorkspaceState> {
    const tab = this.getTab(input.tabId, input.scope);
    if (this.attached !== tab || this.selecting || tab.busy || tab.view.webContents.isLoading()) throw new BrowserPageError("browser_annotation_unavailable");
    this.takeControl(tab); this.selecting = tab;
    const generation = this.generation, revision = tab.navigationRevision;
    try {
      const result: unknown = await tab.view.webContents.executeJavaScriptInIsolatedWorld(1008, [{ code: browserAnnotationScript({ action: "select", kind: input.kind }) }]);
      assertCurrent();
      if (!result) return this.workspace(input);
      const anchor = parseBrowserAnnotationAnchor(result);
      if (generation !== this.generation || revision !== tab.navigationRevision || !this.tabs.has(tab.id)) throw new BrowserPageError("browser_annotation_stale");
      let screenshot: DesktopBrowserAnnotation["screenshot"];
      if (input.screenshot) {
        const r = anchor.rect;
        const image = await tab.view.webContents.capturePage({ x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) });
        if (!image.isEmpty()) {
          const size = image.getSize(), scale = Math.min(1, 1200 / size.width, 900 / size.height);
          const normalized = scale < 1 ? image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }) : image;
          const data = normalized.toJPEG(70).toString("base64"); if (data.length <= 1024 * 1024) screenshot = { mimeType: "image/jpeg", data };
        }
      }
      assertCurrent();
      if (generation !== this.generation || revision !== tab.navigationRevision) throw new BrowserPageError("browser_annotation_stale");
      return { ...this.workspace(input), annotation: { version: 1, id: randomUUID(), workspaceCwd: input.workspaceCwd, scope: input.scope, generation,
        tabId: tab.id, navigationRevision: revision, url: tab.url, origin: new URL(tab.url).origin, anchor, ...(screenshot ? { screenshot } : {}) } };
    } finally { if (this.selecting === tab) this.selecting = undefined; }
  }

  private async createTab(scope: DesktopBrowserScope, value: string, control: Tab["control"], assertCurrent: () => void = () => {}): Promise<Tab> {
    const url = parseDesktopBrowserUrl(value);
    await this.assertUrl(url); assertCurrent();
    if (this.disposed || this.tabs.size >= DESKTOP_BROWSER_MAX_TABS) throw new BrowserPageError("browser_tab_budget_exceeded");
    const view = new this.electron.WebContentsView({ webPreferences: { session: this.session, sandbox: true,
      contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true,
      allowRunningInsecureContent: false, webviewTag: false, plugins: false, safeDialogs: true, disableDialogs: true,
      navigateOnDragDrop: false, spellcheck: false, enableBlinkFeatures: "WebMCP" } });
    view.setBounds({ x: 0, y: 0, width: 1024, height: 768 }); view.setVisible(false);
    const tab: Tab = { id: randomUUID(), scope: { ...scope }, view, debug: new BrowserDebugLog(view.webContents), webMcp: new BrowserWebMcp(view.webContents), url, allowedOrigin: new URL(url).origin,
      navigationRevision: 0, control, busy: false };
    this.tabs.set(tab.id, tab); this.activeTabs.set(scopeKey(scope), tab.id);
    this.observe(tab); this.changed();
    try { await this.navigate(tab, url, assertCurrent); return tab; }
    catch (error) { if (control === "agent") this.takeControl(tab); throw error; }
  }

  private async navigate(tab: Tab, value: string, assertCurrent: () => void = () => {}): Promise<void> {
    const url = parseDesktopBrowserUrl(value);
    await this.assertUrl(url); assertCurrent();
    if (!this.tabs.has(tab.id)) throw new BrowserPageError("browser_tab_closed");
    tab.allowedOrigin = new URL(url).origin; tab.error = undefined; this.invalidate(tab);
    await tab.view.webContents.loadURL(url);
  }
  private observe(tab: Tab): void {
    const wc = tab.view.webContents;
    wc.setWindowOpenHandler(() => { tab.error = "browser_popup_blocked"; this.changed(); return { action: "deny" }; });
    wc.on("will-attach-webview", event => event.preventDefault());
    wc.on("will-frame-navigate", event => {
      try {
        const origin = new URL(parseDesktopBrowserUrl(event.url)).origin;
        if (event.isMainFrame && tab.control === "agent" && origin !== tab.allowedOrigin) throw new Error("browser_cross_origin_navigation_requires_approval");
      } catch { event.preventDefault(); tab.error = "browser_navigation_blocked"; this.changed(); }
    });
    wc.on("will-redirect", (event, url, _inPlace, isMainFrame) => {
      try {
        const origin = new URL(parseDesktopBrowserUrl(url)).origin;
        if (isMainFrame && tab.control === "agent" && origin !== tab.allowedOrigin) throw new Error("browser_redirect_blocked");
      } catch { event.preventDefault(); tab.error = "browser_redirect_blocked"; this.changed(); }
    });
    wc.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) { tab.navigationRevision++; tab.debug.reset(); tab.webMcp.reset(); this.changed(); } });
    const navigated = (): void => {
      try { tab.url = parseDesktopBrowserUrl(wc.getURL()); } catch { /* The requested URL remains while the initial document is empty. */ }
      if (tab.control === "human") tab.allowedOrigin = new URL(tab.url).origin;
      this.management.store.record(tab.url, wc.getTitle()); this.changed();
    };
    wc.on("did-navigate", navigated);
    wc.on("did-navigate-in-page", (_event, _url, isMainFrame) => { if (isMainFrame) { this.invalidate(tab); navigated(); } });
    wc.on("did-start-loading", () => this.changed());
    wc.on("did-stop-loading", () => this.changed());
    wc.on("page-title-updated", () => { this.management.store.updateTitle(tab.url, wc.getTitle()); this.changed(); });
    wc.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) { tab.error = "browser_page_load_failed"; this.changed(); }
    });
    wc.on("before-input-event", (event, input) => {
      if (this.selecting === tab) {
        event.preventDefault();
        if (input.type === "keyDown" && input.key === "Escape") void wc.executeJavaScriptInIsolatedWorld(1008, [{ code: browserAnnotationScript({ action: "cancel" }) }]).catch(() => undefined);
        return;
      }
      if (input.type !== "keyDown") return;
      this.takeControl(tab); this.management.recordGesture(wc.id);
      if (this.attached === tab && (input.meta || input.control) && input.key.toLowerCase() === "l") {
        event.preventDefault(); this.options.getMainWindow()?.webContents.focus();
        for (const listener of this.addressFocusListeners) listener();
      }
    });
    wc.on("before-mouse-event", (event, input) => {
      if (this.selecting === tab) {
        event.preventDefault();
        if (input.type === "mouseDown" || input.type === "mouseUp" || input.type === "mouseMove") void wc.executeJavaScriptInIsolatedWorld(1008, [{ code: browserAnnotationScript({ action: "pointer", phase: input.type === "mouseDown" ? "down" : input.type === "mouseUp" ? "up" : "move", x: input.x, y: input.y }) }]).catch(() => undefined);
      } else if (input.type === "mouseDown" || input.type === "mouseWheel") { this.takeControl(tab); if (input.type === "mouseDown") this.management.recordGesture(wc.id); }
    });
    wc.on("render-process-gone", () => { this.takeControl(tab); tab.error = "browser_page_crashed"; this.changed(); });
    wc.on("login", (event, _details, _info, callback) => { event.preventDefault(); callback(); });
    wc.once("destroyed", () => { if (this.tabs.has(tab.id)) { this.tabs.delete(tab.id); this.changed(); } });
  }
  private closeTab(tab: Tab): void {
    if (this.attached === tab) this.hide();
    tab.debug.detach(); tab.webMcp.reset(); this.tabs.delete(tab.id);
    const key = scopeKey(tab.scope);
    if (this.activeTabs.get(key) === tab.id) {
      const next = [...this.tabs.values()].find(item => sameDesktopBrowserScope(item.scope, tab.scope));
      if (next) this.activeTabs.set(key, next.id); else this.activeTabs.delete(key);
    }
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
    this.changed();
  }
  private takeControl(tab: Tab): void { this.management.pauseAgent(tab.view.webContents.id); tab.debug.detach(); tab.webMcp.reset(); if (tab.control === "agent") { tab.control = "human"; this.invalidate(tab); this.changed(); } }
  private invalidate(tab: Tab): void {
    tab.navigationRevision++; tab.debug.detach(); tab.webMcp.reset();
    if (!tab.view.webContents.isDestroyed()) void tab.view.webContents.executeJavaScriptInIsolatedWorld(1007, [{ code: browserPageScript({ action: "invalidate" }) }]).catch(() => undefined);
  }
  private getTab(id: string, scope: DesktopBrowserScope): Tab {
    const tab = this.tabs.get(id);
    if (!tab || tab.view.webContents.isDestroyed() || !sameDesktopBrowserScope(tab.scope, scope)) throw new BrowserPageError("browser_tab_forbidden");
    return tab;
  }
  private project(tab: Tab): DesktopBrowserTab {
    const wc = tab.view.webContents;
    return { id: tab.id, scope: tab.scope, url: tab.url, title: wc.isDestroyed() ? "" : wc.getTitle().replace(/\0/gu, "").slice(0, 512), navigationRevision: tab.navigationRevision,
      loading: !wc.isDestroyed() && wc.isLoading(), canGoBack: !wc.isDestroyed() && wc.navigationHistory.canGoBack(),
      canGoForward: !wc.isDestroyed() && wc.navigationHistory.canGoForward(), control: tab.control, ...(tab.error ? { error: tab.error } : {}) };
  }
  private assertWorkspace(input: DesktopBrowserWorkspace): void { this.assertWorkspaceCwd(input.workspaceCwd); }
  private assertWorkspaceCwd(workspaceCwd: string): void { if (this.disposed || workspaceCwd !== this.options.workspaceCwd) throw new BrowserPageError("browser_workspace_unavailable"); }
  private assertCommand(command: DesktopBrowserCommand, signal: AbortSignal): void {
    if (this.clearing) throw new BrowserPageError("browser_data_clearing");
    if (!this.workspaceActive) throw new BrowserPageError("browser_workspace_paused");
    signal.throwIfAborted();
    if (this.disposed || command.workspaceCwd !== this.options.workspaceCwd || command.generation !== this.generation
      || command.desktopInstanceId !== this.options.desktopInstanceId || Date.parse(command.deadlineAt) <= Date.now()) throw new BrowserPageError("browser_command_expired_or_replaced");
  }
  private assertUrl(url: string): Promise<void> {
    return assertBrowserNetworkUrl(url, { allowedLoopbackOrigin: isBrowserLoopback(new URL(url).hostname) ? new URL(url).origin : undefined,
      forbiddenOrigins: [new URL(this.options.daemonBaseUrl).origin] });
  }
  private persistProfile(): void {
    if (this.disposed || this.restoring || this.persistenceError || this.closingWindow) return;
    try {
      this.profileStore.write({ version: 1, workspaceCwd: this.options.workspaceCwd, preferences: this.preferences,
        tabs: this.preferences.restoreTabs ? [...this.tabs.values()].map(tab => ({ scope: tab.scope, url: tab.url,
          active: this.activeTabs.get(scopeKey(tab.scope)) === tab.id })) : [] });
    } catch { this.persistenceError = true; this.options.onDiagnostic?.("browser_profile_write_failed"); }
  }
  private changed(): void { this.persistProfile(); this.revision++; for (const listener of this.listeners) listener(); }
}

function scopeKey(scope: DesktopBrowserScope): string { return JSON.stringify([scope.surface, scope.ownerId]); }
