import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { createSqliteWorkflowIsolationStore, workflowIntegrationRoundInputsDigest,
  type RunStore, type WorkflowIntegrationRoundInputsV1 } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { workflowGit } from "./managed-worktrees.js";
import { verifyWorkflowRepositoryCheckouts } from "./workflow-retained-checkouts.js";

interface RepositoryFenceOwner {
  readonly schemaVersion: 1;
  readonly commonDir: string;
  readonly commonDevice: string;
  readonly commonInode: string;
  readonly canonicalRoot: string;
  readonly databasePath: string;
  readonly roundId: string;
  readonly generation: number;
  readonly inputsDigest: string;
}
interface RepositoryFence {
  readonly owner: RepositoryFenceOwner;
  readonly ownerJson: string;
  readonly reservationToken?: string;
  readonly reservationProtocol?: typeof planningReservationProtocol;
  readonly state: "held" | "released";
}
interface RepositoryStore {
  readonly canonicalRoot: string;
  readonly databasePath: string;
  readonly databaseDevice: string;
  readonly databaseInode: string;
}
const filename = "ling-workflow-repository-fence.sqlite";
const planningReservationProtocol = "sqlite_writer_v1";

const busy = () => new HttpError(409, "workflow_repository_busy", "This repository is reserved by an isolated workflow round.");
function unknown(cause?: unknown): HttpError {
  const error = new HttpError(409, "workflow_repository_fence_unknown",
    "Repository ownership cannot be verified; retained effects must be reconciled before another Run starts.");
  if (cause !== undefined) error.cause = cause;
  return error;
}

function ownerFor(store: RunStore, roundId: string, generation: number, inputs: WorkflowIntegrationRoundInputsV1): RepositoryFenceOwner {
  const commonDir = inputs.repositoryIdentity.commonDir, identity = lstatSync(commonDir, { bigint: true });
  if (!identity.isDirectory() || identity.isSymbolicLink() || realpathSync.native(commonDir) !== commonDir) throw unknown();
  return { schemaVersion: 1, commonDir, commonDevice: String(identity.dev), commonInode: String(identity.ino),
    canonicalRoot: inputs.canonicalWorkspaceRoot, databasePath: realpathSync.native(store.paths.databasePath),
    roundId, generation, inputsDigest: workflowIntegrationRoundInputsDigest(inputs) };
}

/** Shared across checkout-local Stores and daemon processes; no PID/TTL takeover or pathname deletion. */
export async function reserveWorkflowRepositoryFence(store: RunStore, roundId: string,
  inputs: WorkflowIntegrationRoundInputsV1): Promise<string | undefined> {
  const { reservationToken } = reserveFenceRow(store, roundId, inputs, false);
  if (reservationToken === undefined) return undefined;
  try {
    // Inventory after reserving: a new checkout cannot enter Run admission in the inspection window.
    if (!createSqliteWorkflowIsolationStore(store).getIntegrationRound(roundId)) {
      await verifyWorkflowRepositoryCheckouts(store, inputs,
        (await workflowGit(inputs.canonicalWorkspaceRoot, ["worktree", "list", "--porcelain", "-z"])).stdout);
    }
  } catch (error) {
    releaseWorkflowRepositoryFence(store, roundId, 1, inputs, undefined, reservationToken);
    throw error;
  }
  return reservationToken;
}

/** Only this writer transaction may freeze a recoverable reservation, including across awaits. */
export async function withWorkflowRepositoryFence<T>(store: RunStore, roundId: string,
  inputs: WorkflowIntegrationRoundInputsV1, freeze: () => Promise<T>): Promise<T> {
  const { owner, reservationToken } = reserveFenceRow(store, roundId, inputs, true);
  const isolation = createSqliteWorkflowIsolationStore(store), database = openDatabase(owner.commonDir, false);
  try {
    let current: RepositoryFence;
    try {
      beginRepositoryWriter(database);
      const held = readFence(database, owner.commonDir);
      // COMMIT/re-BEGIN is synchronous, but another process can still win between them.
      if (held?.state !== "held" || !isDeepStrictEqual(held.owner, owner)
        || reservationToken !== undefined && held.reservationToken !== reservationToken) throw busy();
      current = held;
    } catch (error) { throw error instanceof HttpError ? error : unknown(error); }
    try {
      if (!isolation.getIntegrationRound(roundId, 1)) {
        await verifyWorkflowRepositoryCheckouts(store, inputs,
          (await workflowGit(inputs.canonicalWorkspaceRoot, ["worktree", "list", "--porcelain", "-z"])).stdout);
      }
      const result = await freeze();
      const round = isolation.getIntegrationRound(roundId, 1);
      if (!round || workflowIntegrationRoundInputsDigest(round.inputs) !== owner.inputsDigest) throw unknown();
      try { database.exec("COMMIT"); } catch (error) { throw unknown(error); }
      return result;
    } catch (error) {
      // A committed Core round keeps the durable marker even if the sidecar COMMIT failed.
      // Otherwise only this transaction's exact token may compensate its unused reservation.
      if (reservationToken !== undefined && !isolation.getIntegrationRound(roundId, 1)) {
        try {
          database.prepare("UPDATE repository_fence SET state='released' WHERE singleton=1 AND state='held' AND owner_json=?")
            .run(current.ownerJson);
          database.exec("COMMIT");
        } catch (cause) { throw unknown(cause); }
      }
      throw error;
    }
  } finally { database.close(); }
}

function reserveFenceRow(store: RunStore, roundId: string, inputs: WorkflowIntegrationRoundInputsV1,
  recoverable: boolean): { readonly owner: RepositoryFenceOwner; readonly reservationToken: string | undefined } {
  const owner = ownerFor(store, roundId, 1, inputs), path = join(owner.commonDir, filename);
  const identity = storeIdentity(store), isolation = createSqliteWorkflowIsolationStore(store);
  ensureDatabaseFile(path);
  const reservationToken = withDatabase(owner.commonDir, false, database => {
    beginRepositoryWriter(database);
    initializeIfEmpty(database);
    const prior = readFence(database, owner.commonDir);
    if (prior?.state === "held" && !isDeepStrictEqual(prior.owner, owner)) throw busy();
    const round = isolation.getIntegrationRound(roundId, 1);
    if (round && workflowIntegrationRoundInputsDigest(round.inputs) !== owner.inputsDigest) throw unknown();
    registerStore(database, identity);
    // A different Store may have passed admission before this reservation. Its history is
    // deliberately not reclaimed by PID, TTL or a momentary absence of resource rows.
    if (readStores(database).some(value => !isDeepStrictEqual(value, identity))) throw new HttpError(409,
      "workflow_repository_stores_unsupported", "This isolated parallel profile requires one canonical Host database per repository.");
    // Legacy token-only callers cannot prove that a no-round planner has stopped.
    // Marked planners can only freeze while holding this same SQLite writer lock.
    if (prior?.state === "held") {
      if (round) {
        database.exec("COMMIT");
        return undefined;
      }
      if (!recoverable || prior.reservationProtocol !== planningReservationProtocol || !prior.reservationToken) throw busy();
    }
    const token = randomUUID();
    database.prepare(`INSERT INTO repository_fence(singleton,owner_json,state) VALUES(1,?,'held')
      ON CONFLICT(singleton) DO UPDATE SET owner_json=excluded.owner_json,state='held'`)
      .run(JSON.stringify({ ...owner, reservationToken: token,
        ...(recoverable ? { reservationProtocol: planningReservationProtocol } : {}) }));
    // Persist before Core freeze: rollback after a later Core commit must not open Run admission.
    database.exec("COMMIT");
    return token;
  });
  return { owner, reservationToken };
}

/** Core is the release authority. Unknown rounds/effects stay held, including after a crash. */
export function releaseWorkflowRepositoryFence(store: RunStore, roundId: string, generation: number,
  inputs: WorkflowIntegrationRoundInputsV1, now = new Date().toISOString(), reservationToken?: string): void {
  if (!present(join(inputs.repositoryIdentity.commonDir, filename))) return;
  const isolation = createSqliteWorkflowIsolationStore(store);
  const owner = ownerFor(store, roundId, generation, inputs);
  withDatabase(owner.commonDir, false, database => {
    beginRepositoryWriter(database);
    const current = readFence(database, owner.commonDir);
    // Read Core only after excluding a concurrent planner's freeze/commit.
    const round = isolation.getIntegrationRound(roundId, generation);
    // Marked no-round reservations are recoverable by a new writer, never by detached token cleanup.
    if (!round && (reservationToken === undefined || current?.reservationProtocol !== undefined)
      || round && isolation.reconcileParallelParentFence({ roundId, generation, now }).status !== "released") return;
    if (current?.state === "held" && isDeepStrictEqual(current.owner, owner)
      && (reservationToken === undefined || current.reservationToken === reservationToken)) {
      database.prepare("UPDATE repository_fence SET state='released' WHERE singleton=1 AND state='held' AND owner_json=?")
        .run(current.ownerJson);
    }
    database.exec("COMMIT");
  });
}

/** Synchronous pre-admission check, also used by native, delegated and continuation paths. */
export function assertWorkflowRepositoryRunAllowed(store: RunStore, request: {
  readonly cwd: string; readonly workflowStepId?: string;
  readonly workflowIsolationPlan?: { readonly planId: string; readonly planDigest: string };
}): void {
  const commonDirs = new Set([gitCommonDir(store.paths.cwd), gitCommonDir(request.cwd)].filter((value): value is string => !!value));
  let matched = false;
  for (const commonDir of commonDirs) {
    ensureDatabaseFile(join(commonDir, filename));
    withDatabase(commonDir, false, database => {
      beginRepositoryWriter(database);
      initializeIfEmpty(database);
      const fence = readFence(database, commonDir);
      if (fence?.state === "held") {
        const pin = request.workflowIsolationPlan;
        if (!pin || !request.workflowStepId) throw busy();
        const isolation = createSqliteWorkflowIsolationStore(store), plan = isolation.getScopePlan(pin.planId);
        const round = plan && isolation.getIntegrationRound(plan.integrationRoundId, plan.generation);
        if (!plan || plan.planDigest !== pin.planDigest || plan.workflowStepId !== request.workflowStepId
          || plan.executionRoot !== request.cwd || !round?.inputs.parallelExecution || round.generation !== plan.generation
          || !isDeepStrictEqual(fence.owner, ownerFor(store, round.roundId, round.generation, round.inputs))) throw busy();
        matched = true;
      }
      registerStore(database, storeIdentity(store));
      database.exec("COMMIT");
    });
  }
  if (!matched && request.workflowIsolationPlan) {
    const isolation = createSqliteWorkflowIsolationStore(store), plan = isolation.getScopePlan(request.workflowIsolationPlan.planId);
    if (plan && isolation.getIntegrationRound(plan.integrationRoundId, plan.generation)?.inputs.parallelExecution) throw unknown();
  }
}

function ensureDatabaseFile(path: string): void {
  try { closeSync(openSync(path, "wx", 0o600)); }
  catch (error) { if (!hasCode(error, "EEXIST")) throw unknown(error); }
}

/** Called only while holding the writer transaction, including after an interrupted first open. */
function initializeIfEmpty(database: DatabaseSync): void {
  const version = database.prepare("PRAGMA user_version").get()?.user_version;
  if (version === 1) return;
  if (version !== 0 || database.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()
    || database.prepare("SELECT 1 FROM sqlite_temp_schema LIMIT 1").get()
    || database.prepare("PRAGMA application_id").get()?.application_id !== 0) throw unknown();
  database.exec(`CREATE TABLE repository_fence (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('held','released')));
    CREATE TABLE repository_stores (database_path TEXT PRIMARY KEY, identity_json TEXT NOT NULL);
    PRAGMA user_version=1;`);
}

function storeIdentity(store: RunStore): RepositoryStore {
  try {
    const databasePath = realpathSync.native(store.paths.databasePath), stat = lstatSync(databasePath, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) throw unknown();
    return { canonicalRoot: realpathSync.native(store.paths.cwd), databasePath,
      databaseDevice: String(stat.dev), databaseInode: String(stat.ino) };
  } catch (error) { throw unknown(error); }
}

function readStores(database: DatabaseSync): readonly RepositoryStore[] {
  return database.prepare("SELECT database_path,identity_json FROM repository_stores").all().map(row => {
    const raw: unknown = JSON.parse(String(row.identity_json));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw unknown();
    const value = raw as Record<string, unknown>;
    if (typeof value.canonicalRoot !== "string" || !isAbsolute(value.canonicalRoot)
      || value.databasePath !== row.database_path || typeof value.databasePath !== "string" || !isAbsolute(value.databasePath)
      || typeof value.databaseDevice !== "string" || !/^\d+$/u.test(value.databaseDevice)
      || typeof value.databaseInode !== "string" || !/^\d+$/u.test(value.databaseInode)) throw unknown();
    return raw as RepositoryStore;
  });
}

function registerStore(database: DatabaseSync, identity: RepositoryStore): void {
  const existing = readStores(database).find(value => value.databasePath === identity.databasePath);
  if (existing && !isDeepStrictEqual(existing, identity)) throw unknown();
  if (!existing) database.prepare("INSERT INTO repository_stores(database_path,identity_json) VALUES(?,?)")
    .run(identity.databasePath, JSON.stringify(identity));
}

function withDatabase<T>(commonDir: string, readOnly: boolean, operation: (database: DatabaseSync) => T): T {
  let database: DatabaseSync | undefined;
  try {
    database = openDatabase(commonDir, readOnly);
    return operation(database);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw unknown(error);
  } finally { database?.close(); }
}

function openDatabase(commonDir: string, readOnly: boolean): DatabaseSync {
  let database: DatabaseSync | undefined;
  try {
    const path = join(commonDir, filename), identity = lstatSync(path);
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1 || realpathSync.native(path) !== path) throw unknown();
    database = new DatabaseSync(path, { readOnly });
    database.exec("PRAGMA busy_timeout=0");
    if (!readOnly) database.exec("PRAGMA synchronous=FULL");
    return database;
  } catch (error) {
    database?.close();
    throw error instanceof HttpError ? error : unknown(error);
  }
}

function beginRepositoryWriter(database: DatabaseSync): void {
  try { database.exec("BEGIN IMMEDIATE"); }
  catch (error) {
    if (error && typeof error === "object" && "errcode" in error && [5, 6].includes(Number(error.errcode))) throw busy();
    throw unknown(error);
  }
}

function readFence(database: DatabaseSync, commonDir: string): RepositoryFence | undefined {
  if (database.prepare("PRAGMA user_version").get()?.user_version !== 1) throw unknown();
  const row = database.prepare("SELECT owner_json,state FROM repository_fence WHERE singleton=1").get();
  if (!row) return undefined;
  const raw: unknown = JSON.parse(String(row.owner_json));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw unknown();
  const value = raw as Record<string, unknown>, stat = lstatSync(commonDir, { bigint: true });
  if (value.schemaVersion !== 1 || value.commonDir !== commonDir || value.commonDevice !== String(stat.dev)
    || value.commonInode !== String(stat.ino) || typeof value.canonicalRoot !== "string" || !isAbsolute(value.canonicalRoot)
    || typeof value.databasePath !== "string" || !isAbsolute(value.databasePath) || typeof value.roundId !== "string"
    || !value.roundId || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1
    || typeof value.inputsDigest !== "string" || !value.inputsDigest || !["held", "released"].includes(String(row.state))) throw unknown();
  const { reservationToken, reservationProtocol, ...owner } = value;
  if (reservationToken !== undefined && (typeof reservationToken !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(reservationToken))) throw unknown();
  if (reservationProtocol !== undefined && reservationProtocol !== planningReservationProtocol) throw unknown();
  return { owner: owner as unknown as RepositoryFenceOwner, ownerJson: String(row.owner_json),
    reservationToken: reservationToken as string | undefined, reservationProtocol: reservationProtocol as RepositoryFence["reservationProtocol"],
    state: row.state as RepositoryFence["state"] };
}

/** Read Git's gitfile/commondir indirection without adding a synchronous process producer. */
function gitCommonDir(cwd: string): string | undefined {
  let root: string;
  try { root = realpathSync.native(cwd); }
  catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw unknown(error); }
  for (;;) {
    const dotGit = join(root, ".git");
    if (present(dotGit)) {
      const stat = lstatSync(dotGit);
      if (stat.isSymbolicLink()) throw unknown();
      const text = stat.isFile() ? privateText(dotGit) : undefined;
      if (text !== undefined && !text.startsWith("gitdir: ")) throw unknown();
      const gitDir = realpathSync.native(text === undefined ? dotGit : resolve(root, onePath(text.slice(8))));
      const commonFile = join(gitDir, "commondir");
      return realpathSync.native(present(commonFile) ? resolve(gitDir, onePath(privateText(commonFile))) : gitDir);
    }
    const parent = dirname(root);
    if (parent === root) return undefined;
    root = parent;
  }
}
function onePath(text: string): string {
  const value = text.replace(/\r?\n$/u, "");
  if (!value || /[\x00-\x1f\x7f]/u.test(value)) throw unknown();
  return value;
}
function privateText(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384) throw unknown();
    const bytes = readFileSync(fd);
    if (bytes.length !== stat.size) throw unknown();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally { closeSync(fd); }
}
function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if (hasCode(error, "ENOENT")) return false; throw unknown(error); }
}
function hasCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}
