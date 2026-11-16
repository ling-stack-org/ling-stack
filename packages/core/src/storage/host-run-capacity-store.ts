import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, normalize } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import type {
  HostRunCapacityCounts, HostRunCapacityIntent, HostRunCapacityPage, HostRunCapacityPolicy,
  HostRunCapacityReservation, HostRunCapacityStoreOptions, InstallHostRunCapacityPolicyInput,
  InstallHostRunCapacityPolicyResult, ListHeldHostRunCapacityInput, ReleaseHostRunCapacityInput,
  ReleaseHostRunCapacityResult, ReserveHostRunCapacityInput, ReserveHostRunCapacityResult,
} from "../host-run-capacity-types.js";

const markerTable = "host_run_capacity_schema", policyTable = "host_run_capacity_policy";
const reservationTable = "host_run_capacity_reservations";
const intentFields = ["intentId", "workspaceKey", "canonicalCwd", "databasePath", "databaseFileIdentity",
  "ownerKind", "ownerKey", "authorityDigest"] as const;
const intentColumns = ["intent_id", "workspace_key", "canonical_cwd", "database_path", "database_file_identity",
  "owner_kind", "owner_key", "authority_digest"] as const;
const textSql = (column: string) => `typeof(${column})='text' AND length(trim(${column}))>0 AND instr(${column},char(0))=0`;
const digestSql = (column: string) => `typeof(${column})='text' AND length(${column})=64 AND ${column} NOT GLOB '*[^0-9a-f]*' AND instr(${column},char(0))=0`;
const timestampSql = (column: string) => `${textSql(column)} AND length(${column})=24 AND ${column} GLOB '????-??-??T??:??:??.???Z'`;
const integerSql = (column: string, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) =>
  `typeof(${column})='integer' AND ${column} BETWEEN ${minimum} AND ${maximum}`;
const legacyDefinitions = [
  { name: markerTable, type: "table", sql: `CREATE TABLE ${markerTable} (
    version INTEGER PRIMARY KEY NOT NULL CHECK(${integerSql("version", 1, 1)}),
    name TEXT NOT NULL UNIQUE CHECK(name='host_run_capacity')
  )` },
  { name: policyTable, type: "table", sql: `CREATE TABLE ${policyTable} (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK(${integerSql("singleton", 1, 1)}),
    revision INTEGER NOT NULL CHECK(${integerSql("revision")}),
    max_concurrent_runs INTEGER NOT NULL CHECK(${integerSql("max_concurrent_runs", 1, 64)}),
    installed_at TEXT NOT NULL CHECK(${timestampSql("installed_at")})
  )` },
  { name: reservationTable, type: "table", sql: `CREATE TABLE ${reservationTable} (
    reservation_id TEXT PRIMARY KEY NOT NULL CHECK(${textSql("reservation_id")}),
    token TEXT NOT NULL UNIQUE CHECK(${digestSql("token")}),
    intent_id TEXT NOT NULL CHECK(${textSql("intent_id")}),
    workspace_key TEXT NOT NULL CHECK(${textSql("workspace_key")}),
    canonical_cwd TEXT NOT NULL CHECK(${textSql("canonical_cwd")}),
    database_path TEXT NOT NULL CHECK(${textSql("database_path")}),
    database_file_identity TEXT NOT NULL CHECK(${textSql("database_file_identity")}),
    owner_kind TEXT NOT NULL CHECK(owner_kind IN ('attempt','workflow_start','delegation_spawn')),
    owner_key TEXT NOT NULL CHECK(${textSql("owner_key")}),
    authority_digest TEXT NOT NULL CHECK(${digestSql("authority_digest")}),
    policy_revision INTEGER NOT NULL CHECK(${integerSql("policy_revision")}),
    reserved_at TEXT NOT NULL CHECK(${timestampSql("reserved_at")}),
    state TEXT NOT NULL CHECK(state IN ('held','released')),
    released_at TEXT CHECK(released_at IS NULL OR (${timestampSql("released_at")})),
    release_kind TEXT CHECK(release_kind IS NULL OR release_kind IN ('no_dispatch','stopped')),
    release_proof_digest TEXT CHECK(release_proof_digest IS NULL OR (${digestSql("release_proof_digest")})),
    UNIQUE(workspace_key,intent_id),
    CHECK((state='held' AND released_at IS NULL AND release_kind IS NULL AND release_proof_digest IS NULL)
      OR (state='released' AND released_at IS NOT NULL AND release_kind IS NOT NULL AND release_proof_digest IS NOT NULL))
  )` },
  { name: "host_run_capacity_reservations_by_state", type: "index",
    sql: `CREATE INDEX host_run_capacity_reservations_by_state ON ${reservationTable}(state,reservation_id)` },
] as const;
const definitions = legacyDefinitions.map(definition => ({ ...definition, sql: (definition.name === markerTable
  ? definition.sql.replace(integerSql("version", 1, 1), integerSql("version", 2, 2))
  : definition.name === reservationTable ? definition.sql.replace("owner_kind IN ('attempt','workflow_start','delegation_spawn')",
    "owner_kind IN ('attempt','workflow_start','delegation_spawn','approval_resume_pending','user_input_continuation')") : definition.sql)
  .replace(`CREATE TABLE ${definition.name}`, definition.name === markerTable || definition.name === reservationTable
    ? `CREATE TABLE "${definition.name}"` : `CREATE TABLE ${definition.name}`) }));
const normalizeSql = (sql: string) => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

function enableWal(database: DatabaseSync, busyTimeoutMs: number): void {
  const deadline = performance.now() + busyTimeoutMs, wait = new Int32Array(new SharedArrayBuffer(4));
  database.exec("PRAGMA busy_timeout=0");
  try {
    for (;;) {
      try { database.exec("PRAGMA journal_mode=WAL"); return; }
      catch (error) {
        const remaining = deadline - performance.now();
        // Journal-mode lock promotion may return SQLITE_BUSY without invoking SQLite's busy handler.
        if (!(error instanceof Error) || !("errcode" in error) || error.errcode !== 5 || remaining <= 0) throw error;
        Atomics.wait(wait, 0, 0, Math.min(10, remaining));
      }
    }
  } finally { database.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`); }
}

function dataObject(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("Host capacity input must be a plain data object.");
  }
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key))) {
      throw new TypeError("Unexpected Host capacity input field.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor)) throw new TypeError("Host capacity fields must be data properties.");
    result[key] = descriptor.value;
  }
  if (required.some(key => !Object.hasOwn(result, key))) throw new TypeError("Missing Host capacity input field.");
  return result;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Host capacity text must be a string.");
  if (!value.trim() || /[\x00-\x1f\x7f]/u.test(value)) throw new RangeError("Host capacity text must be nonempty and contain no controls.");
  return value;
}

function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number") throw new TypeError("Host capacity integer must be a number.");
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError("Host capacity integer is outside its range.");
  return value;
}

function digest(value: unknown): string {
  const result = text(value);
  if (!/^[0-9a-f]{64}$/u.test(result)) throw new RangeError("Host capacity digest must be 64 lowercase hexadecimal characters.");
  return result;
}

function timestamp(value: unknown): string {
  const result = text(value);
  if (result.length !== 24 || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) {
    throw new RangeError("Host capacity time must be a canonical UTC timestamp.");
  }
  return result;
}

function absolutePath(value: unknown): string {
  const result = text(value);
  if (!isAbsolute(result) || normalize(result) !== result) throw new RangeError("Host capacity path must be normalized and absolute.");
  return result;
}

function intentFromInput(value: unknown): HostRunCapacityIntent {
  const input = dataObject(value, intentFields);
  const ownerKind = text(input.ownerKind);
  if (ownerKind !== "attempt" && ownerKind !== "workflow_start" && ownerKind !== "delegation_spawn"
    && ownerKind !== "approval_resume_pending" && ownerKind !== "user_input_continuation") {
    throw new RangeError("Unknown Host capacity owner kind.");
  }
  return Object.freeze({ intentId: text(input.intentId), workspaceKey: text(input.workspaceKey),
    canonicalCwd: absolutePath(input.canonicalCwd), databasePath: absolutePath(input.databasePath),
    databaseFileIdentity: text(input.databaseFileIdentity), ownerKind, ownerKey: text(input.ownerKey),
    authorityDigest: digest(input.authorityDigest) });
}

function sameIntent(left: HostRunCapacityIntent, right: HostRunCapacityIntent): boolean {
  return intentFields.every(key => left[key] === right[key]);
}

function policyFromRow(row: Record<string, SQLOutputValue>): HostRunCapacityPolicy {
  if (row.singleton !== 1) throw new Error("host_run_capacity.policy_invalid");
  return Object.freeze({ revision: integer(row.revision, 1), maxConcurrentRuns: integer(row.max_concurrent_runs, 1, 64),
    installedAt: timestamp(row.installed_at) });
}

function reservationFromRow(row: Record<string, SQLOutputValue>): HostRunCapacityReservation {
  const intent = intentFromInput(Object.fromEntries(intentFields.map((key, index) => [key, row[intentColumns[index]!]])));
  const reservation = { reservationId: text(row.reservation_id), token: digest(row.token), intent,
    policyRevision: integer(row.policy_revision, 1), reservedAt: timestamp(row.reserved_at) };
  if (row.state === "held" && row.released_at === null && row.release_kind === null && row.release_proof_digest === null) {
    return Object.freeze({ ...reservation, state: "held" });
  }
  if (row.state !== "released" || (row.release_kind !== "no_dispatch" && row.release_kind !== "stopped")) {
    throw new Error("host_run_capacity.reservation_invalid");
  }
  const releasedAt = timestamp(row.released_at);
  if (releasedAt < reservation.reservedAt) throw new Error("host_run_capacity.reservation_invalid");
  return Object.freeze({ ...reservation, state: "released", releasedAt,
    releaseKind: row.release_kind, releaseProofDigest: digest(row.release_proof_digest) });
}

export class HostRunCapacityStore {
  readonly database: DatabaseSync;

  constructor(options: HostRunCapacityStoreOptions) {
    const input = dataObject(options, ["globalDatabasePath"], ["busyTimeoutMs"]);
    const path = absolutePath(input.globalDatabasePath);
    const busyTimeoutMs = input.busyTimeoutMs === undefined ? 5_000 : integer(input.busyTimeoutMs, 0, 60_000);
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    try {
      enableWal(this.database, busyTimeoutMs);
      this.database.exec("PRAGMA foreign_keys=OFF");
      this.transaction(() => {
        if (!this.schemaObjects().length) {
          for (const definition of definitions) this.database.exec(definition.sql);
          this.database.prepare(`INSERT INTO ${markerTable}(version,name) VALUES(2,'host_run_capacity')`).run();
        } else if (this.assertSchema(true) === 1) {
          for (const name of [reservationTable, markerTable]) {
            const definition = definitions.find(candidate => candidate.name === name)!;
            const replacement = `${name}_upgrade`;
            this.database.exec(definition.sql.replace(`CREATE TABLE "${name}"`, `CREATE TABLE ${replacement}`));
            if (name === markerTable) {
              this.database.prepare(`INSERT INTO ${replacement}(version,name) VALUES(2,'host_run_capacity')`).run();
            } else this.database.exec(`INSERT INTO ${replacement} SELECT * FROM main.${name}`);
            this.database.exec(`DROP TABLE main.${name}`);
            this.database.exec(`ALTER TABLE ${replacement} RENAME TO ${name}`);
          }
          this.database.exec(`CREATE INDEX host_run_capacity_reservations_by_state ON ${reservationTable}(state,reservation_id)`);
        }
        this.assertSchema();
      });
      this.database.exec("PRAGMA foreign_keys=ON");
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  getPolicy(): HostRunCapacityPolicy | undefined {
    this.assertSchema();
    return this.readPolicy();
  }

  /** Same-limit retries are read-only duplicates; changing a limit requires an exact revision. */
  installPolicy(input: InstallHostRunCapacityPolicyInput): InstallHostRunCapacityPolicyResult {
    const fields = dataObject(input, ["expectedRevision", "maxConcurrentRuns", "installedAt"]);
    const expectedRevision = integer(fields.expectedRevision, 0), maximum = integer(fields.maxConcurrentRuns, 1, 64);
    const installedAt = timestamp(fields.installedAt);
    return this.transaction(() => {
      this.assertSchema();
      const current = this.readPolicy();
      if (current?.maxConcurrentRuns === maximum) return { status: "duplicate", policy: current };
      if ((current?.revision ?? 0) !== expectedRevision || expectedRevision === Number.MAX_SAFE_INTEGER) return { status: "changed" };
      const written = current
        ? this.database.prepare(`UPDATE ${policyTable} SET revision=?,max_concurrent_runs=?,installed_at=? WHERE singleton=1 AND revision=?`)
          .run(expectedRevision + 1, maximum, installedAt, expectedRevision)
        : this.database.prepare(`INSERT INTO ${policyTable}(singleton,revision,max_concurrent_runs,installed_at) VALUES(1,1,?,?)`)
          .run(maximum, installedAt);
      if (written.changes !== 1) throw new Error("host_run_capacity.policy_write_failed");
      return { status: "installed", policy: this.readPolicy()! };
    });
  }

  reserve(input: ReserveHostRunCapacityInput): ReserveHostRunCapacityResult {
    const fields = dataObject(input, ["intent", "now"]);
    const intent = intentFromInput(fields.intent), now = timestamp(fields.now);
    return this.transaction(() => {
      this.assertSchema();
      const current = this.readReservation(intent.workspaceKey, intent.intentId);
      if (current) {
        if (!sameIntent(current.intent, intent)) return { status: "conflict" };
        return { status: current.state === "held" ? "duplicate" : "released", reservation: current };
      }
      const policy = this.readPolicy();
      if (!policy) return { status: "unconfigured" };
      if (this.readCounts().held >= policy.maxConcurrentRuns) return { status: "full", policy };
      const reservationId = randomUUID(), token = randomBytes(32).toString("hex");
      this.database.prepare(`INSERT INTO ${reservationTable}
        (reservation_id,token,${intentColumns.join(",")},policy_revision,reserved_at,state)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'held')`).run(reservationId, token, ...intentFields.map(key => intent[key]), policy.revision, now);
      const reservation = this.readReservation(intent.workspaceKey, intent.intentId);
      if (!reservation || reservation.reservationId !== reservationId || reservation.token !== token
        || !sameIntent(reservation.intent, intent) || reservation.state !== "held") throw new Error("host_run_capacity.reserve_write_failed");
      return { status: "reserved", reservation };
    });
  }

  /** The workspace bridge verifies stop/effect evidence. This store binds its proof, never inferring safety from time or liveness. */
  release(input: ReleaseHostRunCapacityInput): ReleaseHostRunCapacityResult {
    const fields = dataObject(input, ["reservationId", "token", "intent", "kind", "proofDigest", "now"]);
    const reservationId = text(fields.reservationId), token = digest(fields.token), intent = intentFromInput(fields.intent);
    const proofDigest = digest(fields.proofDigest), now = timestamp(fields.now), kind = fields.kind;
    if (kind !== "no_dispatch" && kind !== "stopped") throw new RangeError("Unknown Host capacity release kind.");
    return this.transaction(() => {
      this.assertSchema();
      const row = this.database.prepare(`SELECT * FROM ${reservationTable} WHERE reservation_id=?`).get(reservationId);
      if (!row) return { status: "changed" };
      const current = reservationFromRow(row);
      if (current.token !== token || !sameIntent(current.intent, intent)) return { status: "changed" };
      if (now < current.reservedAt) throw new RangeError("Host capacity release time must not precede reservation time.");
      if (current.state === "released") return current.releaseKind === kind && current.releaseProofDigest === proofDigest
        ? { status: "duplicate", reservation: current } : { status: "changed" };
      const written = this.database.prepare(`UPDATE ${reservationTable} SET state='released',released_at=?,release_kind=?,release_proof_digest=?
        WHERE reservation_id=? AND token=? AND state='held' AND ${intentColumns.map(column => `${column}=?`).join(" AND ")}`)
        .run(now, kind, proofDigest, reservationId, token, ...intentFields.map(key => intent[key]));
      if (written.changes !== 1) throw new Error("host_run_capacity.release_write_failed");
      return { status: "released", reservation: this.readReservation(intent.workspaceKey, intent.intentId)! };
    });
  }

  getReservation(workspaceKey: string, intentId: string): HostRunCapacityReservation | undefined {
    text(workspaceKey); text(intentId);
    this.assertSchema();
    return this.readReservation(workspaceKey, intentId);
  }

  listHeld(input: ListHeldHostRunCapacityInput = {}): HostRunCapacityPage {
    const fields = dataObject(input, [], ["afterReservationId", "limit"]);
    const after = fields.afterReservationId === undefined ? "" : text(fields.afterReservationId);
    const limit = fields.limit === undefined ? 100 : integer(fields.limit, 1, 1_000);
    this.assertSchema();
    const rows = this.database.prepare(`SELECT * FROM ${reservationTable} WHERE state='held' AND reservation_id>? ORDER BY reservation_id LIMIT ?`)
      .all(after, limit + 1);
    const reservations = Object.freeze(rows.slice(0, limit).map(reservationFromRow));
    return Object.freeze({ reservations, ...(rows.length > limit ? { nextCursor: reservations.at(-1)!.reservationId } : {}) });
  }

  counts(): HostRunCapacityCounts {
    this.assertSchema();
    return this.readCounts();
  }

  close(): void { this.database.close(); }

  private readPolicy(): HostRunCapacityPolicy | undefined {
    const rows = this.database.prepare(`SELECT * FROM ${policyTable}`).all();
    if (rows.length > 1) throw new Error("host_run_capacity.policy_invalid");
    return rows[0] ? policyFromRow(rows[0]) : undefined;
  }

  private readReservation(workspaceKey: string, intentId: string): HostRunCapacityReservation | undefined {
    const row = this.database.prepare(`SELECT * FROM ${reservationTable} WHERE workspace_key=? AND intent_id=?`).get(workspaceKey, intentId);
    return row ? reservationFromRow(row) : undefined;
  }

  private readCounts(): HostRunCapacityCounts {
    const row = this.database.prepare(`SELECT COUNT(*) AS total,COALESCE(SUM(state='held'),0) AS held,
      COALESCE(SUM(state='released'),0) AS released FROM ${reservationTable}`).get()!;
    const total = integer(row.total, 0), held = integer(row.held, 0), released = integer(row.released, 0);
    if (total !== held + released) throw new Error("host_run_capacity.counts_invalid");
    return Object.freeze({ held, released, total });
  }

  private schemaObjects(): Record<string, SQLOutputValue>[] {
    const names = definitions.map(definition => definition.name);
    const placeholders = names.map(() => "?").join(",");
    const filter = `WHERE name COLLATE NOCASE IN (${placeholders}) OR tbl_name COLLATE NOCASE IN (${placeholders})`;
    return this.database.prepare(`SELECT 'main' AS schema_name,type,name,tbl_name,sql FROM main.sqlite_master ${filter}
      UNION ALL SELECT 'temp' AS schema_name,type,name,tbl_name,sql FROM temp.sqlite_master ${filter}`)
      .all(...names, ...names, ...names, ...names);
  }

  private assertSchema(allowLegacy = false): 1 | 2 {
    const objects = this.schemaObjects();
    if (objects.some(object => object.schema_name !== "main")) throw new Error("host_run_capacity.schema_invalid");
    const marker = objects.find(object => object.name === markerTable);
    const legacy = allowLegacy && typeof marker?.sql === "string"
      && normalizeSql(marker.sql) === normalizeSql(legacyDefinitions[0].sql);
    const expectedDefinitions = legacy ? legacyDefinitions : definitions;
    for (const definition of expectedDefinitions) {
      const matches = objects.filter(object => object.name === definition.name);
      if (matches.length !== 1 || matches[0]!.type !== definition.type || typeof matches[0]!.sql !== "string"
        || normalizeSql(matches[0]!.sql) !== normalizeSql(definition.sql)) throw new Error("host_run_capacity.schema_invalid");
    }
    if (objects.some(object => !definitions.some(definition => object.name === definition.name)
      && !(object.type === "index" && object.sql === null && typeof object.name === "string"
        && object.name.startsWith("sqlite_autoindex_")))) throw new Error("host_run_capacity.schema_invalid");
    const rows = this.database.prepare(`SELECT version,name FROM ${markerTable}`).all();
    if (rows.length !== 1 || rows[0]!.version !== (legacy ? 1 : 2) || rows[0]!.name !== "host_run_capacity") {
      throw new Error("host_run_capacity.schema_marker_invalid");
    }
    return legacy ? 1 : 2;
  }

  private transaction<T>(operation: () => T): T {
    // A rejected nested BEGIN must never reach this operation's rollback boundary.
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* SQLite may already have aborted this owned transaction. */ }
      throw error;
    }
  }
}

export function createHostRunCapacityStore(options: HostRunCapacityStoreOptions): HostRunCapacityStore {
  return new HostRunCapacityStore(options);
}
