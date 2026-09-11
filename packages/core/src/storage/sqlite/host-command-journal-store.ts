import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  isCommandProcessObservation, isHostCommandPreparedV1, isHostCommandSettledV1,
  type HostCommandPreparedV1, type HostCommandSettledV1, type HostCommandWriteBlockerV1,
} from "@ling-stack/contracts";
import type { HostCommandExecutionTicket, HostCommandSettlementInput, PrepareHostCommandExecutionInput } from "../../host-command-journal-types.js";
import { createEventId, type RunEventEnvelope, type RunSession } from "../../run-types.js";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { appendEventLogLine } from "../event-log.js";
import { isCurrentRunExecutionOwner } from "./run-execution-admission.js";
import type { SqliteStoreContext } from "./store-context.js";
import { readSqliteWithinTransaction } from "./read-snapshot.js";

type PreparedEvent = Extract<RunEventEnvelope, { type: "host_command_prepared" }>;
type SettledEvent = Extract<RunEventEnvelope, { type: "host_command_settled" }>;
interface TicketState {
  readonly run: RunSession;
  readonly fence: RuntimeAttemptFenceV1;
  launchClaimed?: boolean;
  settlement?: { readonly signature: string; readonly event: SettledEvent };
}

/**
 * Dedicated Host journal. The transaction owns conflict detection and sequence allocation.
 * Prepared without settlement is deliberately blocking after a crash; event-log copies and
 * model/SDK tool payloads cannot clear it. No expiry or replay-based unlock is supported.
 */
export class SqliteHostCommandJournalStore {
  private readonly tickets = new WeakMap<HostCommandExecutionTicket, TicketState>();
  constructor(private readonly context: SqliteStoreContext, private readonly getRun: (id: string) => RunSession | undefined) {}

  prepareHostCommandExecution(input: PrepareHostCommandExecutionInput): HostCommandExecutionTicket {
    // Materialize caller data before entering the transaction (including possible getters).
    const source = { ...input.sourceFence };
    const runId = input.runId, toolCallId = input.toolCallId, cwd = resolve(input.cwd);
    const commandJson = JSON.stringify(input.command);
    if (!toolCallId || !commandJson || !source.attemptId || !source.runtimeInstanceId || !source.fencingToken || !source.workUnitId) {
      throw failure("invalid_command_preparation");
    }
    const result = this.transaction(() => {
      const run = this.getRun(runId);
      if (!run || !isCurrentRunExecutionOwner(this.context, runId, source, false)) throw failure("stale_run_execution");
      const workspace = workspaceScope(run.cwd, true);
      const commandScope = workspaceScope(cwd, true);
      if (!inside(workspace.path, commandScope.path) || !inside(workspace.realPath, commandScope.realPath)) {
        throw failure("command_cwd_out_of_scope");
      }
      if (this.context.database.prepare(`SELECT 1 FROM run_events WHERE run_id=? AND type='host_command_prepared'
        AND json_extract(data_json, '$.toolCallId')=? AND json_extract(data_json, '$.source.attemptId')=? LIMIT 1`)
        .get(runId, toolCallId, source.attemptId)) throw failure("command_call_already_prepared");
      if (this.listHostCommandWriteBlockers(run.cwd).length > 0) throw failure("command_workspace_busy");
      const data: HostCommandPreparedV1 = { executionId: "host_command_" + randomUUID(), toolCallId, source, workspace,
        cwd: commandScope.realPath, commandDigest: createHash("sha256").update(commandJson).digest("hex") };
      return { run, event: this.insert(runId, "host_command_prepared", data) as PreparedEvent };
    });
    // SQLite is authoritative. Log I/O failure leaves a blocking prepared row and no spawn ticket.
    appendEventLogLine(result.run.eventLogPath, result.event);
    const ticket = Object.freeze({ executionId: result.event.data.executionId }) as HostCommandExecutionTicket;
    this.tickets.set(ticket, { run: result.run, fence: Object.freeze(source) });
    return ticket;
  }

  settleHostCommandExecution(ticket: HostCommandExecutionTicket, input: HostCommandSettlementInput): SettledEvent {
    const state = this.tickets.get(ticket);
    if (!state) throw failure("invalid_command_ticket");
    const kind = input.kind;
    const observation = kind === "observed" ? structuredClone(input.observation) : undefined;
    if (kind !== "not_started" && (kind !== "observed" || !isCommandProcessObservation(observation))) {
      throw failure("invalid_command_observation");
    }
    const signature = JSON.stringify({ kind, observation });
    if (state.settlement) {
      if (state.settlement.signature !== signature) throw failure("command_settlement_conflict");
      return state.settlement.event;
    }
    const event = this.transaction(() => {
      const ownerCurrent = isCurrentRunExecutionOwner(this.context, state.run.id, state.fence, false);
      // A late old owner can add diagnostic evidence, but never give a successor permission to write.
      const normalClose = observation?.settledBy === "close" && observation.leaderExited && observation.stdioClosed
        && !observation.stopReason && observation.signalFailures.length === 0;
      const outcome = !ownerCurrent ? "stop_unconfirmed" : kind === "not_started" ? "not_started"
        : normalClose ? "completed" : "stop_unconfirmed";
      if (this.context.database.prepare(`SELECT 1 FROM run_events WHERE type='host_command_settled'
        AND json_extract(data_json, '$.executionId')=? LIMIT 1`).get(ticket.executionId)) throw failure("command_settlement_conflict");
      return this.insert(state.run.id, "host_command_settled", {
        executionId: ticket.executionId, outcome, ownerCurrent, ...(observation ? { observation } : {}),
      }) as SettledEvent;
    });
    state.settlement = { signature, event };
    appendEventLogLine(state.run.eventLogPath, event);
    return event;
  }

  /**
   * Recheck the source under the same write lock as the synchronous OS spawn.
   * Preparation has already committed, so a crash/commit error after spawn stays blocking.
   * The caller must retain any created process even if this method throws on commit.
   */
  launchHostCommandExecution<T>(ticket: HostCommandExecutionTicket, launch: () => T): T {
    const state = this.tickets.get(ticket);
    if (!state) throw failure("invalid_command_ticket");
    if (state.launchClaimed || state.settlement) throw failure("command_launch_already_claimed");
    if (Object.prototype.toString.call(launch) === "[object AsyncFunction]") throw failure("command_launcher_must_be_synchronous");
    return this.transaction(() => {
      if (!isCurrentRunExecutionOwner(this.context, state.run.id, state.fence, false)
        || this.getRun(state.run.id)?.cwd !== state.run.cwd) throw failure("stale_run_execution");
      state.launchClaimed = true;
      // The source check and OS spawn share this write lock. Nested evidence
      // projections may read it, but may not write or begin/commit another view.
      const result = readSqliteWithinTransaction(this.context.database, launch);
      if (result && (typeof result === "object" || typeof result === "function") && typeof Reflect.get(result, "then") === "function") {
        throw failure("command_launcher_must_be_synchronous");
      }
      return result;
    });
  }

  listHostCommandWriteBlockers(cwd: string): HostCommandWriteBlockerV1[] {
    const rows = this.context.database.prepare(`SELECT p.run_id, p.data_json, s.data_json AS settlement_json
      FROM run_events AS p LEFT JOIN run_events AS s ON s.type='host_command_settled'
        AND json_extract(s.data_json, '$.executionId')=json_extract(p.data_json, '$.executionId')
      WHERE p.type='host_command_prepared'
      ORDER BY p.ts, p.id`).all();
    if (rows.length === 0) return [];
    const scope = workspaceScope(cwd, false);
    return rows.flatMap(row => {
      const prepared: unknown = JSON.parse(String(row.data_json));
      const settled: unknown = row.settlement_json == null ? undefined : JSON.parse(String(row.settlement_json));
      if (!isHostCommandPreparedV1(prepared) || (settled !== undefined && !isHostCommandSettledV1(settled))) {
        throw failure("command_journal_corrupt");
      }
      // Validate before filtering: malformed "completed" rows must not silently unlock writes.
      if (isHostCommandSettledV1(settled) && settled.outcome !== "stop_unconfirmed") return [];
      if (!overlap(prepared.workspace, scope)) return [];
      return [{ executionId: prepared.executionId, runId: String(row.run_id), toolCallId: prepared.toolCallId,
        attemptId: prepared.source.attemptId, workspace: prepared.workspace, state: settled ? "stop_unconfirmed" : "prepared" }];
    });
  }

  private insert(runId: string, type: "host_command_prepared" | "host_command_settled",
    data: HostCommandPreparedV1 | HostCommandSettledV1): PreparedEvent | SettledEvent {
    const next = this.context.database.prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM run_events WHERE run_id=?").get(runId);
    const event = { id: createEventId(), runId, seq: Number(next!.seq), ts: new Date().toISOString(), type, data } as PreparedEvent | SettledEvent;
    this.context.database.prepare("INSERT INTO run_events (id,run_id,seq,ts,type,data_json) VALUES (?,?,?,?,?,?)")
      .run(event.id, runId, event.seq, event.ts, type, JSON.stringify(data));
    return event;
  }
  private transaction<T>(operation: () => T): T {
    this.context.database.exec("BEGIN IMMEDIATE");
    try { const value = operation(); this.context.database.exec("COMMIT"); return value; }
    catch (error) { this.context.database.exec("ROLLBACK"); throw error; }
  }
}
function failure(code: string): Error { return Object.assign(new Error(code), { code }); }
function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return !path || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
}
function overlap(left: HostCommandPreparedV1["workspace"], right: HostCommandPreparedV1["workspace"]): boolean {
  return [left.path, left.realPath].some(a => [right.path, right.realPath].some(b => inside(a, b) || inside(b, a)));
}
function workspaceScope(cwd: string, mustExist: boolean): HostCommandPreparedV1["workspace"] {
  if (!isAbsolute(cwd)) throw failure("command_workspace_unverifiable");
  const path = resolve(cwd);
  if (mustExist && !statSync(path).isDirectory()) throw failure("command_workspace_unverifiable");
  return { path, realPath: canonicalPath(path) };
}
function canonicalPath(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
    return resolve(canonicalPath(dirname(path)), relative(dirname(path), path));
  }
}
