import { isAbsolute, resolve } from "node:path";
import { statSync } from "node:fs";
import type { DesktopBrowserUserAction, DesktopBrowserViewport, DesktopBrowserWorkspace, DesktopBrowserWorkspaceState } from "../../shared/browser-capabilities.js";
import { DesktopBrowserManager } from "./manager.js";
import { DesktopBrowserRuntime } from "./runtime.js";

/** Owns independent runtime generations and Chromium profiles for admitted local workspaces. */
export class DesktopBrowserWorkspaceRuntime {
  readonly manager = this;
  private readonly runtimes = new Map<string, DesktopBrowserRuntime>();
  private readonly listeners = new Set<() => void>();
  private readonly focusListeners = new Set<() => void>();
  private active?: DesktopBrowserRuntime;
  private paused = false;
  constructor(private readonly options: ConstructorParameters<typeof DesktopBrowserManager>[0] & { readonly bridgeToken: string }) {}
  async start(): Promise<void> { this.get(this.options.workspaceCwd); }
  workspace(input: DesktopBrowserWorkspace): DesktopBrowserWorkspaceState { return this.get(input.workspaceCwd).manager.workspace(input); }
  act(input: DesktopBrowserUserAction, assertCurrent?: () => void): Promise<DesktopBrowserWorkspaceState> {
    if (input.action === "deactivate_workspace") {
      const runtime = this.runtimes.get(input.workspaceCwd);
      if (!runtime) return Promise.reject(new Error("browser_workspace_unavailable"));
      if (runtime === this.active) { runtime.manager.setWorkspaceActive(false); this.active = undefined; }
      return Promise.resolve(runtime.manager.workspace(input));
    }
    const runtime = input.action === "activate_workspace" || input.action === "open_link" ? this.select(input.workspaceCwd) : this.get(input.workspaceCwd);
    if (runtime !== this.active) return Promise.reject(new Error("browser_workspace_paused"));
    return runtime.manager.act(input, assertCurrent);
  }
  reportViewport(input: DesktopBrowserViewport): void {
    const runtime = this.runtimes.get(input.workspaceCwd);
    if (runtime && runtime === this.active) runtime.manager.reportViewport(input);
  }
  onChanged(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onAddressFocusRequested(listener: () => void): () => void { this.focusListeners.add(listener); return () => this.focusListeners.delete(listener); }
  hide(): void { for (const runtime of this.runtimes.values()) runtime.manager.hide(); }
  rotateGeneration(): void { for (const runtime of this.runtimes.values()) runtime.manager.rotateGeneration(); }
  prepareWindowClose(): void { for (const runtime of this.runtimes.values()) { runtime.manager.setWorkspaceActive(false); runtime.manager.prepareWindowClose(); } this.active = undefined; }
  resumePersistence(): void { for (const runtime of this.runtimes.values()) runtime.manager.resumePersistence(); }
  pauseNewClaims(): void { this.paused = true; for (const runtime of this.runtimes.values()) runtime.pauseNewClaims(); }
  async restart(): Promise<void> { this.paused = false; await Promise.all([...this.runtimes.values()].map(runtime => runtime.restart())); }
  async stop(): Promise<void> { this.paused = true; await Promise.all([...this.runtimes.values()].map(runtime => runtime.stop())); this.runtimes.clear(); this.listeners.clear(); this.focusListeners.clear(); }
  private select(cwd: string): DesktopBrowserRuntime {
    const runtime = this.get(cwd);
    if (runtime !== this.active) {
      this.active?.manager.setWorkspaceActive(false); runtime.manager.setWorkspaceActive(true); this.active = runtime;
    }
    return runtime;
  }
  private get(cwd: string): DesktopBrowserRuntime {
    let runtime = this.runtimes.get(cwd);
    if (runtime) return runtime;
    if (this.paused || this.runtimes.size >= 16 || !isAbsolute(cwd) || resolve(cwd) !== cwd || !statSync(cwd).isDirectory()) throw new Error("browser_workspace_unavailable");
    const manager = new DesktopBrowserManager({ ...this.options, workspaceCwd: cwd });
    manager.setWorkspaceActive(false);
    runtime = new DesktopBrowserRuntime(manager, this.options);
    this.runtimes.set(cwd, runtime);
    manager.onChanged(() => { for (const listener of this.listeners) listener(); });
    manager.onAddressFocusRequested(() => { for (const listener of this.focusListeners) listener(); });
    void runtime.start().catch(() => this.options.onDiagnostic?.("browser_connection_unavailable"));
    return runtime;
  }
}
