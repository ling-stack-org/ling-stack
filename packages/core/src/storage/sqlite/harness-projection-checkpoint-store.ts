import { createHash } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import {
  HARNESS_PROJECTION_DOMAINS,
  HarnessReliabilityError,
  type HarnessProjectionCheckpoint,
  type HarnessProjectionDomain,
  type HarnessProjectionPage,
  type HarnessProjectionRow,
  type HarnessProjectionStore,
} from "../../harness/reliability.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import {
  HARNESS_PROJECTION_EMPTY_DIGEST,
  harnessProjectionSources,
  harnessReliabilityIdentity,
  harnessReliabilityLimit,
  harnessReliabilityTime,
} from "./harness-reliability-schema.js";
import type { SqliteStoreContext } from "./store-context.js";

type Row = Record<string, SQLOutputValue>;

/** Restartable, epoch-fenced metadata projection. Authority is always the four source stores. */
export class SqliteHarnessProjectionCheckpointStore implements HarnessProjectionStore {
  constructor(private readonly context: SqliteStoreContext) {}

  getHarnessProjectionCheckpoint(domain: HarnessProjectionDomain): HarnessProjectionCheckpoint {
    assertDomain(domain);
    const row = this.context.database.prepare("SELECT * FROM harness_projection_checkpoints WHERE domain=?").get(domain);
    if (!row) throw new HarnessReliabilityError("projection.checkpoint_missing");
    return mapCheckpoint(row);
  }

  reconcileHarnessProjectionPage(input: {
    readonly domain: HarnessProjectionDomain; readonly now: string; readonly limit?: number;
  }): HarnessProjectionCheckpoint {
    assertDomain(input.domain);
    const now = harnessReliabilityTime(input.now);
    const limit = harnessReliabilityLimit(input.limit);
    const database = this.context.database;
    database.exec("BEGIN IMMEDIATE");
    try {
      let checkpoint = this.getHarnessProjectionCheckpoint(input.domain);
      if (checkpoint.state === "ready" && checkpoint.sourceEpoch === checkpoint.builtEpoch) {
        database.exec("COMMIT");
        return checkpoint;
      }
      if (checkpoint.state !== "rebuilding" || checkpoint.sourceEpoch !== checkpoint.builtEpoch) {
        if (checkpoint.generation >= Number.MAX_SAFE_INTEGER - 1) throw new HarnessReliabilityError("projection.generation_exhausted");
        database.prepare(`UPDATE harness_projection_checkpoints SET generation=generation+1,
          built_epoch=source_epoch,state='rebuilding',row_count=0,digest=?,cursor=NULL,failure_code=NULL,updated_at=?
          WHERE domain=?`).run(HARNESS_PROJECTION_EMPTY_DIGEST, now, input.domain);
        // State is already rebuilding, so this legitimate purge does not trip the ready-integrity trigger.
        database.prepare("DELETE FROM harness_projection_rows WHERE domain=?").run(input.domain);
        checkpoint = this.getHarnessProjectionCheckpoint(input.domain);
      }
      const source = harnessProjectionSources[input.domain];
      const statement = database.prepare(`SELECT ${source.columns} FROM ${source.table}
        ${checkpoint.cursor === undefined ? "" : "WHERE id COLLATE BINARY > ?"} ORDER BY id COLLATE BINARY LIMIT ?`);
      statement.setReadBigInts(true);
      const sourceRows = checkpoint.cursor === undefined ? statement.all(limit + 1) : statement.all(checkpoint.cursor, limit + 1);
      // Validate the probe as well; a corrupt tail must never disappear behind a pagination boundary.
      const mapped = sourceRows.map(row => mapSource(row));
      const items = mapped.slice(0, limit);
      let digest = checkpoint.digest;
      const insert = database.prepare(`INSERT INTO harness_projection_rows
        (domain,generation,source_id,metadata_json,content_sha256) VALUES (?,?,?,?,?)`);
      for (const item of items) {
        const json = JSON.stringify(item);
        const contentSha256 = sha(json);
        digest = sha(`${digest}\n${item.id}\n${contentSha256}`);
        insert.run(input.domain, checkpoint.generation, item.id, json, contentSha256);
      }
      const count = checkpoint.rowCount + items.length;
      if (!Number.isSafeInteger(count)) throw new HarnessReliabilityError("projection.row_count_exhausted");
      const complete = mapped.length <= limit;
      const cursor = items.at(-1)?.id ?? checkpoint.cursor;
      if (complete) {
        const stored = database.prepare("SELECT COUNT(*) AS count FROM harness_projection_rows WHERE domain=? AND generation=?")
          .get(input.domain, checkpoint.generation);
        if (stored?.count !== count) throw new HarnessReliabilityError("projection.row_count_mismatch");
      }
      const updated = database.prepare(`UPDATE harness_projection_checkpoints SET state=?,row_count=?,digest=?,cursor=?,updated_at=?
        WHERE domain=? AND generation=? AND state='rebuilding' AND source_epoch=? AND built_epoch=?`)
        .run(complete ? "ready" : "rebuilding", count, digest, cursor ?? null, now,
          input.domain, checkpoint.generation, checkpoint.sourceEpoch, checkpoint.builtEpoch);
      if (Number(updated.changes) !== 1) throw new HarnessReliabilityError("projection.source_changed");
      const result = this.getHarnessProjectionCheckpoint(input.domain);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      rollbackOwnedSqliteTransaction(database);
      this.markFailed(input.domain);
      throw error;
    }
  }

  queryHarnessProjection(input: {
    readonly domain: HarnessProjectionDomain; readonly generation: number; readonly after?: string; readonly limit?: number;
  }): HarnessProjectionPage {
    assertDomain(input.domain);
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new TypeError("projection.generation_invalid");
    const after = input.after === undefined ? undefined : harnessReliabilityIdentity(input.after);
    const limit = harnessReliabilityLimit(input.limit);
    const database = this.context.database;
    database.exec("BEGIN DEFERRED");
    try {
      const checkpoint = this.getHarnessProjectionCheckpoint(input.domain);
      if (checkpoint.state !== "ready" || checkpoint.generation !== input.generation || checkpoint.sourceEpoch !== checkpoint.builtEpoch) {
        throw new HarnessReliabilityError("projection.not_current");
      }
      const statement = database.prepare(`SELECT source_id,metadata_json,content_sha256 FROM harness_projection_rows
        WHERE domain=? AND generation=? ${after === undefined ? "" : "AND source_id COLLATE BINARY > ?"}
        ORDER BY source_id COLLATE BINARY LIMIT ?`);
      const rows = after === undefined ? statement.all(input.domain, input.generation, limit + 1)
        : statement.all(input.domain, input.generation, after, limit + 1);
      const mapped = rows.map(row => {
        if (typeof row.metadata_json !== "string" || Buffer.byteLength(row.metadata_json) >= 16_384
          || sha(row.metadata_json) !== row.content_sha256) throw new HarnessReliabilityError("projection.row_digest_mismatch");
        const parsed: unknown = JSON.parse(row.metadata_json);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HarnessReliabilityError("projection.row_invalid");
        const item = parsed as HarnessProjectionRow;
        if (item.id !== row.source_id) throw new HarnessReliabilityError("projection.row_identity_mismatch");
        validateMetadata(item);
        return item;
      });
      const items = mapped.slice(0, limit);
      const last = items.at(-1);
      database.exec("COMMIT");
      return { checkpoint, items, ...(mapped.length > limit && last ? { nextCursor: last.id } : {}) };
    } catch (error) {
      rollbackOwnedSqliteTransaction(database);
      if (!(error instanceof HarnessReliabilityError && error.code === "projection.not_current")) this.markFailed(input.domain);
      throw error;
    }
  }

  private markFailed(domain: HarnessProjectionDomain): void {
    this.context.database.prepare(`UPDATE harness_projection_checkpoints SET state='failed',failure_code='projection.rebuild_or_read_failed'
      WHERE domain=?`).run(domain);
  }
}

function assertDomain(value: unknown): asserts value is HarnessProjectionDomain {
  if (!HARNESS_PROJECTION_DOMAINS.includes(value as HarnessProjectionDomain)) throw new TypeError("projection.domain_invalid");
}
function sha(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function number(value: SQLOutputValue | undefined): number {
  if ((typeof value !== "number" && typeof value !== "bigint") || !Number.isSafeInteger(Number(value)) || Number(value) < 0) {
    throw new HarnessReliabilityError("projection.integer_invalid");
  }
  return Number(value);
}
function mapCheckpoint(row: Row): HarnessProjectionCheckpoint {
  assertDomain(row.domain);
  if (!["stale", "rebuilding", "ready", "failed"].includes(String(row.state))
    || typeof row.digest !== "string" || !/^[a-f0-9]{64}$/.test(row.digest)) throw new HarnessReliabilityError("projection.checkpoint_invalid");
  return {
    domain: row.domain, generation: number(row.generation), sourceEpoch: number(row.source_epoch), builtEpoch: number(row.built_epoch),
    state: row.state as HarnessProjectionCheckpoint["state"], rowCount: number(row.row_count), digest: row.digest,
    ...(row.cursor == null ? {} : { cursor: harnessReliabilityIdentity(row.cursor) }),
    ...(row.failure_code == null ? {} : { failureCode: harnessReliabilityIdentity(row.failure_code) }),
    updatedAt: harnessReliabilityTime(row.updated_at),
  };
}
function mapSource(row: Row): HarnessProjectionRow {
  const item: HarnessProjectionRow = {
    id: harnessReliabilityIdentity(row.id), runId: harnessReliabilityIdentity(row.run_id),
    ...(row.root_run_id == null ? {} : { rootRunId: harnessReliabilityIdentity(row.root_run_id) }),
    ...(row.work_unit_id == null ? {} : { workUnitId: harnessReliabilityIdentity(row.work_unit_id) }),
    state: harnessReliabilityIdentity(row.state), revision: number(row.revision), updatedAt: harnessReliabilityTime(row.updated_at),
  };
  validateMetadata(item);
  return item;
}
function validateMetadata(item: HarnessProjectionRow): void {
  harnessReliabilityIdentity(item.id);
  harnessReliabilityIdentity(item.runId);
  harnessReliabilityIdentity(item.state);
  harnessReliabilityTime(item.updatedAt);
  if (!Number.isSafeInteger(item.revision) || item.revision < 0) throw new HarnessReliabilityError("projection.integer_invalid");
  if (item.rootRunId !== undefined) harnessReliabilityIdentity(item.rootRunId);
  if (item.workUnitId !== undefined) harnessReliabilityIdentity(item.workUnitId);
}
