import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserWindowConstructorOptions } from "electron";
import type { HostOpenLocalTargetCommandV1 } from "@ling-stack/contracts";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_FILE_BYTES = 64 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);

interface PreviewSession {
  setPermissionCheckHandler(handler: (() => boolean) | null): void;
  setPermissionRequestHandler(handler: ((contents: unknown, permission: unknown, callback: (allowed: boolean) => void) => void) | null): void;
  on(event: "will-download", listener: (event: { preventDefault(): void }) => void): this;
  webRequest: {
    onBeforeRequest(
      filter: { readonly urls: readonly string[] },
      listener: ((details: { readonly url: string }, callback: (response: { readonly cancel: boolean }) => void) => void) | null,
    ): void;
  };
  clearStorageData(): Promise<void>;
}

interface PreviewWebContents {
  readonly session: PreviewSession;
  on(event: string, listener: (...args: any[]) => void): this;
  setWindowOpenHandler(handler: (details: { readonly url: string }) => { readonly action: "deny" }): void;
}

export interface HostPreviewWindow {
  readonly webContents: PreviewWebContents;
  loadFile(path: string): Promise<void>;
  loadURL(url: string): Promise<void>;
  once(event: "ready-to-show" | "closed", listener: () => void): this;
  show(): void;
  destroy(): void;
  isDestroyed(): boolean;
}

export interface HostPreviewLaunch {
  readonly window: HostPreviewWindow;
  close(): void;
}

export class HostPreviewError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HostPreviewError";
  }
}

/**
 * Desktop-owned, non-persistent local preview. Every wire path is resolved
 * again against the real workspace root before Electron sees it.
 */
export class HostLocalPreviewManager {
  private readonly windows = new Set<HostPreviewWindow>();
  private sequence = 0;
  private closed = false;

  constructor(private readonly options: {
    readonly desktopInstanceId: string;
    readonly createWindow?: (options: BrowserWindowConstructorOptions) => HostPreviewWindow;
  }) {}

  async launch(command: HostOpenLocalTargetCommandV1): Promise<HostPreviewLaunch> {
    if (this.closed) throw new HostPreviewError("host_preview_closed");
    const target = await resolvePreviewTarget(command);
    const partition = `ling-host-preview-${safePartitionPart(this.options.desktopInstanceId)}-${++this.sequence}`;
    const window = await this.createWindow(buildWindowOptions(partition, basename(target.path)));
    this.windows.add(window);
    window.once("closed", () => this.windows.delete(window));
    configurePreviewSecurity(window, target.workspaceRoot);
    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) window.show();
    });
    try {
      if (command.presentation === "read_only_text") {
        const source = await readBoundedSource(target.path);
        await window.loadURL(readOnlySourceDocument(basename(target.path), source));
      } else {
        await window.loadFile(target.path);
      }
    } catch (error) {
      if (!window.isDestroyed()) window.destroy();
      this.windows.delete(window);
      throw error instanceof HostPreviewError ? error : new HostPreviewError("host_preview_load_failed");
    }
    return Object.freeze({
      window,
      close: () => {
        if (!window.isDestroyed()) window.destroy();
        this.windows.delete(window);
      },
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const sessions = new Set<PreviewSession>();
    for (const window of this.windows) {
      sessions.add(window.webContents.session);
      if (!window.isDestroyed()) window.destroy();
    }
    this.windows.clear();
    await Promise.all([...sessions].map((session) => session.clearStorageData().catch(() => undefined)));
  }

  private async createWindow(options: BrowserWindowConstructorOptions): Promise<HostPreviewWindow> {
    if (this.options.createWindow) return this.options.createWindow(options);
    const electron = await import("electron");
    if (!electron.BrowserWindow) throw new HostPreviewError("host_preview_electron_unavailable");
    return new electron.BrowserWindow(options) as unknown as HostPreviewWindow;
  }
}

function buildWindowOptions(partition: string, title: string): BrowserWindowConstructorOptions {
  return {
    width: 1040,
    height: 760,
    minWidth: 640,
    minHeight: 420,
    show: false,
    title,
    autoHideMenuBar: true,
    backgroundColor: "#171717",
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  };
}

function configurePreviewSecurity(window: HostPreviewWindow, workspaceRoot: string): void {
  const previewSession = window.webContents.session;
  previewSession.setPermissionCheckHandler(() => false);
  previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  previewSession.on("will-download", (event) => event.preventDefault());
  previewSession.webRequest.onBeforeRequest({ urls: ["*://*/*", "file://*/*", "data:*", "about:*"] }, (details, callback) => {
    callback({ cancel: !isAllowedHostPreviewResourceUrl(details.url, workspaceRoot) });
  });
  const prevent = (event: { preventDefault(): void }): void => event.preventDefault();
  window.webContents.on("will-navigate", prevent);
  window.webContents.on("will-redirect", prevent);
  window.webContents.on("will-attach-webview", prevent);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

export function isAllowedHostPreviewResourceUrl(url: string, workspaceRoot: string): boolean {
  if (url === "about:blank" || url.startsWith("data:")) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "file:") return false;
  try {
    return pathWithin(workspaceRoot, fileURLToPath(parsed));
  } catch {
    return false;
  }
}

async function resolvePreviewTarget(command: HostOpenLocalTargetCommandV1): Promise<{
  readonly path: string;
  readonly workspaceRoot: string;
}> {
  let workspaceRoot: string;
  let targetPath: string;
  try {
    [workspaceRoot, targetPath] = await Promise.all([
      realpath(command.workspaceRoot),
      realpath(command.absolutePath),
    ]);
  } catch {
    throw new HostPreviewError("host_preview_target_missing");
  }
  const expectedPath = resolve(workspaceRoot, command.path);
  let expectedRealPath: string;
  try {
    expectedRealPath = await realpath(expectedPath);
  } catch {
    throw new HostPreviewError("host_preview_target_missing");
  }
  if (expectedRealPath !== targetPath || !pathWithin(workspaceRoot, targetPath)) {
    throw new HostPreviewError("host_preview_target_outside_workspace");
  }
  const file = await stat(targetPath);
  if (!file.isFile()) throw new HostPreviewError("host_preview_target_not_file");
  if (file.size > MAX_PREVIEW_FILE_BYTES) throw new HostPreviewError("host_preview_target_too_large");
  assertPresentationMatches(command.presentation, targetPath);
  return { path: targetPath, workspaceRoot };
}

function assertPresentationMatches(presentation: HostOpenLocalTargetCommandV1["presentation"], path: string): void {
  const extension = extname(path).toLowerCase();
  if (presentation === "interactive_html" && extension !== ".html" && extension !== ".htm") {
    throw new HostPreviewError("host_preview_presentation_mismatch");
  }
  if (presentation === "image" && !IMAGE_EXTENSIONS.has(extension)) {
    throw new HostPreviewError("host_preview_presentation_mismatch");
  }
  if (presentation === "read_only_text" && (extension === ".html" || extension === ".htm" || IMAGE_EXTENSIONS.has(extension))) {
    throw new HostPreviewError("host_preview_presentation_mismatch");
  }
}

async function readBoundedSource(path: string): Promise<string> {
  const file = await stat(path);
  if (file.size > MAX_SOURCE_BYTES) throw new HostPreviewError("host_preview_source_too_large");
  const bytes = await readFile(path);
  if (bytes.includes(0)) throw new HostPreviewError("host_preview_source_binary");
  return bytes.toString("utf8");
}

function readOnlySourceDocument(title: string, source: string): string {
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(title)}</title><style>html{color-scheme:dark}body{margin:0;background:#171717;color:#ededed;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}header{position:sticky;top:0;padding:12px 18px;background:#202020;border-bottom:1px solid #333;font:13px/1.4 system-ui,sans-serif}pre{margin:0;padding:18px;white-space:pre-wrap;overflow-wrap:anywhere}</style><header>${escapeHtml(title)} · read only</header><pre>${escapeHtml(source)}</pre>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function pathWithin(root: string, target: string): boolean {
  const child = relative(resolve(root), resolve(target));
  return child === "" || child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function safePartitionPart(value: string): string {
  return value.replace(/[^a-z0-9_-]/giu, "-").slice(0, 80) || "desktop";
}
