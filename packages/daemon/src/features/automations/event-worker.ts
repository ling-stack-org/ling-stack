import { automationDefinitionDigestInput, automationEventDigest, automationEventRunKey, redactSecrets,
  type AutomationEventDispatch, type RunStore } from "@ling-stack/core";
import type { ImDestinationRegistry } from "../im-destinations/registry.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { HttpError } from "../../errors.js";
import { recoveryBlocked } from "../../server/app-server-recovery.js";
import type { NativeWorkIntake } from "../work-items/native-intake.js";
import { runAutomation, type StartAutomationRunExecution } from "./run.js";

/** Durable inbox/outbox execution uses existing Run admission and destination egress. */
export class AutomationEventWorker {
  private readonly workspaces = new Map<string, { timer: ReturnType<typeof setInterval>; abort: AbortController; pending?: Promise<void>; error?: string }>();
  private readonly pending = new Set<Promise<void>>();
  private closed = false;
  constructor(private readonly stores: RunStoreRegistry, private readonly destinations: ImDestinationRegistry,
    private readonly startRun: StartAutomationRunExecution,
    private readonly processIntake?: (store: RunStore, signal: AbortSignal) => Promise<void>,
    private readonly nativeIntake?: NativeWorkIntake) {}

  start(cwd: string): void {
    if (this.closed) throw new Error("automation_event_worker_closed");
    if (this.workspaces.has(cwd) && !this.workspaces.get(cwd)!.abort.signal.aborted) return;
    const previous = this.workspaces.get(cwd);
    const timer = setInterval(() => this.poke(cwd), 2000); timer.unref();
    const state = { timer, abort: new AbortController(), pending: previous?.pending };
    this.workspaces.set(cwd, state);
    if (state.pending) void state.pending.finally(() => { state.pending = undefined; this.poke(cwd); });
    else this.poke(cwd);
  }
  poke(cwd: string): void {
    const state = this.workspaces.get(cwd);
    if (!state || state.pending || state.abort.signal.aborted) return;
    state.pending = this.tick(cwd, state.abort.signal).then(() => { state.error = undefined; }, () => { state.error = "automation_event_worker_tick_failed"; })
      .finally(() => { this.pending.delete(state.pending!); state.pending = undefined; });
    this.pending.add(state.pending);
  }
  status(cwd: string) { const state = this.workspaces.get(cwd); return { running: Boolean(state && !state.abort.signal.aborted), error: state?.error }; }
  stop(cwd: string): void {
    const state = this.workspaces.get(cwd);
    if (state) { clearInterval(state.timer); state.abort.abort(); }
  }
  stopAll(): void { this.closed = true; for (const cwd of this.workspaces.keys()) this.stop(cwd); }
  async waitForIdle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private assertDispatch(store: RunStore, job: AutomationEventDispatch, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.stores.recoveryBlocksDispatch(store.paths.cwd)) throw recoveryBlocked();
    const source = store.getAutomationEventSource(job.sourceId), definition = store.getAutomationDefinition(job.automationId);
    if (!source?.enabled || source.revision !== job.sourceRevision || !definition || definition.status !== "enabled"
      || automationEventDigest(automationDefinitionDigestInput(definition)) !== job.definitionDigest) throw new Error("automation_event_authority_changed");
  }
  private async tick(cwd: string, signal: AbortSignal): Promise<void> {
    const store = this.stores.getStore(cwd);
    for (let count = 0; count < 8 && !signal.aborted; count++) {
      if (this.stores.recoveryBlocksDispatch(cwd)) return;
      const job = store.claimAutomationEventDispatch(new Date().toISOString());
      if (!job?.leaseToken) break;
      try {
        this.assertDispatch(store, job, signal);
        const envelope = store.getAutomationEvent(job.eventId);
        if (!envelope) throw new Error("automation_event_envelope_missing");
        const result = await runAutomation({ cwd, automationId: job.automationId, storeRegistry: this.stores,
          request: { triggerType: "event", idempotencyKey: automationEventRunKey(job.id) },
          nativeIntake: this.nativeIntake,
          event: { envelope, dispatchId: job.id, assertCurrent: () => this.assertDispatch(store, job, signal) },
          startRun: (request, hooks) => { this.assertDispatch(store, job, signal); return this.startRun(request, hooks); } });
        const own = result.automationRun.idempotencyKey === automationEventRunKey(job.id);
        store.finishAutomationEventDispatch(job.id, job.leaseToken, own
          ? { status: "linked", automationRunId: result.automationRun.id } : { status: "queued", error: "automation_busy" }, new Date().toISOString());
      } catch (error) {
        store.finishAutomationEventDispatch(job.id, job.leaseToken,
          { status: signal.aborted || isRecoveryHold(error) ? "queued" : "failed",
            error: isRecoveryHold(error) ? "app_server_recovery_held" : error instanceof Error && /^automation_[a-z_]+$/.test(error.message)
              ? error.message : "automation_event_dispatch_failed" }, new Date().toISOString());
      }
    }
    if (signal.aborted || this.stores.recoveryBlocksDispatch(cwd)) return;
    await this.processIntake?.(store, signal);
    if (signal.aborted) return;
    store.reconcileAutomationDeliveries(new Date().toISOString());
    await this.destinations.ensureLoaded();
    for (let count = 0; count < 8 && !signal.aborted; count++) {
      if (this.stores.recoveryBlocksDispatch(cwd)) return;
      const item = store.claimAutomationDelivery(new Date().toISOString());
      if (!item?.leaseToken) break;
      let dispatched = false;
      try {
        const job = store.getAutomationEventDispatch(item.dispatchId);
        if (!job) throw new Error("automation_delivery_dispatch_missing");
        this.assertDispatch(store, job, signal);
        const destination = this.destinations.list().find(target => target.id === item.destinationId && target.enabled);
        if (!destination || !job.destinationIds.includes(destination.id)) throw new Error("automation_delivery_destination_unavailable");
        const run = store.getRun(item.runId);
        if (!run || !["succeeded", "failed", "cancelled"].includes(run.status)) throw new Error("automation_delivery_run_not_terminal");
        const message = { title: `Ling automation: ${run.status}`, severity: run.status === "succeeded" ? "info" as const : "warning" as const,
          bodyMarkdown: String(redactSecrets(`Run: ${run.id}\nStatus: ${run.status}\n${store.getAutomationRunResultText(run.id) ?? run.errorMessage ?? ""}`)).slice(0, 8000) };
        const result = await this.destinations.dispatch(destination, message, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), idempotencyKey: item.id,
          onDispatch: () => {
            this.assertDispatch(store, job, signal);
            if (!this.destinations.list().some(target => target.id === destination.id && target.enabled)) throw new Error("automation_delivery_destination_revoked");
            dispatched = true;
          },
        });
        const retryable = !dispatched || result.status === 429;
        store.settleAutomationDelivery(item.id, item.leaseToken, { status: result.ok ? "delivered" : retryable
          ? item.attempts >= 5 ? "failed" : "queued" : "unknown", receipt: result.ok ? `http:${result.status}` : dispatched ? `http:${result.status ?? "unknown"}` : "delivery_not_dispatched",
          availableAt: new Date(Date.now() + Math.min(60_000, 1000 * 2 ** item.attempts)).toISOString() }, new Date().toISOString());
      } catch (error) {
        store.settleAutomationDelivery(item.id, item.leaseToken, { status: dispatched ? "unknown"
          : item.attempts >= 5 && !isRecoveryHold(error) ? "failed" : "queued",
          receipt: dispatched ? "delivery_outcome_unknown" : "delivery_not_dispatched", availableAt: new Date(Date.now() + 10_000).toISOString() }, new Date().toISOString());
      }
    }
  }
}

function isRecoveryHold(error: unknown): boolean {
  return error instanceof HttpError && error.code === "resume_blocked";
}
