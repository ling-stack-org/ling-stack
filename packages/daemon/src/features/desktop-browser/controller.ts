import { isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DESKTOP_BROWSER_PROTOCOL, parseDesktopBrowserState, parseDesktopBrowserResult, parseDesktopBrowserOperation,
  sameDesktopBrowserScope, type DesktopBrowserState, type DesktopBrowserCommand, type DesktopBrowserScope,
  type DesktopBrowserOperation, type DesktopBrowserResult,
} from "@ling-stack/contracts";

export interface BrowserAuthority { readonly desktopInstanceId: string; readonly generation: number }
interface Pending {
  readonly command: DesktopBrowserCommand;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
  stage: "queued" | "claimed" | "started";
}

export class BrowserExecutionError extends Error {
  constructor(readonly code: string, readonly effect: DesktopBrowserResult["effect"]) { super(code); }
}

/** Owns ephemeral commands. A claimed command is never requeued after disconnect or cancellation. */
export class DesktopBrowserController {
  readonly runtimeId = randomUUID();
  private readonly workspaces = new Map<string, DesktopBrowserController>();

  forWorkspace(cwd: string): DesktopBrowserController {
    if (!isAbsolute(cwd) || resolve(cwd) !== cwd) throw new Error("browser_workspace_invalid");
    if (cwd === this.workspaceCwd) return this;
    let controller = this.workspaces.get(cwd);
    if (!controller) {
      if (this.closed || this.workspaces.size >= 16) throw new Error("browser_workspace_budget_exceeded");
      controller = new DesktopBrowserController(cwd, this.options); this.workspaces.set(cwd, controller);
    }
    return controller;
  }
  private stateValue?: DesktopBrowserState;
  private receivedAt = 0;
  private closed = false;
  private readonly pending = new Map<string, Pending>();
  private readonly waiters = new Set<() => void>();
  private readonly retiredInstances = new Set<string>();
  private readonly executions = new Map<string, { readonly fingerprint: string; readonly promise: Promise<unknown> }>();

  constructor(readonly workspaceCwd: string, private readonly options: {
    readonly now?: () => number; readonly commandTimeoutMs?: number; readonly ttlMs?: number; readonly onChanged?: () => void;
  } = {}) {}

  publish(value: unknown): DesktopBrowserState {
    if (this.closed) throw new Error("browser_closed");
    const next = parseDesktopBrowserState(value), current = this.stateValue;
    if (next.workspaceCwd !== this.workspaceCwd || this.retiredInstances.has(next.desktopInstanceId)) throw new Error("browser_authority_invalid");
    if (current && current.desktopInstanceId === next.desktopInstanceId && next.generation < current.generation) throw new Error("browser_stale_generation");
    if (current && sameAuthority(current, next) && next.revision < current.revision) return current;
    if (current && !sameAuthority(current, next)) {
      if (current.desktopInstanceId !== next.desktopInstanceId) this.retiredInstances.add(current.desktopInstanceId);
      for (const id of this.pending.keys()) this.fail(id, "browser_authority_replaced");
    }
    this.stateValue = next;
    this.receivedAt = this.now();
    for (const [id, pending] of this.pending) {
      const params = pending.command.params;
      if (!("tabId" in params) || !params.tabId) continue;
      const tab = next.tabs.find(item => item.id === params.tabId);
      if (!tab || tab.control !== "agent" || !sameDesktopBrowserScope(tab.scope, pending.command.scope)
        || (pending.stage !== "started" && tab.navigationRevision !== params.navigationRevision)) this.fail(id, "browser_target_changed");
    }
    this.wake();
    this.options.onChanged?.();
    return next;
  }

  snapshot(): { readonly connected: boolean; readonly state?: DesktopBrowserState } {
    return { connected: !this.closed && Boolean(this.stateValue) && this.now() - this.receivedAt <= (this.options.ttlMs ?? 12_000), state: this.stateValue };
  }

  async execute(input: { readonly operation: DesktopBrowserOperation; readonly scope: DesktopBrowserScope; readonly runId: string; readonly toolCallId: string; readonly signal?: AbortSignal }): Promise<unknown> {
    input.signal?.throwIfAborted();
    const operation = parseDesktopBrowserOperation(input.operation.method, input.operation.params);
    const key = `${input.runId}:${input.toolCallId}`, fingerprint = JSON.stringify([operation, input.scope]);
    const existing = this.executions.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("browser_request_identity_mismatch");
      return existing.promise;
    }
    const { connected, state } = this.snapshot();
    if (!connected || !state) throw new Error("browser_desktop_required");
    if (this.pending.size >= 32 || this.executions.size >= 4096) throw new Error("browser_command_budget_exceeded");
    if ("tabId" in operation.params && operation.params.tabId) {
      const { tabId } = operation.params;
      const tab = state.tabs.find(item => item.id === tabId);
      if (!tab || tab.control !== "agent" || !sameDesktopBrowserScope(tab.scope, input.scope)
        || tab.navigationRevision !== operation.params.navigationRevision) throw new Error("browser_target_stale_or_forbidden");
    }
    const id = randomUUID(), timeout = this.options.commandTimeoutMs ?? 30_000;
    const command: DesktopBrowserCommand = { ...operation, protocol: DESKTOP_BROWSER_PROTOCOL, id,
      desktopInstanceId: state.desktopInstanceId, generation: state.generation, workspaceCwd: this.workspaceCwd,
      scope: input.scope, runId: input.runId, deadlineAt: new Date(this.now() + timeout).toISOString() };
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(id, "browser_timeout"), timeout);
      const abort = (): void => this.fail(id, "browser_cancelled");
      this.pending.set(id, { command, resolve, reject, stage: "queued", cleanup: () => {
        clearTimeout(timer); input.signal?.removeEventListener("abort", abort);
      } });
      input.signal?.addEventListener("abort", abort, { once: true });
    });
    this.executions.set(key, { fingerprint, promise });
    this.wake();
    return promise;
  }

  async claim(authority: BrowserAuthority, signal: AbortSignal): Promise<DesktopBrowserCommand | undefined> {
    this.assertAuthority(authority);
    const take = (): DesktopBrowserCommand | undefined => {
      const pending = [...this.pending.values()].find(item => item.stage === "queued");
      if (!pending) return undefined;
      pending.stage = "claimed";
      return pending.command;
    };
    const immediate = take();
    if (immediate) return immediate;
    await this.wait(signal);
    signal.throwIfAborted();
    this.assertAuthority(authority);
    return take();
  }

  start(authority: BrowserAuthority, id: string): void {
    this.assertAuthority(authority);
    const pending = this.pending.get(id);
    if (!pending || pending.stage !== "claimed") throw new Error("browser_command_not_current");
    pending.stage = "started";
  }

  async waitForCancellation(authority: BrowserAuthority, id: string, signal: AbortSignal): Promise<boolean> {
    this.assertAuthority(authority);
    if (!this.pending.has(id)) return true;
    await this.wait(signal);
    this.assertAuthority(authority);
    return !this.pending.has(id);
  }

  complete(authority: BrowserAuthority, value: unknown): void {
    this.assertAuthority(authority);
    const result = parseDesktopBrowserResult(value), pending = this.pending.get(result.id);
    if (!pending || pending.stage !== "started") throw new Error("browser_command_not_current");
    this.pending.delete(result.id);
    pending.cleanup();
    this.wake();
    if (result.ok) pending.resolve(result.result ?? null);
    else pending.reject(new BrowserExecutionError(result.error!.code, result.effect));
  }

  cancelAll(): void { for (const id of this.pending.keys()) this.fail(id, "browser_access_revoked"); }
  close(): void { for (const child of this.workspaces.values()) child.close(); this.workspaces.clear(); this.closed = true; this.cancelAll(); this.wake(); }

  private fail(id: string, code: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.cleanup();
    const effect = pending.stage === "started" && ["browser_click", "browser_type", "browser_navigate", "browser_download", "browser_cdp", "browser_webmcp_call"].includes(pending.command.method) ? "unknown" : "none";
    pending.reject(new BrowserExecutionError(code, effect));
    this.wake();
  }
  private assertAuthority(authority: BrowserAuthority): void {
    const snapshot = this.snapshot();
    if (!snapshot.connected || !snapshot.state || !sameAuthority(snapshot.state, authority)) throw new Error("browser_authority_invalid");
  }
  private wake(): void { for (const wake of [...this.waiters]) wake(); }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private wait(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise(resolve => {
      const finish = (): void => { clearTimeout(timer); signal.removeEventListener("abort", finish); this.waiters.delete(finish); resolve(); };
      const timer = setTimeout(finish, 10_000);
      this.waiters.add(finish); signal.addEventListener("abort", finish, { once: true });
    });
  }
}

function sameAuthority(left: BrowserAuthority, right: BrowserAuthority): boolean {
  return left.desktopInstanceId === right.desktopInstanceId && left.generation === right.generation;
}
