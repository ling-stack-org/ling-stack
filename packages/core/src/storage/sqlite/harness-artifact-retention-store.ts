import { createHash } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import {
  HarnessReliabilityError,
  type HarnessArtifactRetention,
  type HarnessArtifactRetentionStore,
} from "../../harness/reliability.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { harnessReliabilityIdentity, harnessReliabilityLimit, harnessReliabilityTime } from "./harness-reliability-schema.js";
import type { SqliteStoreContext } from "./store-context.js";

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const ownTables = new Set(["harness_artifact_retention", "harness_artifact_pins", "harness_artifact_pin_events", "harness_artifact_gc_receipts"]);

/** Explicit Host policy, never a default age-based deletion of all artifacts. */
export class SqliteHarnessArtifactRetentionStore implements HarnessArtifactRetentionStore {
  constructor(private readonly context: SqliteStoreContext) {}

  enrollHarnessArtifactRetention(input: { readonly artifactId: string; readonly retainUntil: string; readonly now: string }): HarnessArtifactRetention {
    const artifactId = harnessReliabilityIdentity(input.artifactId);
    const now = harnessReliabilityTime(input.now);
    const retainUntil = harnessReliabilityTime(input.retainUntil);
    if (retainUntil < now) throw new TypeError("artifact_retention_deadline_in_past");
    return this.transaction(() => {
      const body = this.readRetainedBody(artifactId);
      const existing = this.getHarnessArtifactRetention(artifactId);
      if (existing && existing.contentSha256 !== body.contentSha256) throw new HarnessReliabilityError("artifact.retention_digest_changed");
      this.context.database.prepare(`INSERT INTO harness_artifact_retention
        (artifact_id,content_sha256,retain_until,enrolled_at) VALUES (?,?,?,?)
        ON CONFLICT(artifact_id) DO UPDATE SET retain_until=MAX(retain_until,excluded.retain_until)`)
        .run(artifactId, body.contentSha256, retainUntil, now);
      return this.getHarnessArtifactRetention(artifactId)!;
    });
  }

  pinHarnessArtifact(input: { readonly artifactId: string; readonly holder: string; readonly reason: "recovery" | "audit_hold"; readonly now: string }): void {
    const artifactId = harnessReliabilityIdentity(input.artifactId);
    const holder = harnessReliabilityIdentity(input.holder);
    const now = harnessReliabilityTime(input.now);
    if (input.reason !== "recovery" && input.reason !== "audit_hold") throw new TypeError("artifact_pin_reason_invalid");
    this.transaction(() => {
      this.readRetainedBody(artifactId);
      const existing = this.context.database.prepare("SELECT reason,released_at FROM harness_artifact_pins WHERE artifact_id=? AND holder=?").get(artifactId, holder);
      if (existing && existing.reason !== input.reason) throw new HarnessReliabilityError("artifact.pin_holder_conflict");
      if (existing && existing.released_at === null) return;
      this.context.database.prepare(`INSERT INTO harness_artifact_pins(artifact_id,holder,reason,created_at)
        VALUES (?,?,?,?) ON CONFLICT(artifact_id,holder) DO UPDATE SET created_at=excluded.created_at,released_at=NULL`)
        .run(artifactId, holder, input.reason, now);
      this.context.database.prepare("INSERT INTO harness_artifact_pin_events(artifact_id,holder,event,reason,created_at) VALUES (?,?,'pin',?,?)")
        .run(artifactId, holder, input.reason, now);
    });
  }

  releaseHarnessArtifactPin(input: { readonly artifactId: string; readonly holder: string; readonly now: string }): void {
    const artifactId = harnessReliabilityIdentity(input.artifactId);
    const holder = harnessReliabilityIdentity(input.holder);
    const now = harnessReliabilityTime(input.now);
    this.transaction(() => {
      const existing = this.context.database.prepare("SELECT reason,released_at FROM harness_artifact_pins WHERE artifact_id=? AND holder=?").get(artifactId, holder);
      if (!existing) throw new HarnessReliabilityError("artifact.pin_missing");
      if (existing.released_at !== null) return;
      this.context.database.prepare("UPDATE harness_artifact_pins SET released_at=? WHERE artifact_id=? AND holder=?").run(now, artifactId, holder);
      this.context.database.prepare("INSERT INTO harness_artifact_pin_events(artifact_id,holder,event,reason,created_at) VALUES (?,?,'release',?,?)")
        .run(artifactId, holder, existing.reason!, now);
    });
  }

  getHarnessArtifactRetention(artifactId: string): HarnessArtifactRetention | undefined {
    harnessReliabilityIdentity(artifactId);
    const row = this.context.database.prepare("SELECT * FROM harness_artifact_retention WHERE artifact_id=?").get(artifactId);
    return row ? mapRetention(row) : undefined;
  }

  collectHarnessArtifactBodies(input: { readonly now: string; readonly limit?: number; readonly after?: string }): {
    readonly examined: number; readonly prunedArtifactIds: readonly string[]; readonly nextCursor?: string;
  } {
    const now = harnessReliabilityTime(input.now);
    const limit = harnessReliabilityLimit(input.limit);
    const after = input.after === undefined ? undefined : harnessReliabilityIdentity(input.after);
    return this.transaction(() => {
      const statement = this.context.database.prepare(`SELECT artifact_id FROM harness_artifact_retention
        WHERE pruned_at IS NULL AND retain_until<=? ${after === undefined ? "" : "AND artifact_id COLLATE BINARY>?"}
        ORDER BY artifact_id COLLATE BINARY LIMIT ?`);
      const rows = after === undefined ? statement.all(now, limit + 1) : statement.all(now, after, limit + 1);
      const examined = rows.slice(0, limit);
      const references = this.foreignArtifactReferences();
      const prunedArtifactIds: string[] = [];
      for (const row of examined) {
        const artifactId = harnessReliabilityIdentity(row.artifact_id);
        if (this.context.database.prepare("SELECT 1 FROM harness_artifact_pins WHERE artifact_id=? AND released_at IS NULL LIMIT 1").get(artifactId)) continue;
        // All FK references, not just known active states, are durable protection. This intentionally
        // retains extra evidence and automatically protects new delegation/evaluation authority tables.
        if (references.some(reference => this.context.database.prepare(`SELECT 1 FROM ${quote(reference.table)}
          WHERE ${quote(reference.column)}=? LIMIT 1`).get(artifactId))) continue;
        const body = this.readRetainedBody(artifactId);
        const retention = this.getHarnessArtifactRetention(artifactId)!;
        if (retention.contentSha256 !== body.contentSha256) throw new HarnessReliabilityError("artifact.retention_digest_changed");
        this.context.database.prepare(`INSERT INTO harness_artifact_gc_receipts(artifact_id,content_sha256,body_bytes,pruned_at)
          VALUES (?,?,?,?)`).run(artifactId, body.contentSha256, body.bytes, now);
        const update = this.context.database.prepare("UPDATE artifacts SET sealed_payload_json=NULL WHERE id=? AND content_sha256=?")
          .run(artifactId, body.contentSha256);
        if (Number(update.changes) !== 1) throw new HarnessReliabilityError("artifact.gc_source_changed");
        this.context.database.prepare("UPDATE harness_artifact_retention SET pruned_at=? WHERE artifact_id=? AND pruned_at IS NULL").run(now, artifactId);
        prunedArtifactIds.push(artifactId);
      }
      const last = examined.at(-1);
      return { examined: examined.length, prunedArtifactIds,
        ...(rows.length > limit && last ? { nextCursor: harnessReliabilityIdentity(last.artifact_id) } : {}) };
    });
  }

  private foreignArtifactReferences(): readonly { readonly table: string; readonly column: string }[] {
    const references: { table: string; column: string }[] = [];
    for (const row of this.context.database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
      const table = String(row.name);
      if (ownTables.has(table)) continue;
      for (const reference of this.context.database.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all()) {
        if (reference.table === "artifacts") references.push({ table, column: String(reference.from) });
      }
    }
    return references;
  }

  private readRetainedBody(artifactId: string): { readonly contentSha256: string; readonly bytes: number } {
    const metadata = this.context.database.prepare(`SELECT content_sha256,length(CAST(sealed_payload_json AS BLOB)) AS bytes
      FROM artifacts WHERE id=?`).get(artifactId);
    if (!metadata || metadata.bytes === null) throw new HarnessReliabilityError("artifact.body_unavailable");
    if (typeof metadata.bytes !== "number" || metadata.bytes < 0 || metadata.bytes > MAX_BODY_BYTES) {
      throw new HarnessReliabilityError("artifact.body_budget_exceeded");
    }
    const body = this.context.database.prepare("SELECT sealed_payload_json FROM artifacts WHERE id=?").get(artifactId)?.sealed_payload_json;
    if (typeof body !== "string" || typeof metadata.content_sha256 !== "string"
      || createHash("sha256").update(body, "utf8").digest("hex") !== metadata.content_sha256) {
      throw new HarnessReliabilityError("artifact.body_digest_mismatch");
    }
    return { contentSha256: metadata.content_sha256, bytes: metadata.bytes };
  }

  private transaction<T>(write: () => T): T {
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const result = write();
      this.context.database.exec("COMMIT");
      return result;
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      throw error;
    }
  }
}

function mapRetention(row: Record<string, SQLOutputValue>): HarnessArtifactRetention {
  if (typeof row.content_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.content_sha256)) {
    throw new HarnessReliabilityError("artifact.retention_invalid");
  }
  return {
    artifactId: harnessReliabilityIdentity(row.artifact_id), contentSha256: row.content_sha256,
    retainUntil: harnessReliabilityTime(row.retain_until), enrolledAt: harnessReliabilityTime(row.enrolled_at),
    ...(row.pruned_at == null ? {} : { prunedAt: harnessReliabilityTime(row.pruned_at) }),
  };
}
function quote(value: string): string { return `"${value.replace(/"/g, '""')}"`; }
