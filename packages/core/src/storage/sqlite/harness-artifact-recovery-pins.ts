import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { HarnessReliabilityError } from "../../harness/reliability.js";
import { harnessReliabilityIdentity, harnessReliabilityTime } from "./harness-reliability-schema.js";

type PinReason = "recovery" | "audit_hold";
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** Stable per authority owner, not per lease renewal/revision. No raw private IDs in holders. */
export function harnessArtifactOwnerHolder(kind: string, ownerId: string): string {
  harnessReliabilityIdentity(ownerId);
  return `host:${harnessReliabilityIdentity(kind)}:${createHash("sha256").update(ownerId, "utf8").digest("hex")}`;
}

/** Owner supplies its bounded canonical artifact set. Never scans history or commits its transaction. */
export function syncHarnessArtifactOwnerPins(database: DatabaseSync, input: {
  readonly holder: string; readonly artifactIds: readonly string[]; readonly keep: boolean;
  readonly reason?: PinReason; readonly now: string;
}): void {
  assertOwnerTransaction(database);
  for (const artifactId of new Set(input.artifactIds)) {
    if (input.keep) pinHarnessArtifactWithinTransaction(database, { artifactId, holder: input.holder,
      reason: input.reason ?? "recovery", now: input.now });
    else releaseHarnessArtifactWithinTransaction(database, { artifactId, holder: input.holder, now: input.now });
  }
}

export function pinHarnessArtifactWithinTransaction(database: DatabaseSync, input: {
  readonly artifactId: string; readonly holder: string; readonly reason: PinReason; readonly now: string;
}): void {
  assertOwnerTransaction(database);
  const artifactId = harnessReliabilityIdentity(input.artifactId), holder = harnessReliabilityIdentity(input.holder);
  const now = harnessReliabilityTime(input.now);
  if (input.reason !== "recovery" && input.reason !== "audit_hold") throw new TypeError("artifact_pin_reason_invalid");
  readHarnessRetainedBody(database, artifactId);
  const existing = database.prepare("SELECT reason,released_at FROM harness_artifact_pins WHERE artifact_id=? AND holder=?").get(artifactId, holder);
  if (existing && existing.reason !== input.reason) throw new HarnessReliabilityError("artifact.pin_holder_conflict");
  if (existing?.released_at === null) return;
  database.prepare(`INSERT INTO harness_artifact_pins(artifact_id,holder,reason,created_at)
    VALUES (?,?,?,?) ON CONFLICT(artifact_id,holder) DO UPDATE SET created_at=excluded.created_at,released_at=NULL`)
    .run(artifactId, holder, input.reason, now);
  database.prepare("INSERT INTO harness_artifact_pin_events(artifact_id,holder,event,reason,created_at) VALUES (?,?,'pin',?,?)")
    .run(artifactId, holder, input.reason, now);
}

export function releaseHarnessArtifactWithinTransaction(database: DatabaseSync, input: {
  readonly artifactId: string; readonly holder: string; readonly now: string;
}, strict = false): void {
  assertOwnerTransaction(database);
  const artifactId = harnessReliabilityIdentity(input.artifactId), holder = harnessReliabilityIdentity(input.holder);
  const now = harnessReliabilityTime(input.now);
  const existing = database.prepare("SELECT reason,released_at FROM harness_artifact_pins WHERE artifact_id=? AND holder=?").get(artifactId, holder);
  if (!existing) {
    if (strict) throw new HarnessReliabilityError("artifact.pin_missing");
    // Legacy owner had no pin: do not invent a release event or reseed history.
    return;
  }
  if (existing.released_at !== null) return;
  database.prepare("UPDATE harness_artifact_pins SET released_at=? WHERE artifact_id=? AND holder=?").run(now, artifactId, holder);
  database.prepare("INSERT INTO harness_artifact_pin_events(artifact_id,holder,event,reason,created_at) VALUES (?,?,'release',?,?)")
    .run(artifactId, holder, existing.reason!, now);
}

export function readHarnessRetainedBody(database: DatabaseSync, artifactId: string): { readonly contentSha256: string; readonly bytes: number } {
  const metadata = database.prepare(`SELECT content_sha256,length(CAST(sealed_payload_json AS BLOB)) AS bytes
    FROM artifacts WHERE id=?`).get(artifactId);
  if (!metadata || metadata.bytes === null) throw new HarnessReliabilityError("artifact.body_unavailable");
  if (typeof metadata.bytes !== "number" || metadata.bytes < 0 || metadata.bytes > MAX_BODY_BYTES) {
    throw new HarnessReliabilityError("artifact.body_budget_exceeded");
  }
  const body = database.prepare("SELECT sealed_payload_json FROM artifacts WHERE id=?").get(artifactId)?.sealed_payload_json;
  if (typeof body !== "string" || typeof metadata.content_sha256 !== "string"
    || createHash("sha256").update(body, "utf8").digest("hex") !== metadata.content_sha256) {
    throw new HarnessReliabilityError("artifact.body_digest_mismatch");
  }
  return { contentSha256: metadata.content_sha256, bytes: metadata.bytes };
}

function assertOwnerTransaction(database: DatabaseSync): void {
  if (!database.isTransaction) throw new Error("artifact.pin_requires_owner_transaction");
}
