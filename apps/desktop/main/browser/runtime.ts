import { setTimeout as delay } from "node:timers/promises";
import { DESKTOP_BROWSER_PROTOCOL, type DesktopBrowserCommand, type DesktopBrowserResult } from "@ling-stack/contracts";
import { BrowserPageError, type DesktopBrowserManager } from "./manager.js";
import { DesktopBrowserDaemonClient } from "./daemon-client.js";

export class DesktopBrowserRuntime {
  private controller?: AbortController;
  private loop?: Promise<void>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private publicationTimer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private runtimeId?: string;
  private paused = false;
  private publication: Promise<void> = Promise.resolve();
  constructor(readonly manager: DesktopBrowserManager, private readonly options: {
    readonly daemonBaseUrl: string; readonly bridgeToken: string; readonly onDiagnostic?: (event: string) => void;
  }) {}

  async start(): Promise<void> {
    if (this.controller || this.paused) return;
    const controller = new AbortController(); this.controller = controller;
    const client = new DesktopBrowserDaemonClient(this.options), signal = controller.signal;
    const publish = (): Promise<void> => {
      const publication = this.publication.catch(() => undefined).then(async () => {
        signal.throwIfAborted();
        const runtimeId = await client.publish(this.manager.state(), signal);
        if (this.runtimeId && this.runtimeId !== runtimeId) this.manager.rotateGeneration();
        this.runtimeId = runtimeId;
      });
      this.publication = publication;
      return publication;
    };
    const reportError = (): void => { if (!signal.aborted) { this.manager.pause(); this.options.onDiagnostic?.("browser.connection_unavailable"); } };
    this.unsubscribe = this.manager.onChanged(() => {
      if (this.publicationTimer || signal.aborted) return;
      this.publicationTimer = setTimeout(() => { this.publicationTimer = undefined; void publish().catch(reportError); }, 25);
    });
    this.heartbeat = setInterval(() => { void publish().catch(reportError); }, 4_000);
    await publish().catch(reportError);
    void this.manager.restore().catch(() => this.options.onDiagnostic?.("browser_tab_restore_failed"));
    this.loop = (async () => {
      while (!signal.aborted) {
        try {
          const command = await client.claim(this.manager.state(), signal);
          if (!command) continue;
          const result = await this.execute(command, client, signal);
          await publish();
          await client.complete(this.manager.state(), result, signal);
        } catch {
          if (signal.aborted) return;
          reportError();
          await delay(750, undefined, { signal }).catch(() => undefined);
          await publish().catch(reportError);
        }
      }
    })();
  }

  pauseNewClaims(): void { this.paused = true; this.manager.pause(); this.controller?.abort(); }
  async restart(): Promise<void> { await this.stopLoop(); this.manager.rotateGeneration(); this.paused = false; await this.start(); }
  async stop(): Promise<void> { this.paused = true; await this.stopLoop(); this.manager.dispose(); }
  private async stopLoop(): Promise<void> {
    this.controller?.abort(); this.manager.pause();
    this.unsubscribe?.(); this.unsubscribe = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.publicationTimer) clearTimeout(this.publicationTimer);
    this.heartbeat = this.publicationTimer = undefined;
    await this.loop?.catch(() => undefined); await this.publication.catch(() => undefined);
    this.loop = undefined; this.controller = undefined;
  }

  private async execute(command: DesktopBrowserCommand, client: DesktopBrowserDaemonClient, parentSignal: AbortSignal): Promise<DesktopBrowserResult> {
    const controller = new AbortController();
    const deadline = Math.max(1, Date.parse(command.deadlineAt) - Date.now());
    const signal = AbortSignal.any([controller.signal, parentSignal, AbortSignal.timeout(deadline)]);
    let started = false, operation: Promise<unknown> | undefined;
    const abort = (): void => this.manager.pause();
    signal.addEventListener("abort", abort, { once: true });
    let cancellation: Promise<void> | undefined;
    try {
      await client.start(command, signal); started = true;
      cancellation = (async () => {
        while (!signal.aborted) {
          if (await client.cancelled(command, signal)) { controller.abort(); return; }
        }
      })().catch(() => { if (!signal.aborted) controller.abort(); });
      operation = this.manager.execute(command, signal);
      const result = await raceAbort(operation, signal);
      signal.throwIfAborted();
      return { protocol: DESKTOP_BROWSER_PROTOCOL, id: command.id, ok: true,
        effect: ["browser_click", "browser_type", "browser_navigate", "browser_download", "browser_cdp", "browser_webmcp_call"].includes(command.method) ? "completed" : "none", result };
    } catch (error) {
      const code = error instanceof BrowserPageError ? error.code : signal.aborted ? "browser_cancelled_or_expired" : "browser_execution_failed";
      const effect = error instanceof BrowserPageError ? error.effect : started && ["browser_click", "browser_type", "browser_navigate", "browser_download", "browser_cdp", "browser_webmcp_call"].includes(command.method) ? "unknown" : "none";
      return { protocol: DESKTOP_BROWSER_PROTOCOL, id: command.id, ok: false, effect,
        error: { code, message: "Browser operation did not complete. Obtain a fresh snapshot before another action." } };
    } finally {
      signal.removeEventListener("abort", abort); controller.abort();
      if (operation) void operation.catch(() => undefined);
      await cancellation;
    }
  }
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
