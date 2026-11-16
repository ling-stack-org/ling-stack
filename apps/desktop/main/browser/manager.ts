import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { BrowserWindow, WebContentsView, Session } from "electron";
import {
  DESKTOP_BROWSER_MAX_TABS, DESKTOP_BROWSER_PROTOCOL, parseDesktopBrowserUrl, sameDesktopBrowserScope,
  type DesktopBrowserScope, type DesktopBrowserState, type DesktopBrowserTab, type DesktopBrowserCommand,
} from "@ling-stack/contracts";
import type { DesktopBrowserUserAction, DesktopBrowserViewport, DesktopBrowserWorkspace, DesktopBrowserWorkspaceState } from "../../shared/browser-capabilities.js";
import { browserPageScript } from "./page-runtime.js";
import { assertBrowserNetworkUrl, isBrowserLoopback } from "./url-policy.js";
import { configureBrowserSession } from "./session.js";

interface Tab {
  readonly id: string;
  readonly scope: DesktopBrowserScope;
  readonly view: WebContentsView;
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
  private readonly electron: typeof import("electron");
  private owner?: BrowserWindow;
  private attached?: Tab;
  private layoutTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private readonly options: {
    readonly workspaceCwd: string; readonly desktopInstanceId: string; readonly daemonBaseUrl: string;
    readonly getMainWindow: () => BrowserWindow | undefined;
  }) {
    this.electron = createRequire(import.meta.url)("electron") as typeof import("electron");
    this.session = this.electron.session.fromPartition(desktopBrowserPartition(options.workspaceCwd), { cache: true });
    configureBrowserSession(this.session, {
      forbiddenOrigins: [new URL(options.daemonBaseUrl).origin],
      tabOrigin: id => [...this.tabs.values()].find(tab => tab.view.webContents.id === id)?.allowedOrigin,
      reportBlocked: (id, code) => {
        const tab = [...this.tabs.values()].find(item => item.view.webContents.id === id);
        if (tab) { tab.error = code; this.changed(); }
      },
    });
  }

  get generation(): number { return this.generationValue; }
  state(): DesktopBrowserState {
    return { protocol: DESKTOP_BROWSER_PROTOCOL, desktopInstanceId: this.options.desktopInstanceId, generation: this.generation,
      revision: this.revision, workspaceCwd: this.options.workspaceCwd, tabs: [...this.tabs.values()].map(tab => this.project(tab)) };
  }
  workspace(input: DesktopBrowserWorkspace): DesktopBrowserWorkspaceState {
    this.assertWorkspace(input);
    const tabs = [...this.tabs.values()].filter(tab => sameDesktopBrowserScope(tab.scope, input.scope)).map(tab => this.project(tab));
    const activeTabId = this.activeTabs.get(scopeKey(input.scope));
    return { generation: this.generation, revision: this.revision, tabs, ...(activeTabId ? { activeTabId } : {}) };
  }
  onChanged(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onAddressFocusRequested(listener: () => void): () => void { this.addressFocusListeners.add(listener); return () => this.addressFocusListeners.delete(listener); }

  async act(input: DesktopBrowserUserAction, assertCurrent: () => void = () => {}): Promise<DesktopBrowserWorkspaceState> {
    this.assertWorkspace(input);
    assertCurrent();
    if (input.action === "open") await this.createTab(input.scope, input.url, "human", assertCurrent);
    else {
      const tab = this.getTab(input.tabId, input.scope);
      if (input.action === "activate") {
        this.hide(); this.activeTabs.set(scopeKey(input.scope), tab.id); this.changed();
      } else if (input.action === "close") this.closeTab(tab);
      else if (input.action === "open_external") await this.electron.shell.openExternal(parseDesktopBrowserUrl(tab.url));
      else if (input.action === "release_control") { this.invalidate(tab); tab.control = "agent"; this.changed(); }
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
    if (!input.visible || !input.tabId || input.generation !== this.generation || !window || window.isDestroyed()
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
    this.assertCommand(command, signal);
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
  rotateGeneration(): void { this.pause(); this.generationValue = Math.max(Date.now(), this.generationValue + 1); this.hide(); this.changed(); }
  hide(): void {
    if (this.layoutTimer) clearTimeout(this.layoutTimer);
    this.layoutTimer = undefined;
    if (this.attached) {
      this.attached.view.setVisible(false);
      if (this.owner && !this.owner.isDestroyed()) this.owner.contentView.removeChildView(this.attached.view);
    }
    this.attached = undefined; this.owner = undefined;
  }
  dispose(): void {
    this.disposed = true; this.hide();
    for (const tab of [...this.tabs.values()]) this.closeTab(tab);
    this.listeners.clear(); this.addressFocusListeners.clear();
  }

  private async createTab(scope: DesktopBrowserScope, value: string, control: Tab["control"], assertCurrent: () => void = () => {}): Promise<Tab> {
    const url = parseDesktopBrowserUrl(value);
    await this.assertUrl(url); assertCurrent();
    if (this.disposed || this.tabs.size >= DESKTOP_BROWSER_MAX_TABS) throw new BrowserPageError("browser_tab_budget_exceeded");
    const view = new this.electron.WebContentsView({ webPreferences: { session: this.session, sandbox: true,
      contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true,
      allowRunningInsecureContent: false, webviewTag: false, plugins: false, safeDialogs: true, disableDialogs: true,
      navigateOnDragDrop: false, spellcheck: false } });
    view.setBounds({ x: 0, y: 0, width: 1024, height: 768 }); view.setVisible(false);
    const tab: Tab = { id: randomUUID(), scope: { ...scope }, view, url, allowedOrigin: new URL(url).origin,
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
    wc.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) { tab.navigationRevision++; this.changed(); } });
    const navigated = (): void => {
      try { tab.url = parseDesktopBrowserUrl(wc.getURL()); } catch { /* The requested URL remains while the initial document is empty. */ }
      if (tab.control === "human") tab.allowedOrigin = new URL(tab.url).origin;
      this.changed();
    };
    wc.on("did-navigate", navigated);
    wc.on("did-navigate-in-page", (_event, _url, isMainFrame) => { if (isMainFrame) { this.invalidate(tab); navigated(); } });
    wc.on("did-start-loading", () => this.changed());
    wc.on("did-stop-loading", () => this.changed());
    wc.on("page-title-updated", () => this.changed());
    wc.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) { tab.error = "browser_page_load_failed"; this.changed(); }
    });
    wc.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      this.takeControl(tab);
      if (this.attached === tab && (input.meta || input.control) && input.key.toLowerCase() === "l") {
        event.preventDefault(); this.options.getMainWindow()?.webContents.focus();
        for (const listener of this.addressFocusListeners) listener();
      }
    });
    wc.on("before-mouse-event", (_event, input) => { if (input.type === "mouseDown" || input.type === "mouseWheel") this.takeControl(tab); });
    wc.on("render-process-gone", () => { this.takeControl(tab); tab.error = "browser_page_crashed"; this.changed(); });
    wc.on("login", (event, _details, _info, callback) => { event.preventDefault(); callback(); });
    wc.once("destroyed", () => { if (this.tabs.has(tab.id)) { this.tabs.delete(tab.id); this.changed(); } });
  }
  private closeTab(tab: Tab): void {
    if (this.attached === tab) this.hide();
    this.tabs.delete(tab.id);
    const key = scopeKey(tab.scope);
    if (this.activeTabs.get(key) === tab.id) {
      const next = [...this.tabs.values()].find(item => sameDesktopBrowserScope(item.scope, tab.scope));
      if (next) this.activeTabs.set(key, next.id); else this.activeTabs.delete(key);
    }
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
    this.changed();
  }
  private takeControl(tab: Tab): void { if (tab.control === "agent") { tab.control = "human"; this.invalidate(tab); this.changed(); } }
  private invalidate(tab: Tab): void {
    tab.navigationRevision++;
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
  private assertWorkspace(input: DesktopBrowserWorkspace): void { if (this.disposed || input.workspaceCwd !== this.options.workspaceCwd) throw new BrowserPageError("browser_workspace_unavailable"); }
  private assertCommand(command: DesktopBrowserCommand, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.disposed || command.workspaceCwd !== this.options.workspaceCwd || command.generation !== this.generation
      || command.desktopInstanceId !== this.options.desktopInstanceId || Date.parse(command.deadlineAt) <= Date.now()) throw new BrowserPageError("browser_command_expired_or_replaced");
  }
  private assertUrl(url: string): Promise<void> {
    return assertBrowserNetworkUrl(url, { allowedLoopbackOrigin: isBrowserLoopback(new URL(url).hostname) ? new URL(url).origin : undefined,
      forbiddenOrigins: [new URL(this.options.daemonBaseUrl).origin] });
  }
  private changed(): void { this.revision++; for (const listener of this.listeners) listener(); }
}

function scopeKey(scope: DesktopBrowserScope): string { return JSON.stringify([scope.surface, scope.ownerId]); }
