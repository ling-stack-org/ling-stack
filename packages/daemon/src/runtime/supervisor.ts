import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_WORKSPACE_ID,
  type ResourceLease,
  type RuntimeInstance,
  type RuntimeSemaphoreSlot,
  type RunSession,
  type RunStore,
  type WorkUnit,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../config.js";
import { HttpError } from "../errors.js";
import { isRecord } from "../shared/validation.js";
import {
  isStuckWorkUnit,
  listActiveWorkUnits,
  markWorkUnitStale,
  releaseWorkUnitRuntimeResources,
  transitionWorkUnitTerminal,
} from "./work-units.js";

const RUNTIME_SCHEMA_VERSION = 22;

export class RuntimeSupervisor {
  private readonly runtimesByCwd = new Map<string, RuntimeInstance>();
  private readonly lockedCwds = new Set<string>();
  private readonly runtimeLockPathsByCwd = new Map<string, string>();
  private readonly reconciledCwds = new Set<string>();

  constructor(private readonly config: ResolvedDaemonConfig) {}

  getRuntimeToolFeatures(): ResolvedDaemonConfig["runtimeTools"] {
    return this.config.runtimeTools;
  }

  getTransportFeatures(): ResolvedDaemonConfig["transports"] {
    return this.config.transports;
  }

  getRuntime(cwd: string, store: RunStore): RuntimeInstance {
    const existing = this.runtimesByCwd.get(cwd);
    if (existing) {
      return existing;
    }

    this.ensureRuntimeLock(cwd, store);
    this.reconcileStartup(cwd, store);
    const now = new Date().toISOString();
    const runtime: RuntimeInstance = {
      workspaceId: DEFAULT_WORKSPACE_ID,
      runtimeInstanceId: `runtime_${randomUUID()}`,
      pid: process.pid,
      host: this.config.host,
      port: this.config.port,
      startedAt: now,
      version: "0.0.0",
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      status: "healthy",
    };
    this.runtimesByCwd.set(cwd, runtime);
    this.writeRuntimeLock(store, runtime);
    return runtime;
  }

  getDiagnostics(cwd: string, store: RunStore): {
    readonly runtime: RuntimeInstance;
    readonly active: readonly WorkUnit[];
    readonly stuck: readonly WorkUnit[];
    readonly queued: readonly WorkUnit[];
    readonly stale: readonly WorkUnit[];
    readonly leases: readonly ResourceLease[];
    readonly semaphoreSlots: readonly RuntimeSemaphoreSlot[];
  } {
    const runtime = this.getRuntime(cwd, store);
    const active = listActiveWorkUnits(store);
    return {
      runtime,
      active,
      stuck: active.filter((workUnit) => isStuckWorkUnit(workUnit, new Date())),
      queued: store.listWorkUnits({ status: "queued", limit: 200 }),
      stale: store.listWorkUnits({ status: "stale", limit: 200 }),
      leases: store.listResourceLeases({ status: "active", limit: 500 }),
      semaphoreSlots: store.listRuntimeSemaphoreSlots({ status: "active", limit: 500 }),
    };
  }

  releaseAll(): void {
    for (const [cwd, runtime] of this.runtimesByCwd.entries()) {
      const lockPath = this.runtimeLockPathsByCwd.get(cwd) ?? join(cwd, ".ling-stack", "runtime.lock");
      try {
        const current = parseRuntimeLock(readFileSync(lockPath, "utf8"));
        if (current?.runtimeInstanceId === runtime.runtimeInstanceId) {
          unlinkSync(lockPath);
        }
      } catch {
        // Lock cleanup is best-effort; stale locks are reconciled on the next runtime start.
      }
    }
    this.runtimesByCwd.clear();
    this.lockedCwds.clear();
    this.runtimeLockPathsByCwd.clear();
    this.reconciledCwds.clear();
  }

  private ensureRuntimeLock(cwd: string, store: RunStore): void {
    if (this.lockedCwds.has(cwd)) {
      return;
    }
    const lockPath = join(store.paths.rootDir, "runtime.lock");
    const lock = {
      runtimeInstanceId: `runtime_lock_probe_${randomUUID()}`,
      pid: process.pid,
      host: this.config.host,
      port: this.config.port,
      cwd,
      startedAt: new Date().toISOString(),
    };
    try {
      writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, { flag: "wx" });
      this.lockedCwds.add(cwd);
      this.runtimeLockPathsByCwd.set(cwd, lockPath);
      return;
    } catch (error) {
      if (!isFsErrorCode(error, "EEXIST")) {
        throw error;
      }
    }

    const existing = parseRuntimeLock(readFileSync(lockPath, "utf8"));
    if (existing && isProcessAlive(existing.pid)) {
      if (existing.pid !== process.pid || existing.port !== this.config.port || existing.host !== this.config.host) {
        throw new HttpError(
          409,
          "runtime_already_running",
          `Workspace runtime is already owned by pid ${existing.pid} at ${existing.host}:${existing.port}.`,
        );
      }
      this.lockedCwds.add(cwd);
      this.runtimeLockPathsByCwd.set(cwd, lockPath);
      return;
    }

    try {
      unlinkSync(lockPath);
    } catch {
      // If unlink races with another daemon, the following create will surface the correct error.
    }
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, { flag: "wx" });
    this.lockedCwds.add(cwd);
    this.runtimeLockPathsByCwd.set(cwd, lockPath);
  }

  private writeRuntimeLock(store: RunStore, runtime: RuntimeInstance): void {
    const lockPath = join(store.paths.rootDir, "runtime.lock");
    this.runtimeLockPathsByCwd.set(store.paths.cwd, lockPath);
    writeFileSync(
      lockPath,
      `${JSON.stringify(
        {
          runtimeInstanceId: runtime.runtimeInstanceId,
          pid: runtime.pid,
          host: runtime.host,
          port: runtime.port,
          cwd: store.paths.cwd,
          startedAt: runtime.startedAt,
          schemaVersion: runtime.schemaVersion,
        },
        null,
        2,
      )}\n`,
    );
  }

  private reconcileStartup(cwd: string, store: RunStore): void {
    if (this.reconciledCwds.has(cwd)) {
      return;
    }
    this.reconciledCwds.add(cwd);
    const now = new Date().toISOString();
    const candidates = [
      ...store.listWorkUnits({ status: "claimed", limit: 500 }),
      ...store.listWorkUnits({ status: "running", limit: 500 }),
      ...store.listWorkUnits({ status: "waiting_for_approval", limit: 500 }),
      ...store.listWorkUnits({ status: "cancelling", limit: 500 }),
    ];
    for (const workUnit of candidates) {
      if (reconcileActiveWorkUnitFromLinkedTerminalRun(store, workUnit, now)) {
        continue;
      }
      markWorkUnitStale(store, workUnit, now, "runtime-startup-reconcile");
    }
  }
}

function reconcileActiveWorkUnitFromLinkedTerminalRun(store: RunStore, workUnit: WorkUnit, now: string): boolean {
  if (!workUnit.linkedRunId) {
    return false;
  }
  const run = store.getRun(workUnit.linkedRunId);
  const terminal = run ? terminalWorkUnitTransitionForRun(run) : undefined;
  if (!terminal) {
    return false;
  }
  const attemptId = workUnit.activeAttemptId ?? store.listWorkUnitAttempts(workUnit.id).at(-1)?.id;
  if (!attemptId) {
    return false;
  }

  transitionWorkUnitTerminal(store, {
    workUnitId: workUnit.id,
    attemptId,
    event: terminal.event,
    attemptStatus: terminal.attemptStatus,
    runtimeEventType: terminal.runtimeEventType,
    actor: "system",
    now,
    errorCode: terminal.errorCode,
    errorMessage: terminal.errorMessage,
  });
  const reconciled = store.getWorkUnit(workUnit.id);
  if (reconciled?.status !== terminal.workUnitStatus) {
    return false;
  }
  releaseWorkUnitRuntimeResources(store, reconciled, now, "linked-terminal-run-reconcile");
  return true;
}

function terminalWorkUnitTransitionForRun(run: RunSession):
  | {
    readonly workUnitStatus: "succeeded";
    readonly event: "runner_succeeded";
    readonly attemptStatus: "succeeded";
    readonly runtimeEventType: "work_unit_succeeded";
    readonly errorCode?: undefined;
    readonly errorMessage?: undefined;
  }
  | {
    readonly workUnitStatus: "failed";
    readonly event: "runner_failed";
    readonly attemptStatus: "failed";
    readonly runtimeEventType: "work_unit_failed";
    readonly errorCode: "linked_run_failed";
    readonly errorMessage: string;
  }
  | undefined {
  if (run.status === "succeeded") {
    return {
      workUnitStatus: "succeeded",
      event: "runner_succeeded",
      attemptStatus: "succeeded",
      runtimeEventType: "work_unit_succeeded",
    };
  }
  if (run.status === "failed") {
    return {
      workUnitStatus: "failed",
      event: "runner_failed",
      attemptStatus: "failed",
      runtimeEventType: "work_unit_failed",
      errorCode: "linked_run_failed",
      errorMessage: run.errorMessage ?? "Linked run failed before runtime startup reconcile.",
    };
  }
  return undefined;
}

function parseRuntimeLock(value: string): { readonly runtimeInstanceId?: string; readonly pid: number; readonly host: string; readonly port: number } | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || typeof parsed.pid !== "number" || typeof parsed.host !== "string" || typeof parsed.port !== "number") {
      return undefined;
    }
    return {
      runtimeInstanceId: typeof parsed.runtimeInstanceId === "string" ? parsed.runtimeInstanceId : undefined,
      pid: parsed.pid,
      host: parsed.host,
      port: parsed.port,
    };
  } catch {
    return undefined;
  }
}

function isFsErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
