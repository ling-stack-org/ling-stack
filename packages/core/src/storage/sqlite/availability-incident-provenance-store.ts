import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import type { AvailabilityIncident } from "../../channel-team-types.js";
import type {
  AvailabilityIncidentCandidate,
  AvailabilityIncidentCandidateCursor,
  AvailabilityIncidentCandidatePage,
  ListAvailabilityIncidentCandidatesOptions,
  ProviderRuntimeAvailabilityIncidentSource,
} from "../../provider-runtime-availability-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { readAvailabilityIncidentRuntimeSource } from "./availability-incident-source.js";
import type { SqliteStoreContext } from "./store-context.js";

interface CursorState {
  readonly now: string;
  readonly agentId?: string;
  readonly providerPresetId?: string;
  readonly highWater: number;
  readonly observedAt: string;
  readonly rowId: number;
}

/** Private publication/projection support, not a second incident store or public history API. */
export class SqliteAvailabilityIncidentProvenanceStore {
  private readonly cursors = new WeakMap<AvailabilityIncidentCandidateCursor, CursorState>();

  constructor(private readonly context: SqliteStoreContext) {}

  /** An owned savepoint keeps both writes atomic without committing or rolling back the caller's transaction. */
  publish(
    incident: AvailabilityIncident,
    provenance: "generic" | "provider_runtime",
    source: ProviderRuntimeAvailabilityIncidentSource | undefined,
    insertIncident: () => void,
  ): void {
    const savepoint = `availability_incident_${randomUUID().replaceAll("-", "")}`;
    const { database } = this.context;
    database.exec(`SAVEPOINT ${savepoint}`);
    try {
      insertIncident();
      database.prepare(`INSERT INTO channel_team_incident_provenance(incident_id,workspace_id,provenance,source_json)
        VALUES(?,?,?,?)`).run(incident.id, DEFAULT_WORKSPACE_ID, provenance, source === undefined ? null : JSON.stringify(source));
      database.exec(`RELEASE ${savepoint}`);
    } catch (error) {
      database.exec(`ROLLBACK TO ${savepoint}`);
      database.exec(`RELEASE ${savepoint}`);
      throw error;
    }
  }

  /** Keyset scanning has a bounded page, not a bounded total; the Host filters before accepting its requested limit. */
  listCandidates(
    options: ListAvailabilityIncidentCandidatesOptions,
    mapIncident: (row: Record<string, SQLOutputValue>) => AvailabilityIncident,
  ): AvailabilityIncidentCandidatePage {
    validateOptions(options);
    const cursor = options.cursor === undefined ? undefined : this.cursors.get(options.cursor);
    if (options.cursor !== undefined && (!cursor || cursor.now !== options.now || cursor.agentId !== options.agentId
      || cursor.providerPresetId !== options.providerPresetId)) throw invalidCursor();
    const { database } = this.context;
    const highWaterStatement = database.prepare("SELECT COALESCE(MAX(rowid),0) AS high_water FROM channel_team_incidents");
    highWaterStatement.setReadBigInts(true);
    const highWater = cursor?.highWater ?? safeRowId(highWaterStatement.get()?.high_water);
    const clauses = ["i.workspace_id = ?", "i.incident_type = 'availability'", "i.rowid <= ?", "(i.expires_at IS NULL OR i.expires_at > ?)"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, highWater, options.now];
    if (options.agentId !== undefined) { clauses.push("i.agent_id = ?"); params.push(options.agentId); }
    if (options.providerPresetId !== undefined) { clauses.push("i.provider_preset_id = ?"); params.push(options.providerPresetId); }
    if (cursor) {
      clauses.push("(i.observed_at < ? OR (i.observed_at = ? AND i.rowid < ?))");
      params.push(cursor.observedAt, cursor.observedAt, cursor.rowId);
    }
    const pageSize = Math.min(options.pageSize ?? 100, 500);
    params.push(pageSize + 1);
    const pageStatement = database.prepare(`SELECT i.*, i.rowid AS candidate_row_id,
        p.provenance AS candidate_provenance, p.source_json AS candidate_source_json
      FROM channel_team_incidents AS i LEFT JOIN channel_team_incident_provenance AS p
        ON p.incident_id = i.id AND p.workspace_id = i.workspace_id
      WHERE ${clauses.join(" AND ")} ORDER BY i.observed_at DESC, i.rowid DESC LIMIT ?`);
    pageStatement.setReadBigInts(true);
    const rows = pageStatement.all(...params);
    const selected = rows.slice(0, pageSize);
    const candidates = selected.map(row => mapCandidate(row, mapIncident(row)));
    if (rows.length <= pageSize) return { candidates };
    const last = selected.at(-1)!;
    const nextCursor = Object.freeze({}) as AvailabilityIncidentCandidateCursor;
    this.cursors.set(nextCursor, Object.freeze({ now: options.now, agentId: options.agentId,
      providerPresetId: options.providerPresetId, highWater, observedAt: String(last.observed_at), rowId: safeRowId(last.candidate_row_id) }));
    return { candidates, nextCursor };
  }
}

function mapCandidate(row: Record<string, SQLOutputValue>, incident: AvailabilityIncident): AvailabilityIncidentCandidate {
  if (row.candidate_provenance === "generic" && row.candidate_source_json === null) return { incident, provenance: "generic" };
  if (row.candidate_provenance === "provider_runtime" && typeof row.candidate_source_json === "string") {
    try {
      const source = readAvailabilityIncidentRuntimeSource(JSON.parse(row.candidate_source_json) as unknown, incident);
      return { incident, provenance: "provider_runtime", source };
    } catch { /* Missing/corrupt authority is unknown; never downgrade it to generic. */ }
  }
  return { incident, provenance: "legacy_unclassified" };
}

function validateOptions(options: ListAvailabilityIncidentCandidatesOptions): void {
  if (!options || typeof options.now !== "string" || !Number.isFinite(Date.parse(options.now))
    || new Date(options.now).toISOString() !== options.now
    || [options.agentId, options.providerPresetId].some(value => value !== undefined && (typeof value !== "string" || value.trim().length === 0))
    || (options.pageSize !== undefined && (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1))) throw invalidCursor();
}

function safeRowId(value: SQLOutputValue | undefined): number {
  if (typeof value !== "bigint" || value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidCursor();
  return Number(value);
}

function invalidCursor(): Error & { readonly code: string } {
  return Object.assign(new Error("Invalid availability incident candidate cursor."), { code: "availability_incident_cursor_invalid" });
}
