import { randomUUID } from "node:crypto";
import { automationDefinitionDigestInput, type AutomationEventStore, type AutomationEventPorts, type AutomationEventSource,
  type AutomationEventEnvelope, type AutomationEventDispatch, type AutomationDelivery, type PutAutomationEventSource } from "../../automation-event-types.js";
import { automationEventDigest, automationEventMatches, parseAutomationEventSource } from "../../automation-event-source.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

type Row = Record<string, unknown>;
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const optional = (value: unknown): string | undefined => value === null || value === undefined ? undefined : String(value);
function dispatch(row: Row): AutomationEventDispatch {
  return { id: String(row.id), eventId: String(row.event_id), sourceId: String(row.source_id), sourceRevision: Number(row.source_revision),
    automationId: String(row.automation_id), definitionDigest: String(row.definition_digest), destinationIds: parse(row.destinations_json),
    status: String(row.status) as AutomationEventDispatch["status"], attempts: Number(row.attempts), leaseToken: optional(row.lease_token),
    leaseUntil: optional(row.lease_until), automationRunId: optional(row.automation_run_id), error: optional(row.error) };
}
function delivery(row: Row): AutomationDelivery {
  return { id: String(row.id), dispatchId: String(row.dispatch_id), runId: String(row.run_id), destinationId: String(row.destination_id),
    status: String(row.status) as AutomationDelivery["status"], attempts: Number(row.attempts), availableAt: String(row.available_at),
    leaseToken: optional(row.lease_token), receipt: optional(row.receipt), updatedAt: String(row.updated_at) };
}

/** Inbox claims and delivery receipts share the workspace SQLite transaction boundary. */
export class SqliteAutomationEventStore implements AutomationEventStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: AutomationEventPorts) {}
  private transaction<T>(run: () => T): T {
    const db = this.context.database;
    db.exec("BEGIN IMMEDIATE");
    try { const result = run(); db.exec("COMMIT"); return result; }
    catch (error) { rollbackOwnedSqliteTransaction(db); throw error; }
  }
  putAutomationEventSource(value: PutAutomationEventSource, expectedRevision: number | undefined, now: string): AutomationEventSource {
    const input = parseAutomationEventSource(value);
    return this.transaction(() => {
      const prior = this.getAutomationEventSource(input.id);
      if (prior ? expectedRevision !== prior.revision : expectedRevision !== undefined && expectedRevision !== 0) throw new Error("automation_event_source_revision_conflict");
      if (!prior && this.listAutomationEventSources().length >= 64) throw new Error("automation_event_source_limit");
      for (const rule of input.rules) {
        const definition = this.ports.getAutomationDefinition(rule.automationId);
        if (!definition || definition.automationMode === "heartbeat") throw new Error("automation_event_definition_unavailable");
      }
      const source: AutomationEventSource = { ...input, revision: (prior?.revision ?? 0) + 1, createdAt: prior?.createdAt ?? now, updatedAt: now };
      this.context.database.prepare("INSERT INTO automation_event_sources(id,revision,source_json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,source_json=excluded.source_json")
        .run(source.id, source.revision, JSON.stringify(source));
      return source;
    });
  }
  getAutomationEventSource(id: string): AutomationEventSource | undefined {
    const row = this.context.database.prepare("SELECT source_json FROM automation_event_sources WHERE id=?").get(id);
    return row ? parse(row.source_json) : undefined;
  }
  listAutomationEventSources(): AutomationEventSource[] {
    return this.context.database.prepare("SELECT source_json FROM automation_event_sources ORDER BY id LIMIT 64").all().map(row => parse(row.source_json));
  }
  acceptAutomationEvent(input: Omit<AutomationEventEnvelope, "id" | "receivedAt">, sourceRevision: number, now: string) {
    if (!/^[a-f0-9]{64}$/.test(input.payloadDigest) || input.externalId.length > 160 || !input.externalId
      || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(input.type) || Buffer.byteLength(JSON.stringify(input.payload)) > 64 * 1024
      || !Number.isFinite(Date.parse(input.occurredAt))) throw new Error("automation_event_envelope_invalid");
    return this.transaction(() => {
      const db = this.context.database;
      const source = this.getAutomationEventSource(input.sourceId);
      if (!source?.enabled || source.revision !== sourceRevision) throw new Error("automation_event_source_revoked");
      const prior = db.prepare(`SELECT payload_digest,envelope_json FROM automation_events WHERE source_id=?
        AND (external_id=? OR (?='github' AND payload_digest=?)) LIMIT 1`).get(input.sourceId, input.externalId, source.adapter, input.payloadDigest);
      if (prior) {
        if (prior.payload_digest !== input.payloadDigest) throw new Error("automation_event_digest_conflict");
        return { event: parse<AutomationEventEnvelope>(prior.envelope_json), duplicate: true };
      }
      const minute = new Date(Date.parse(now) - 60_000).toISOString();
      const recent = db.prepare("SELECT COUNT(*) AS count FROM automation_events WHERE source_id=? AND received_at>=?").get(source.id, minute);
      if (Number(recent?.count) >= 100) throw new Error("automation_event_rate_limit");
      const eligibleRules = source.rules.flatMap(rule => {
        if (!rule.types.includes(input.type) || !automationEventMatches(input.payload, rule.predicates)) return [];
        const definition = this.ports.getAutomationDefinition(rule.automationId);
        return !definition || definition.status !== "enabled" || definition.automationMode === "heartbeat"
          ? [] : [{ rule, definition }];
      });
      const pending = db.prepare("SELECT COUNT(*) AS count FROM automation_event_dispatches WHERE status IN ('queued','dispatching')").get();
      if (Number(pending?.count) + eligibleRules.length > 5000) throw new Error("automation_event_inbox_capacity");
      const event: AutomationEventEnvelope = { ...input, id: `ae_${randomUUID()}`, receivedAt: now };
      db.prepare("INSERT INTO automation_events VALUES(?,?,?,?,?,?)").run(event.id, source.id, event.externalId, event.payloadDigest, now, JSON.stringify(event));
      for (const { rule, definition } of eligibleRules) {
        db.prepare(`INSERT INTO automation_event_dispatches(id,event_id,source_id,source_revision,automation_id,definition_digest,destinations_json,status)
          VALUES(?,?,?,?,?,?,?,'queued')`).run(`aed_${randomUUID()}`, event.id, source.id, source.revision, definition.id,
            automationEventDigest(automationDefinitionDigestInput(definition)), JSON.stringify(rule.destinationIds ?? []));
      }
      return { event, duplicate: false };
    });
  }
  listAutomationEvents(limit = 100): AutomationEventEnvelope[] {
    return this.context.database.prepare("SELECT envelope_json FROM automation_events ORDER BY rowid DESC LIMIT ?").all(Math.max(1, Math.min(limit, 100))).map(row => parse(row.envelope_json));
  }
  getAutomationEvent(id: string): AutomationEventEnvelope | undefined {
    const row = this.context.database.prepare("SELECT envelope_json FROM automation_events WHERE id=?").get(id);
    return row ? parse(row.envelope_json) : undefined;
  }
  claimAutomationEventDispatch(now: string): AutomationEventDispatch | undefined {
    return this.transaction(() => {
      const db = this.context.database;
      const row = db.prepare(`SELECT * FROM automation_event_dispatches WHERE status IN ('queued','dispatching')
        AND (lease_until IS NULL OR lease_until<=?) ORDER BY rowid LIMIT 1`).get(now);
      if (!row) return undefined;
      if (Number(row.attempts) >= 100) {
        db.prepare("UPDATE automation_event_dispatches SET status='failed',error='dispatch_retry_limit' WHERE id=?").run(String(row.id)); return undefined;
      }
      const token = randomUUID(), until = new Date(Date.parse(now) + 60_000).toISOString();
      db.prepare("UPDATE automation_event_dispatches SET status='dispatching',attempts=attempts+1,lease_token=?,lease_until=? WHERE id=?").run(token, until, String(row.id));
      return dispatch(db.prepare("SELECT * FROM automation_event_dispatches WHERE id=?").get(String(row.id))!);
    });
  }
  finishAutomationEventDispatch(id: string, token: string, input: { status: "queued" | "linked" | "failed"; automationRunId?: string; error?: string }, now: string): boolean {
    if (input.status === "linked" && !input.automationRunId) throw new Error("automation_event_link_required");
    const until = input.status === "queued" ? new Date(Date.parse(now) + 2000).toISOString() : null;
    return this.context.database.prepare(`UPDATE automation_event_dispatches SET status=?,automation_run_id=?,error=?,lease_token=NULL,lease_until=?
      WHERE id=? AND status='dispatching' AND lease_token=? AND lease_until>?`).run(input.status, input.automationRunId ?? null, input.error?.slice(0, 1000) ?? null, until, id, token, now).changes === 1;
  }
  listAutomationEventDispatches(limit = 100): AutomationEventDispatch[] {
    return this.context.database.prepare("SELECT * FROM automation_event_dispatches ORDER BY rowid DESC LIMIT ?").all(Math.max(1, Math.min(limit, 500))).map(dispatch);
  }
  reconcileAutomationDeliveries(now: string): void {
    this.transaction(() => {
      const db = this.context.database;
      const expired = db.prepare("SELECT * FROM automation_deliveries WHERE status='sending' AND available_at<=? LIMIT 100").all(now);
      for (const row of expired) {
        db.prepare("UPDATE automation_deliveries SET status='unknown',lease_token=NULL,receipt='delivery_interrupted',updated_at=? WHERE id=?").run(now, String(row.id));
        db.prepare("INSERT INTO automation_delivery_receipts(delivery_id,status,reason,created_at) VALUES(?,'unknown','delivery_interrupted',?)").run(String(row.id), now);
      }
      const linked = db.prepare("SELECT * FROM automation_event_dispatches WHERE status='linked' AND delivery_enqueued=0 ORDER BY rowid LIMIT 100").all();
      for (const row of linked) {
        const job = dispatch(row), automationRun = job.automationRunId ? this.ports.getAutomationRun(job.automationRunId) : undefined;
        const run = automationRun?.runId ? this.ports.getRun(automationRun.runId) : undefined;
        if (!run || !["succeeded", "failed", "cancelled"].includes(run.status)) continue;
        for (const target of job.destinationIds) db.prepare(`INSERT OR IGNORE INTO automation_deliveries
          (id,dispatch_id,run_id,destination_id,status,available_at,updated_at) VALUES(?,?,?,?,'queued',?,?)`).run(`ad_${randomUUID()}`, job.id, run.id, target, now, now);
        db.prepare("UPDATE automation_event_dispatches SET delivery_enqueued=1 WHERE id=?").run(job.id);
      }
    });
  }
  getAutomationEventDispatch(id: string): AutomationEventDispatch | undefined {
    const row = this.context.database.prepare("SELECT * FROM automation_event_dispatches WHERE id=?").get(id);
    return row ? dispatch(row) : undefined;
  }
  getAutomationRunResultText(runId: string): string | undefined {
    const rows = this.context.database.prepare("SELECT data_json FROM run_events WHERE run_id=? AND type='message_end' ORDER BY seq DESC LIMIT 20").all(runId);
    for (const row of rows) {
      const data = parse<Record<string, unknown>>(row.data_json);
      if (data.role === "assistant" && typeof data.text === "string" && data.text.trim()) return data.text.slice(0, 8000);
    }
    return undefined;
  }
  claimAutomationDelivery(now: string): AutomationDelivery | undefined {
    return this.transaction(() => {
      const db = this.context.database;
      const row = db.prepare("SELECT * FROM automation_deliveries WHERE status='queued' AND available_at<=? ORDER BY rowid LIMIT 1").get(now);
      if (!row) return undefined;
      const token = randomUUID(), until = new Date(Date.parse(now) + 30_000).toISOString();
      db.prepare("UPDATE automation_deliveries SET status='sending',attempts=attempts+1,lease_token=?,available_at=?,updated_at=? WHERE id=?").run(token, until, now, String(row.id));
      return delivery(db.prepare("SELECT * FROM automation_deliveries WHERE id=?").get(String(row.id))!);
    });
  }
  settleAutomationDelivery(id: string, token: string, input: { status: "queued" | "delivered" | "unknown" | "failed"; receipt: string; availableAt?: string }, now: string): boolean {
    return this.transaction(() => {
      const db = this.context.database;
      const changed = db.prepare(`UPDATE automation_deliveries SET status=?,receipt=?,available_at=?,updated_at=?,lease_token=NULL
        WHERE id=? AND status='sending' AND lease_token=? AND available_at>?`).run(input.status, input.receipt.slice(0, 1000), input.availableAt ?? now, now, id, token, now).changes === 1;
      if (changed) db.prepare("INSERT INTO automation_delivery_receipts(delivery_id,status,reason,created_at) VALUES(?,?,?,?)").run(id, input.status, input.receipt.slice(0, 1000), now);
      return changed;
    });
  }
  reconcileAutomationDelivery(id: string, expectedUpdatedAt: string, decision: "delivered" | "retry" | "failed", reason: string, now: string): AutomationDelivery {
    if (!reason.trim() || reason.length > 1000) throw new Error("automation_delivery_reconciliation_reason_required");
    return this.transaction(() => {
      const db = this.context.database, status = decision === "retry" ? "queued" : decision;
      const changed = db.prepare(`UPDATE automation_deliveries SET status=?,receipt=?,available_at=?,updated_at=?
        WHERE id=? AND status IN ('unknown','failed') AND updated_at=?`).run(status, reason, now, now, id, expectedUpdatedAt).changes;
      if (changed !== 1) throw new Error("automation_delivery_reconciliation_conflict");
      db.prepare("INSERT INTO automation_delivery_receipts(delivery_id,status,reason,created_at) VALUES(?,?,?,?)").run(id, status, `local-user: ${reason}`, now);
      return delivery(db.prepare("SELECT * FROM automation_deliveries WHERE id=?").get(id)!);
    });
  }
  listAutomationDeliveries(limit = 100): AutomationDelivery[] {
    return this.context.database.prepare("SELECT * FROM automation_deliveries ORDER BY rowid DESC LIMIT ?").all(Math.max(1, Math.min(limit, 500))).map(delivery);
  }
}
