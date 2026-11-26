import { createHash, randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import type {
  LingAppServerGitHubDelivery,
  LingAppServerRecoveryJournalEntry,
  LingAppServerRecoveryResult,
} from "@ling-stack/contracts";
import type { RunStore } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../config.js";
import { HttpError } from "../errors.js";

type RecoveryConfig = Pick<ResolvedDaemonConfig, "appServerRecoveryDirectory">;
type JournalFact =
  | { readonly kind: "grant_revocation"; readonly id: string }
  | { readonly kind: "external_agent_dispatch"; readonly id: string; readonly workItemId: string; readonly taskId: string; readonly submissionId: string }
  | { readonly kind: "github_queue_enqueue"; readonly id: string; readonly workItemId: string; readonly repositoryId: string;
      readonly pullRequestNumber: number; readonly headSha: string; readonly repository: string; readonly baseRef: string;
      readonly deliveryId: string; readonly acceptanceId: string; readonly fingerprint: string; readonly idempotencyKey: string;
      readonly createdAt: string; readonly attemptId?: string; readonly rejectedHttpStatus?: 401 | 429 }
  | { readonly kind: "github_delivery"; readonly id: string; readonly workItemId: string; readonly mergedCommit: string;
      readonly repositoryId: string; readonly number: number; readonly headSha?: string; readonly acceptanceId: string };

type DeliveryFact = Extract<JournalFact, { kind: "github_delivery" }>;
type DispatchFact = Extract<JournalFact, { kind: "external_agent_dispatch" }>;
type QueueFact = Extract<JournalFact, { kind: "github_queue_enqueue" }>;

interface QueueRecoveryEntry {
  readonly fact: QueueFact;
  readonly confirmed: boolean;
}

interface RecoveryEpoch {
  readonly revision: number;
  readonly epoch?: string;
  readonly preparingStore?: string;
  readonly preparedAt?: string;
  readonly reconciledAt?: string;
}

const journals = new WeakMap<RunStore, AppServerRecoveryJournal>();

export function appServerRecoveryFor(config: RecoveryConfig, store: RunStore): AppServerRecoveryJournal | undefined {
  if (!config.appServerRecoveryDirectory) return undefined;
  const retained = journals.get(store);
  if (retained) return retained;
  const cwd = realpathSync(store.paths.cwd);
  const directory = resolve(config.appServerRecoveryDirectory);
  assertExternalDirectory(cwd, store.paths.rootDir, directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(directory);
  assertExternalDirectory(cwd, realpathSync(store.paths.rootDir), canonical);
  if (!lstatSync(canonical).isDirectory() || !hasPrivateMode(canonical)) {
    throw new Error("The App Server recovery directory must be private Host storage.");
  }
  const name = `workspace-${createHash("sha256").update(cwd).digest("hex")}.sqlite`;
  const journal = new AppServerRecoveryJournal(cwd, resolve(canonical, name));
  journals.set(store, journal);
  return journal;
}

function assertExternalDirectory(cwd: string, stateRoot: string, directory: string): void {
  for (const root of [cwd, stateRoot]) {
    const path = relative(root, directory);
    if (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)) {
      throw new Error("The App Server recovery directory must be outside the workspace and its restored state.");
    }
  }
}

function hasPrivateMode(path: string): boolean {
  return process.platform === "win32" || (lstatSync(path).mode & 0o077) === 0;
}

export class AppServerRecoveryJournal {
  private readonly storeInstanceId = randomUUID();
  private initialized = false;

  constructor(private readonly cwd: string, private readonly path: string) {}

  read(): LingAppServerRecoveryResult {
    return this.access(db => this.snapshot(db, readEpoch(db)));
  }

  epoch(): string | undefined {
    return this.access(db => readEpoch(db).epoch);
  }

  assertReady(): void {
    if (this.blocksDispatch()) throw recoveryBlocked();
  }

  blocksDispatch(): boolean {
    return this.access(db => requiresReconciliation(readEpoch(db)));
  }

  grantIssuanceEpoch(): string | undefined {
    return this.access(db => {
      const current = readEpoch(db);
      assertReady(current);
      return current.epoch;
    });
  }

  prepare(expectedRevision: number, key: string): LingAppServerRecoveryResult {
    return this.transaction(db => {
      const current = readEpoch(db);
      const prior = db.prepare("SELECT revision FROM recovery_epochs WHERE request_key=?").get(key);
      if (prior) {
        if (prior.revision !== expectedRevision + 1 || prior.revision !== current.revision) {
          throw new HttpError(409, "idempotency_conflict", "The recovery key belongs to a different epoch.");
        }
        return this.snapshot(db, current);
      }
      assertRevision(current, expectedRevision);
      assertReady(current);
      db.prepare("INSERT INTO recovery_epochs (revision, request_key, epoch, prepared_at, preparing_store) VALUES (?, ?, ?, ?, ?)")
        .run(current.revision + 1, key, randomUUID(), now(), this.storeInstanceId);
      return this.snapshot(db, readEpoch(db));
    });
  }

  reconcile(expectedRevision: number, confirmed: (fact: DeliveryFact | DispatchFact | QueueFact) => boolean): LingAppServerRecoveryResult {
    return this.transaction(db => {
      const current = readEpoch(db);
      assertRevision(current, expectedRevision);
      if (!requiresReconciliation(current)) return this.snapshot(db, current);
      if (current.preparingStore === this.storeInstanceId) {
        throw new HttpError(409, "resume_blocked", "Restart the Host with the selected workspace snapshot before reconciliation.");
      }
      const pending = db.prepare(`SELECT kind, id, fact_json, completed_at FROM recovery_journal
        WHERE kind != 'grant_revocation' AND reconciled_revision < ? ORDER BY kind, id`).all(current.revision);
      const accept = db.prepare("UPDATE recovery_journal SET reconciled_revision=? WHERE kind=? AND id=?");
      for (const row of pending) {
        const fact = readFact(row);
        if (fact.kind !== "grant_revocation" && (row.completed_at
          || (fact.kind === "github_queue_enqueue" && fact.rejectedHttpStatus !== undefined) || confirmed(fact))) {
          accept.run(current.revision, fact.kind, fact.id);
        }
      }
      if (!pendingCount(db, current.revision)) {
        db.prepare("UPDATE recovery_epochs SET reconciled_at=? WHERE revision=?").run(now(), current.revision);
      }
      return this.snapshot(db, readEpoch(db));
    });
  }

  allowsGrant(grantId: string, issuedEpoch: string | undefined): boolean {
    return this.access(db => {
      const current = readEpoch(db);
      return !requiresReconciliation(current) && issuedEpoch === current.epoch
        && !db.prepare("SELECT 1 FROM recovery_journal WHERE kind='grant_revocation' AND id=?").get(grantId);
    });
  }

  recordGrantRevocation(grantId: string, revokedAt: string): string {
    return this.transaction(db => {
      insertFact(db, { kind: "grant_revocation", id: grantId }, revokedAt);
      return String(db.prepare("SELECT recorded_at FROM recovery_journal WHERE kind='grant_revocation' AND id=?").get(grantId)?.recorded_at);
    });
  }

  recordGitHubDelivery(delivery: LingAppServerGitHubDelivery): void {
    if (delivery.status !== "delivered" || !delivery.mergedCommit) return;
    const fact: DeliveryFact = {
      kind: "github_delivery", id: delivery.deliveryId, workItemId: delivery.workItemId,
      mergedCommit: delivery.mergedCommit, repositoryId: delivery.subject.repositoryId, number: delivery.subject.number,
      headSha: delivery.subject.headSha, acceptanceId: delivery.acceptanceId,
    };
    this.transaction(db => { insertFact(db, fact, delivery.observedAt); });
  }

  reserveExternalDispatch(fact: Omit<DispatchFact, "kind">): boolean {
    return this.transaction(db => {
      assertReady(readEpoch(db));
      return insertFact(db, { kind: "external_agent_dispatch", ...fact }, now());
    });
  }

  hasExternalDispatch(id: string): boolean {
    return this.access(db => Boolean(db.prepare("SELECT 1 FROM recovery_journal WHERE kind='external_agent_dispatch' AND id=?").get(id)));
  }

  confirmExternalDispatch(id: string): void {
    this.access(db => {
      const result = db.prepare(`UPDATE recovery_journal SET completed_at=COALESCE(completed_at, ?)
        WHERE kind='external_agent_dispatch' AND id=?`).run(now(), id);
      if (result.changes !== 1) throw new Error("The external dispatch has no recovery journal entry.");
    });
  }

  reserveGitHubQueueEnqueue(
    fact: Omit<QueueFact, "kind" | "attemptId" | "rejectedHttpStatus">, retryAfter?: string,
  ): string | undefined {
    return this.transaction(db => {
      assertReady(readEpoch(db));
      const attemptId = randomUUID();
      if (retryAfter === undefined) {
        return insertFact(db, { kind: "github_queue_enqueue", ...fact, attemptId }, now()) ? attemptId : undefined;
      }
      const reserved = db.prepare(`UPDATE recovery_journal
        SET fact_json=json_set(json_remove(fact_json, '$.rejectedHttpStatus'), '$.attemptId', ?)
        WHERE kind='github_queue_enqueue' AND id=? AND completed_at IS NULL
          AND json_extract(fact_json, '$.fingerprint')=? AND json_extract(fact_json, '$.attemptId')=?
          AND json_extract(fact_json, '$.rejectedHttpStatus') IN (401, 429)`)
        .run(attemptId, fact.id, fact.fingerprint, retryAfter);
      return reserved.changes === 1 ? attemptId : undefined;
    });
  }

  getGitHubQueueEnqueue(id: string): QueueRecoveryEntry | undefined {
    return this.access(db => readQueueEntry(db.prepare(`SELECT id, kind, fact_json, completed_at FROM recovery_journal
      WHERE kind='github_queue_enqueue' AND id=?`).get(id)));
  }

  findGitHubQueueEnqueue(idempotencyKey: string): QueueRecoveryEntry | undefined {
    return this.access(db => readQueueEntry(db.prepare(`SELECT id, kind, fact_json, completed_at FROM recovery_journal
      WHERE kind='github_queue_enqueue' AND json_extract(fact_json, '$.idempotencyKey')=?`).get(idempotencyKey)));
  }

  rejectGitHubQueueEnqueue(id: string, attemptId: string, httpStatus: 401 | 429): void {
    this.access(db => {
      db.prepare(`UPDATE recovery_journal SET fact_json=json_set(fact_json, '$.rejectedHttpStatus', ?)
        WHERE kind='github_queue_enqueue' AND id=? AND completed_at IS NULL AND json_extract(fact_json, '$.attemptId')=?`)
        .run(httpStatus, id, attemptId);
    });
  }

  confirmGitHubQueueEnqueue(id: string): void {
    this.access(db => {
      const result = db.prepare(`UPDATE recovery_journal SET completed_at=COALESCE(completed_at, ?)
        WHERE kind='github_queue_enqueue' AND id=?`).run(now(), id);
      if (result.changes !== 1) throw new Error("The GitHub queue intent has no recovery journal entry.");
    });
  }

  private snapshot(db: DatabaseSync, epoch: RecoveryEpoch): LingAppServerRecoveryResult {
    const blocked = requiresReconciliation(epoch);
    const entries = db.prepare(`SELECT kind, id, fact_json, recorded_at, reconciled_revision, completed_at FROM recovery_journal
      ORDER BY CASE WHEN kind != 'grant_revocation' AND reconciled_revision < ? THEN 0 ELSE 1 END,
        recorded_at DESC, kind ASC, id ASC LIMIT 100`).all(blocked ? epoch.revision : 0);
    return {
      cwd: this.cwd,
      revision: epoch.revision,
      status: blocked ? "reconciliation_required" : "ready",
      ...(epoch.preparedAt ? { preparedAt: epoch.preparedAt } : {}),
      ...(epoch.reconciledAt ? { reconciledAt: epoch.reconciledAt } : {}),
      pendingCount: blocked ? pendingCount(db, epoch.revision) : 0,
      entries: entries.map(row => {
        const fact = readFact(row);
        const shared = { id: fact.id, recordedAt: String(row.recorded_at), pending: blocked && fact.kind !== "grant_revocation"
          && Number(row.reconciled_revision) < epoch.revision };
        if (fact.kind === "github_delivery") {
          return { ...shared, kind: fact.kind, workItemId: fact.workItemId, mergedCommit: fact.mergedCommit };
        }
        if (fact.kind === "github_queue_enqueue") {
          return { ...shared, kind: fact.kind, workItemId: fact.workItemId, repositoryId: fact.repositoryId,
            pullRequestNumber: fact.pullRequestNumber, headSha: fact.headSha,
            ...(typeof row.completed_at === "string" ? { completedAt: row.completed_at } : {}) };
        }
        return fact.kind === "external_agent_dispatch" ? {
          ...shared, kind: fact.kind, workItemId: fact.workItemId, taskId: fact.taskId,
          ...(typeof row.completed_at === "string" ? { completedAt: row.completed_at } : {}),
        } : { ...shared, kind: fact.kind } satisfies LingAppServerRecoveryJournalEntry;
      }),
    };
  }

  private access<T>(operation: (db: DatabaseSync) => T): T {
    if (!this.initialized) {
      try { closeSync(openSync(this.path, "wx", 0o600)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const file = lstatSync(this.path);
    if (!file.isFile() || file.nlink !== 1 || !hasPrivateMode(this.path)) throw new Error("Invalid App Server recovery database.");
    const db = new DatabaseSync(this.path);
    try {
      db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
      if (!this.initialized) db.exec(`
        CREATE TABLE IF NOT EXISTS recovery_epochs (
          revision INTEGER PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, epoch TEXT NOT NULL,
          prepared_at TEXT NOT NULL, preparing_store TEXT NOT NULL, reconciled_at TEXT
        ) STRICT;
        CREATE TABLE IF NOT EXISTS recovery_journal (
          kind TEXT NOT NULL, id TEXT NOT NULL, fact_json TEXT NOT NULL,
          recorded_at TEXT NOT NULL, reconciled_revision INTEGER NOT NULL DEFAULT 0, completed_at TEXT,
          PRIMARY KEY (kind, id)
        ) STRICT;`);
      this.initialized = true;
      return operation(db);
    } finally {
      db.close();
    }
  }

  private transaction<T>(operation: (db: DatabaseSync) => T): T {
    return this.access(db => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = operation(db);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }
}

function readEpoch(db: DatabaseSync): RecoveryEpoch {
  const row = db.prepare("SELECT revision, epoch, prepared_at, preparing_store, reconciled_at FROM recovery_epochs ORDER BY revision DESC LIMIT 1").get();
  return row ? { revision: Number(row.revision), epoch: String(row.epoch), preparedAt: String(row.prepared_at), preparingStore: String(row.preparing_store),
    reconciledAt: typeof row.reconciled_at === "string" ? row.reconciled_at : undefined } : { revision: 0 };
}

function pendingCount(db: DatabaseSync, revision: number): number {
  return Number(db.prepare(`SELECT COUNT(*) AS pending FROM recovery_journal
    WHERE kind != 'grant_revocation' AND reconciled_revision < ?`).get(revision)?.pending);
}

function insertFact(db: DatabaseSync, fact: JournalFact, recordedAt: string): boolean {
  return db.prepare(`INSERT INTO recovery_journal (kind, id, fact_json, recorded_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (kind, id) DO NOTHING`).run(fact.kind, fact.id, JSON.stringify(fact), recordedAt).changes === 1;
}

function readFact(row: Record<string, SQLOutputValue>): JournalFact {
  const fact = JSON.parse(String(row.fact_json)) as JournalFact;
  if (fact.id !== row.id || fact.kind !== row.kind || !["github_delivery", "github_queue_enqueue", "external_agent_dispatch", "grant_revocation"].includes(fact.kind)) {
    throw new Error("App Server recovery journal is corrupt.");
  }
  return fact;
}

function readQueueEntry(row: Record<string, SQLOutputValue> | undefined): QueueRecoveryEntry | undefined {
  const fact = row && readFact(row);
  return fact?.kind === "github_queue_enqueue" ? { fact, confirmed: typeof row?.completed_at === "string" } : undefined;
}

function requiresReconciliation(epoch: RecoveryEpoch): boolean {
  return Boolean(epoch.preparedAt && !epoch.reconciledAt);
}

function assertReady(epoch: RecoveryEpoch): void {
  if (requiresReconciliation(epoch)) throw recoveryBlocked();
}

export function recoveryBlocked(): HttpError {
  return new HttpError(409, "resume_blocked", "App Server recovery reconciliation is required before new dispatch.");
}

function assertRevision(epoch: RecoveryEpoch, expected: number): void {
  if (epoch.revision !== expected) throw new HttpError(409, "stale_revision", "The App Server recovery epoch changed.");
}

function now(): string {
  return new Date().toISOString();
}
