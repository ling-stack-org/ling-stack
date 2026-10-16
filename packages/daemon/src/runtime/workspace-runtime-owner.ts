import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RuntimeInstance } from "@ling-stack/core";
import { HttpError } from "../errors.js";

interface WorkspaceRuntimeOwnerInput {
  readonly rootDir: string;
  readonly cwd: string;
  readonly host: string;
  readonly port: number;
}

interface RuntimeLockProjection {
  readonly runtimeInstanceId?: string;
  readonly ownerId?: string;
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly cwd?: string;
}

/**
 * A lifetime lease for cooperating local daemon processes, not a same-UID sandbox.
 * The fixed sidecar inode is never deleted. Its private SQLite connection, not
 * runtime.lock or PID/port equality, is the authority to reconcile and publish.
 */
export class WorkspaceRuntimeOwner {
  readonly #input: WorkspaceRuntimeOwnerInput;
  readonly #lockPath: string;
  readonly #ownerId = `runtime_owner_${randomUUID()}`;
  readonly #attemptedRuntimeIds = new Set<string>();
  #connection: DatabaseSync | undefined;
  // The connection is private and performs exactly one BEGIN. Do not depend on
  // DatabaseSync.isTransaction: it is absent in supported Node 22 runtimes.
  #transactionHeld = false;
  #phase: "new" | "acquiring" | "active" | "releasing" | "released" = "new";
  #projectionAttempted = false;
  #projectionOwned = false;
  #currentRuntimeId: string | undefined;

  /** Capture identity before any IO so the Supervisor retains failed acquisitions. */
  constructor(input: WorkspaceRuntimeOwnerInput) {
    this.#input = Object.freeze({ ...input, rootDir: resolve(input.rootDir) });
    this.#lockPath = join(this.#input.rootDir, "runtime.lock");
  }

  acquire(): void {
    if (this.#phase !== "new") throw new Error("runtime_owner_acquisition_invalid");
    this.#phase = "acquiring";
    const sidecar = `${this.#lockPath}.coordination.sqlite`;
    try {
      const descriptor = openSync(sidecar, "wx", 0o600);
      closeSync(descriptor);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
    this.#connection = new DatabaseSync(sidecar);
    this.#connection.exec("PRAGMA busy_timeout=0");
    try {
      this.#connection.exec("BEGIN IMMEDIATE");
      this.#transactionHeld = true;
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
      const conflict = new HttpError(409, "runtime_already_running", "Workspace runtime is already owned by another supervisor.");
      conflict.cause = error;
      throw conflict;
    }

    // Also respect a live pre-sidecar diagnostic owner. EPERM, invalid identity
    // and unknown liveness cannot authorize a takeover; only ESRCH can.
    const existing = this.readProjection();
    if (existing && !isConfirmedExited(existing.pid)) {
      throw new HttpError(409, "runtime_already_running",
        `Workspace runtime is already owned by pid ${existing.pid} at ${existing.host}:${existing.port}.`);
    }
    this.writeProjection(`runtime_lock_probe_${randomUUID()}`, new Date().toISOString());
    this.#phase = "active";
  }

  /** Cached RuntimeInstances remain usable only under this exact retained lease. */
  assertCurrent(cwd: string, rootDir: string): void {
    if (this.#phase !== "active" || cwd !== this.#input.cwd || resolve(rootDir) !== this.#input.rootDir) {
      throw new Error("runtime_owner_not_current");
    }
    this.assertLeaseHeld();
    const current = this.readProjection();
    if (!this.isOwnProjection(current) || current.runtimeInstanceId !== this.#currentRuntimeId) {
      throw new Error("runtime_owner_projection_unknown");
    }
  }

  publish(runtime: RuntimeInstance): void {
    this.assertCurrent(this.#input.cwd, this.#input.rootDir);
    if (runtime.pid !== process.pid || runtime.host !== this.#input.host || runtime.port !== this.#input.port) {
      throw new Error("runtime_owner_publication_identity_invalid");
    }
    this.writeProjection(runtime.runtimeInstanceId, runtime.startedAt, runtime.schemaVersion);
  }

  get isReleased(): boolean {
    return this.#phase === "released" && !this.#connection;
  }

  /** Metadata cleanup settles before rollback/close; this is not a tool-stop proof. */
  release(): void {
    if (this.#phase === "released") return;
    this.#phase = "releasing";
    const failures: unknown[] = [];
    if (this.#projectionAttempted) {
      try {
        this.assertLeaseHeld();
        const current = this.readProjection();
        if (this.isOwnProjection(current)) {
          unlinkSync(this.#lockPath);
          this.#projectionOwned = false;
          this.#projectionAttempted = false;
        } else if (this.#projectionOwned) {
          // Do not unlink a missing, malformed or replaced pathname on faith.
          throw new Error("runtime_owner_projection_unknown");
        }
      } catch (error) { failures.push(error); }
    }
    // An unchanged/unknown projection is still this owner's unfinished cleanup.
    // Keep the private writer transaction and owner object for an exact retry;
    // freeing SQLite here would admit a successor before cleanup has settled.
    throwFailures(failures, "runtime_owner_projection_cleanup_incomplete");
    const connection = this.#connection;
    if (connection) {
      if (this.#transactionHeld) {
        try {
          connection.exec("ROLLBACK");
          this.#transactionHeld = false;
        } catch (error) { failures.push(error); }
      }
      try {
        connection.close();
        this.#connection = undefined;
        this.#transactionHeld = false;
      } catch (error) {
        failures.push(error);
        if (!connection.isOpen) {
          this.#connection = undefined;
          this.#transactionHeld = false;
        }
      }
    }
    if (!this.#connection) this.#phase = "released";
    throwFailures(failures, "runtime_owner_release_incomplete");
  }

  private assertLeaseHeld(): void {
    if (!this.#connection?.isOpen || !this.#transactionHeld) throw new Error("runtime_owner_lease_unknown");
  }

  private isOwnProjection(value: RuntimeLockProjection | undefined): value is RuntimeLockProjection {
    return value?.ownerId === this.#ownerId && value.pid === process.pid
      && value.cwd === this.#input.cwd && value.host === this.#input.host && value.port === this.#input.port
      && typeof value.runtimeInstanceId === "string" && this.#attemptedRuntimeIds.has(value.runtimeInstanceId);
  }

  private readProjection(): RuntimeLockProjection | undefined {
    let bytes: string;
    try { bytes = readFileSync(this.#lockPath, "utf8"); }
    catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
    let value: unknown;
    try { value = JSON.parse(bytes); }
    catch (error) { throw new Error("runtime_owner_projection_invalid", { cause: error }); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("runtime_owner_projection_invalid");
    const parsed = value as Record<string, unknown>;
    if (!Number.isInteger(parsed.pid) || (parsed.pid as number) <= 0 || typeof parsed.host !== "string"
      || !Number.isInteger(parsed.port) || (parsed.port as number) < 0 || (parsed.port as number) > 65_535) {
      throw new Error("runtime_owner_projection_invalid");
    }
    return { pid: parsed.pid as number, host: parsed.host, port: parsed.port as number,
      ...(typeof parsed.runtimeInstanceId === "string" ? { runtimeInstanceId: parsed.runtimeInstanceId } : {}),
      ...(typeof parsed.ownerId === "string" ? { ownerId: parsed.ownerId } : {}),
      ...(typeof parsed.cwd === "string" ? { cwd: parsed.cwd } : {}) };
  }

  /** Publish whole diagnostic bytes by same-directory rename while the lease is held. */
  private writeProjection(runtimeInstanceId: string, startedAt: string, schemaVersion?: number): void {
    this.assertLeaseHeld();
    const temporary = `${this.#lockPath}.${randomUUID()}.tmp`;
    const failures: unknown[] = [];
    let descriptor: number | undefined;
    let created = false;
    let renamed = false;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      created = true;
      writeFileSync(descriptor, `${JSON.stringify({ ownerId: this.#ownerId, runtimeInstanceId, pid: process.pid,
        host: this.#input.host, port: this.#input.port, cwd: this.#input.cwd, startedAt,
        ...(schemaVersion !== undefined ? { schemaVersion } : {}) }, null, 2)}\n`);
    } catch (error) { failures.push(error); }
    if (descriptor !== undefined) {
      // Do not retry a descriptor whose close outcome is unknown: the numeric FD
      // may already be reused. Preserve that failure and never publish its bytes.
      try { closeSync(descriptor); } catch (error) { failures.push(error); }
    }
    if (failures.length === 0) {
      this.#attemptedRuntimeIds.add(runtimeInstanceId);
      this.#projectionAttempted = true;
      try {
        renameSync(temporary, this.#lockPath);
        renamed = true;
        this.#projectionOwned = true;
        this.#currentRuntimeId = runtimeInstanceId;
      } catch (error) { failures.push(error); }
    }
    if (created && !renamed) {
      try { unlinkSync(temporary); }
      catch (error) { if (!hasCode(error, "ENOENT")) failures.push(error); }
    }
    throwFailures(failures, "runtime_owner_publication_cleanup_incomplete");
  }
}

function isConfirmedExited(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) {
    if (hasCode(error, "ESRCH")) return true;
    throw new Error("runtime_owner_liveness_unknown", { cause: error });
  }
}

function isSqliteBusy(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "errcode" in error
    && typeof error.errcode === "number" && (error.errcode & 0xff) === 5);
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function throwFailures(failures: readonly unknown[], message: string): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message, { cause: failures[0] });
}
