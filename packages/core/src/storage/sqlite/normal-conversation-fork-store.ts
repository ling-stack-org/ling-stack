import { createHash } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { isConversationContextProjectionMetadata } from "@ling-stack/contracts";
import type { CaptureNormalConversationFork, CreateNormalConversationFork, CreateNormalConversationForkResult,
  NormalConversationForkSeed, NormalConversationForkSource } from "../../normal-conversation-fork-types.js";
import { NormalConversationForkSourceInUseError } from "../../normal-conversation-fork-types.js";
import type { RunStore } from "../../run-types.js";
import { redactSecrets } from "../../redaction.js";
import { DEFAULT_WORKSPACE_ID, LING_AGENT_ID } from "../../workspace-types.js";
import { readSqliteWithinTransaction } from "./read-snapshot.js";
import type { SqliteStoreContext } from "./store-context.js";

const USE = "normal_conversation_fork_seed";
type Row = Record<string, SQLOutputValue>;
type Ports = Pick<RunStore, "getLingThread" | "getLingTurn" | "getConversationItem" | "getRun" |
  "getLingTurnForRun" | "listLingTurnRuns" | "createLingThread">;

/** One synchronous transaction freezes source history and creates its branch. */
export class SqliteNormalConversationForkStore {
  constructor(private readonly context: SqliteStoreContext, private readonly store: Ports) {}

  create(input: CreateNormalConversationFork, capture: CaptureNormalConversationFork, now: string): CreateNormalConversationForkResult {
    if (!input.childThreadId.trim() || input.childThreadId === input.parentThreadId) throw new Error("Normal fork source conflict");
    if (Object.prototype.toString.call(capture) === "[object AsyncFunction]") throw new TypeError("Normal fork capture must be synchronous");
    const { database } = this.context;
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.store.getLingThread(input.childThreadId);
      if (existing) {
        const seed = this.get(input.childThreadId);
        if (!seed) throw new Error("Normal fork seed is invalid: missing frozen history");
        if (seed.threadId !== input.parentThreadId || seed.turnId !== input.parentTurnId || seed.sourceRunId !== input.sourceRunId) {
          throw new Error("Normal fork idempotency conflict");
        }
        database.exec("COMMIT");
        return { thread: existing, seed, created: false };
      }
      const source = this.resolveSource(input.parentThreadId, input.parentTurnId, input.sourceRunId);
      if (source.thread.archivedAt || source.thread.status === "archived" || source.item.status !== "committed" ||
        !["succeeded", "failed", "cancelled"].includes(source.turn.status) ||
        (source.run && !["succeeded", "failed", "cancelled"].includes(source.run.status)) ||
        (source.turn.activeRunId && !["succeeded", "failed", "cancelled"].includes(this.store.getRun(source.turn.activeRunId)?.status ?? ""))) {
        throw new Error("Normal fork source must be terminal and available");
      }
      const seed = readSqliteWithinTransaction(database, () => {
        const captured = capture(source);
        if (captured && typeof Reflect.get(captured, "then") === "function") throw new TypeError("Normal fork capture must be synchronous");
        const body = JSON.parse(JSON.stringify({ id: seedId(input.childThreadId), schemaVersion: 1, use: USE,
          workspaceId: source.thread.workspaceId, childThreadId: input.childThreadId, threadId: source.thread.id,
          turnId: source.turn.id, sourceItemId: source.item.id, sourceRunId: source.run?.id,
          projection: captured.projection, payload: captured.payload, createdAt: now })) as Record<string, unknown>;
        const value = { ...body, fingerprint: hash(body) };
        assertSeed(value);
        this.assertBoundary(value, source);
        return freeze(value);
      });
      const p = seed.projection;
      database.prepare(`INSERT INTO conversation_context_snapshots (
        id, workspace_id, thread_id, segment_id, projection_version, through_item_sequence,
        summary_ids_json, source_refs_json, policy_version, created_at,
        snapshot_use, payload_version, source_item_id, payload_json, payload_fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`).run(
        seed.id, seed.workspaceId, seed.threadId, p.segmentId, p.projectionVersion, p.throughItemSequence,
        JSON.stringify(p.summaryIds), JSON.stringify(p.sourceRefs), p.policyVersion, now, USE, JSON.stringify(seed), seed.fingerprint);
      const thread = this.store.createLingThread({ id: input.childThreadId, kind: "conversation", title: input.title,
        objective: input.objective, teammateId: source.thread.teammateId, conversationMode: source.thread.conversationMode,
        status: "open", parentThreadId: seed.threadId, parentTurnId: seed.turnId, forkedFromRunId: seed.sourceRunId,
        surfaceKind: "branch", relationKind: "branch", anchorItemId: seed.sourceItemId, forkContextSnapshotId: seed.id }, now);
      database.exec("COMMIT");
      return { thread, seed, created: true };
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* Keep the original transaction error. */ }
      throw error;
    }
  }

  /** Caller may own a read/write transaction. Never recaptures absent or corrupt history. */
  get(childThreadId: string): NormalConversationForkSeed | undefined {
    const thread = this.store.getLingThread(childThreadId);
    const rows = this.context.database.prepare("SELECT * FROM conversation_context_snapshots WHERE id=? OR id=?")
      .all(seedId(childThreadId), thread?.forkContextSnapshotId ?? seedId(childThreadId)) as Row[];
    if (rows.length === 0 && (!thread || (thread.kind === "conversation" && !thread.parentThreadId && !thread.forkContextSnapshotId))) return undefined;
    try {
      const row = rows[0];
      if (rows.length !== 1 || !row || row.snapshot_use !== USE || row.payload_version !== 1 || typeof row.payload_json !== "string") throw new Error("use/version");
      const value: unknown = JSON.parse(row.payload_json);
      assertSeed(value);
      const p = value.projection;
      if (value.childThreadId !== childThreadId || row.id !== value.id || row.workspace_id !== value.workspaceId ||
        row.thread_id !== value.threadId || row.segment_id !== p.segmentId || row.projection_version !== p.projectionVersion ||
        row.through_item_sequence !== p.throughItemSequence || row.summary_ids_json !== JSON.stringify(p.summaryIds) ||
        row.source_refs_json !== JSON.stringify(p.sourceRefs) || row.policy_version !== p.policyVersion || row.created_at !== value.createdAt ||
        row.source_item_id !== null || row.payload_fingerprint !== value.fingerprint ||
        !thread || thread.kind !== "conversation" || thread.channelId || thread.workspaceId !== value.workspaceId ||
        thread.relationKind !== "branch" || thread.surfaceKind !== "branch" || thread.parentThreadId !== value.threadId ||
        thread.parentTurnId !== value.turnId || thread.forkedFromRunId !== value.sourceRunId ||
        thread.forkContextSnapshotId !== value.id || thread.anchorItemId !== value.sourceItemId) throw new Error("row/lineage mismatch");
      this.assertBoundary(value, this.resolveSource(value.threadId, value.turnId, value.sourceRunId));
      return freeze(value);
    } catch (error) { throw new Error("Normal fork seed is invalid", { cause: error }); }
  }

  private resolveSource(threadId: string, turnId: string, runId?: string): NormalConversationForkSource {
    const thread = this.store.getLingThread(threadId), turn = this.store.getLingTurn(turnId);
    const item = turn?.sourceItemId ? this.store.getConversationItem(turn.sourceItemId) : undefined;
    const run = runId ? this.store.getRun(runId) : undefined;
    if (!thread || !turn || !item || thread.kind !== "conversation" || thread.workspaceId !== DEFAULT_WORKSPACE_ID ||
      thread.channelId || (thread.teammateId && thread.teammateId !== LING_AGENT_ID) ||
      turn.threadId !== thread.id || turn.workspaceId !== thread.workspaceId || turn.channelId || turn.workflowStepId ||
      (turn.teammateId && turn.teammateId !== LING_AGENT_ID) || item.kind !== "user_message" ||
      item.threadId !== thread.id || item.turnId !== turn.id || item.workspaceId !== thread.workspaceId || item.channelId ||
      item.visibility !== "thread_participants" || item.visibilityOwnerId ||
      !((item.actorType === "local_user" && turn.createdByActor === "local-user") || (item.actorType === "system" && turn.createdByActor === "system")) ||
      (runId && (!run || run.threadId !== thread.id || run.channelId || run.workflowStepId ||
        (run.teammateId && run.teammateId !== LING_AGENT_ID) || this.store.getLingTurnForRun(run.id)?.id !== turn.id ||
        !this.store.listLingTurnRuns(turn.id).some(link => link.runId === run.id && link.role !== "validation")))) {
      throw new Error("Normal fork source scope mismatch");
    }
    return { thread, turn, item, run };
  }

  private assertBoundary(seed: NormalConversationForkSeed, source: NormalConversationForkSource): void {
    const segment = this.context.database.prepare("SELECT thread_id, workspace_id FROM context_segments WHERE id=?").get(seed.projection.segmentId);
    if (seed.sourceItemId !== source.item.id || seed.projection.throughItemSequence !== source.item.sequence ||
      segment?.thread_id !== seed.threadId || segment.workspace_id !== seed.workspaceId) throw new Error("Normal fork source boundary mismatch");
  }
}

function assertSeed(value: unknown): asserts value is NormalConversationForkSeed {
  const required = ["id", "schemaVersion", "use", "workspaceId", "childThreadId", "threadId", "turnId", "sourceItemId", "projection", "payload", "createdAt", "fingerprint"];
  if (!record(value) || Object.keys(value).some(key => !required.includes(key) && key !== "sourceRunId") || required.some(key => !(key in value)) ||
    value.schemaVersion !== 1 || value.use !== USE || value.workspaceId !== DEFAULT_WORKSPACE_ID ||
    ![value.childThreadId, value.threadId, value.turnId, value.sourceItemId, value.createdAt].every(id => typeof id === "string" && id.length > 0) ||
    value.id !== seedId(value.childThreadId as string) || value.childThreadId === value.threadId ||
    (value.sourceRunId !== undefined && (typeof value.sourceRunId !== "string" || !value.sourceRunId)) ||
    !isConversationContextProjectionMetadata(value.projection) || value.projection.threadId !== value.threadId ||
    value.projection.turnId !== value.turnId || value.payload === undefined) throw new Error("Invalid normal fork seed envelope");
  const { fingerprint, ...body } = value;
  if (fingerprint !== hash(body) || JSON.stringify(redactSecrets(value)) !== JSON.stringify(value) || JSON.stringify(value).length > 2_000_000) {
    throw new Error("Invalid normal fork seed fingerprint, redaction or budget");
  }
}
function seedId(childThreadId: string): string { return `normal_fork_seed:${childThreadId}`; }

/** Invoked inside the caller's deletion transaction, so fork creation cannot race the check. */
export function prepareNormalForkRetentionForThreadDelete(context: SqliteStoreContext, threadId: string): void {
  const dependent = context.database.prepare(`SELECT id FROM ling_threads WHERE kind='conversation' AND (
    (parent_thread_id=? AND (relation_kind='branch' OR fork_context_snapshot_id IS NOT NULL)) OR
    fork_context_snapshot_id IN (SELECT id FROM conversation_context_snapshots WHERE thread_id=? AND snapshot_use=?)) LIMIT 1`)
    .get(threadId, threadId, USE);
  if (dependent) throw new NormalConversationForkSourceInUseError();
  // The seed row's thread_id is its source, not its owner. A leaf deletion must
  // remove its exact owned row rather than relying on the source-thread cascade.
  context.database.prepare("DELETE FROM conversation_context_snapshots WHERE id=?").run(seedId(threadId));
}
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
