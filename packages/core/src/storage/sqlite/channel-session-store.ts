import { channelSessionWorkflowSourceSql, channelSessionRunSourceSql, channelSessionWorkSourceSql, channelSessionApprovalSourceSql, channelSessionInputWaitSourceSql } from "./channel-session-lineage.js";
import { createHash } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import {
  ChannelSessionError,
  type ChannelSessionPage,
  type ChannelSessionSummary,
  type CreateChannelSessionInput,
  type ListChannelSessionsOptions,
  type UpdateChannelSessionRequest,
} from "../../channel-session-types.js";
import type { Channel, CreateChannelInput, CreateChannelBranchInput, ChannelBranch, ChannelBranchUpdateInput } from "../../workspace-types.js";
import { DEFAULT_WORKSPACE_ID, createChannelBranchId } from "../../workspace-types.js";
import type { CreateLingThreadInput, LingThread, UpdateLingThreadInput } from "../../run-types.js";

interface SessionPorts {
  readonly createChannel: (input: CreateChannelInput, now: string) => Channel;
  readonly getBranch: (id: string) => ChannelBranch | undefined;
  readonly updateBranch: (id: string, input: ChannelBranchUpdateInput, now: string) => ChannelBranch | undefined;
  readonly deleteBranch: (id: string) => boolean;
  readonly getChannel: (id: string) => Channel | undefined;
  readonly createLingThread: (input: CreateLingThreadInput, now: string) => LingThread;
  readonly getLingThread: (id: string) => LingThread | undefined;
  readonly updateLingThread: (id: string, input: UpdateLingThreadInput, now: string) => LingThread | undefined;
  readonly createChannelBranch: (input: CreateChannelBranchInput, now: string) => ChannelBranch;
}

type Row = Record<string, SQLOutputValue>;
const terminalStates = "'succeeded','failed','cancelled','expired'";
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
// Sources are durable object links; UI selection is never an attribution signal.
const approvalSource = channelSessionApprovalSourceSql("a", "t.id");
const workSource = channelSessionWorkSourceSql("w", "t.id");
const activeWorkSource = `EXISTS (SELECT 1 FROM work_units w WHERE w.status NOT IN (${terminalStates}) AND ${workSource})`;
const activeWorkflowSource = `EXISTS (SELECT 1 FROM channel_workflows workflow WHERE ${channelSessionWorkflowSourceSql("workflow", "t.id")}
  AND (workflow.status NOT IN (${terminalStates}) OR EXISTS (SELECT 1 FROM channel_workflow_steps step
    WHERE step.workflow_id = workflow.id AND step.status NOT IN (${terminalStates}, 'skipped'))))`;
const activeInputWaitSource = `EXISTS (SELECT 1 FROM user_input_requests input_wait
  WHERE input_wait.wait_status IN ('waiting','resuming','blocked')
    AND ${channelSessionInputWaitSourceSql("input_wait", "t.id")})`;



export class SqliteChannelSessionStore {
  constructor(private readonly database: DatabaseSync, private readonly ports: SessionPorts) {}

  createChannel(input: CreateChannelInput, now: string): Channel {
    return this.write(() => {
      const channel = this.ports.createChannel(input, now);
      this.ports.createLingThread({ kind: "channel_discussion", channelId: channel.id,
        title: "Default conversation", objective: `Default conversation for ${channel.name}.`,
        surfaceKind: "channel_root", relationKind: "root" }, now);
      return channel;
    });
  }

  create(input: CreateChannelSessionInput, now: string): { session: ChannelSessionSummary; idempotentReplay: boolean } {
    const title = input.title === undefined ? "New conversation" : this.title(input.title, input.legacy);
    if (input.idempotencyKey !== undefined && (!input.idempotencyKey.trim() || input.idempotencyKey.length > 256)) {
      throw new ChannelSessionError("invalid_idempotency_key", "A non-empty creation key of at most 256 characters is required.", 400);
    }
    const hash = createHash("sha256").update(JSON.stringify({ title, manual: input.title !== undefined, archived: Boolean(input.archived) })).digest("hex");
    return this.write(() => {
      this.channel(input.channelId);
      const replay = input.idempotencyKey ? this.database.prepare(`SELECT request_hash, thread_id FROM channel_session_requests
        WHERE workspace_id = ? AND channel_id = ? AND idempotency_key = ?`)
        .get(DEFAULT_WORKSPACE_ID, input.channelId, input.idempotencyKey) as Row | undefined : undefined;
      if (replay) {
        if (replay.request_hash !== hash) throw new ChannelSessionError("session_creation_conflict", "The creation key belongs to different input.");
        const session = this.get(input.channelId, String(replay.thread_id));
        if (!session) throw new ChannelSessionError("session_creation_target_missing", "The original conversation is no longer available.");
        return { session, idempotentReplay: true };
      }
      this.channel(input.channelId, true);
      const thread = this.ports.createLingThread({ kind: "channel_discussion", channelId: input.channelId,
        title, objective: `Conversation in channel ${input.channelId}.`, surfaceKind: "channel_session", relationKind: "root" }, now);
      this.database.prepare("UPDATE ling_threads SET session_title_source = ?, session_activity_at = ? WHERE id = ?")
        .run(input.title === undefined ? "placeholder" : "manual", now, thread.id);
      this.ports.createChannelBranch({ id: createChannelBranchId(), channelId: input.channelId,
        name: title, rootThreadId: thread.id, ...(input.archived ? { status: "archived", archivedAt: now } : {}) }, now);
      if (input.archived) this.ports.updateLingThread(thread.id, { archivedAt: now, archivedReason: "channel_branch_archived" }, now);
      if (input.idempotencyKey) this.database.prepare(`INSERT INTO channel_session_requests
        (workspace_id, channel_id, idempotency_key, request_hash, thread_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(DEFAULT_WORKSPACE_ID, input.channelId, input.idempotencyKey, hash, thread.id, now);
      return { session: this.get(input.channelId, thread.id)!, idempotentReplay: false };
    });
  }

  registerDirectory(input: CreateChannelBranchInput, now: string): ChannelBranch {
    return this.write(() => {
      this.channel(input.channelId, true);
      if (input.rootThreadId) {
        const thread = this.ports.getLingThread(input.rootThreadId);
        if (!thread || thread.channelId !== input.channelId || thread.surfaceKind === "channel_root"
          || thread.kind !== "channel_discussion" || thread.taskId || thread.teammateId || thread.workflowId
          || thread.workflowStepId || thread.externalWorkId) {
          throw new ChannelSessionError("invalid_session_mapping", "Conversation directory must own a thread in the same channel.");
        }
        if (thread.surfaceKind === "work" && !thread.parentThreadId && !thread.parentTurnId && !thread.anchorItemId
          && !thread.forkContextSnapshotId && !thread.forkedFromRunId) {
          this.database.prepare("UPDATE ling_threads SET surface_kind = 'channel_session', relation_kind = 'root' WHERE id = ?").run(thread.id);
        } else if (thread.surfaceKind !== "branch" && thread.surfaceKind !== "channel_session") {
          throw new ChannelSessionError("invalid_session_mapping", "Conversation directory has unsupported thread topology.");
        }
      }
      const branch = this.ports.createChannelBranch(input.rootThreadId
        ? { ...input, status: "active", archivedAt: undefined } : input, now);
      if (input.rootThreadId) {
        this.update(input.channelId, input.rootThreadId, { title: input.name,
          ...(input.status === "archived" ? { archived: true } : {}) }, now, true);
        if (input.status === "archived" && input.archivedAt) this.ports.updateBranch(branch.id, { archivedAt: input.archivedAt }, now);
      }
      return this.ports.getBranch(branch.id)!;
    });
  }

  repairDirectory(channelId: string, branchId: string, now: string): ChannelSessionSummary {
    return this.write(() => {
      this.channel(channelId, true);
      const branch = this.ports.getBranch(branchId);
      if (!branch || branch.channelId !== channelId || branch.deletedAt) {
        throw new ChannelSessionError("channel_session_not_found", "Conversation directory not found.", 404);
      }
      if (branch.rootThreadId) {
        const existing = this.get(channelId, branch.rootThreadId);
        if (existing) return existing;
        throw new ChannelSessionError("session_requires_repair", "The existing directory mapping is ambiguous and needs manual repair.");
      }
      const history = this.database.prepare(`SELECT 1 FROM ling_threads t WHERE t.channel_id = ?
        AND t.surface_kind IN ('work','channel_session','branch') AND t.task_id IS NULL AND t.teammate_id IS NULL
        AND t.workflow_id IS NULL AND t.external_work_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM channel_branches b WHERE b.root_thread_id = t.id)
        AND EXISTS (SELECT 1 FROM conversation_items i WHERE i.thread_id = t.id) LIMIT 1`).get(channelId);
      const reference = this.database.prepare(`SELECT 1 FROM conversation_items i, json_each(i.domain_refs_json) ref
        WHERE i.channel_id = ? AND json_extract(ref.value, '$.id') = ? LIMIT 1`).get(channelId, branchId);
      if (history || reference) throw new ChannelSessionError("session_requires_repair", "The directory may own existing history; automatic allocation is unsafe.");
      const thread = this.ports.createLingThread({ kind: "channel_discussion", channelId, title: branch.name,
        objective: `Conversation in channel ${channelId}.`, surfaceKind: "channel_session", relationKind: "root",
        ...(branch.status === "archived" ? { archivedAt: branch.archivedAt ?? now, archivedReason: "channel_branch_archived" } : {}),
      }, now);
      this.ports.updateBranch(branchId, { rootThreadId: thread.id }, now);
      this.database.prepare("DELETE FROM channel_session_diagnostics WHERE branch_id = ?").run(branchId);
      return this.get(channelId, thread.id)!;
    });
  }

  updateLegacyBranch(id: string, input: ChannelBranchUpdateInput, now: string): ChannelBranch | undefined {
    return this.write(() => {
      const branch = this.ports.getBranch(id);
      if (!branch) return undefined;
      if (input.rootThreadId !== undefined && input.rootThreadId !== branch.rootThreadId) {
        throw new ChannelSessionError("session_mapping_immutable", "Use the explicit directory repair operation to establish conversation identity.");
      }
      if (branch.rootThreadId && this.get(branch.channelId, branch.rootThreadId)) {
        if (input.rootThreadId !== undefined && input.rootThreadId !== branch.rootThreadId) {
          throw new ChannelSessionError("session_mapping_immutable", "A registered conversation cannot change its thread identity.");
        }
        this.update(branch.channelId, branch.rootThreadId, {
          ...(input.name !== undefined ? { title: input.name } : {}),
          ...(input.status !== undefined || input.archivedAt !== undefined || input.deletedAt ? {
            archived: input.deletedAt ? true : input.status ? input.status === "archived" : Boolean(input.archivedAt),
          } : {}),
        }, now, true);
      } else if (this.database.prepare("SELECT 1 FROM channel_session_diagnostics WHERE branch_id = ?").get(id)) {
        throw new ChannelSessionError("session_requires_repair", "Repair the conversation directory before modifying it.");
      }
      return this.ports.updateBranch(id, input.deletedAt ? { ...input, status: "archived" } : input, now);
    });
  }

  deleteLegacyBranch(id: string, now: string): boolean {
    return this.write(() => {
      const branch = this.ports.getBranch(id);
      if (branch?.rootThreadId && this.get(branch.channelId, branch.rootThreadId)) {
        this.update(branch.channelId, branch.rootThreadId, { archived: true }, now, true);
      }
      return this.ports.deleteBranch(id);
    });
  }

  get(channelId: string, threadId: string): ChannelSessionSummary | undefined {
    return this.summaries(channelId).find((session) => session.id === threadId);
  }

  list(channelId: string, options: ListChannelSessionsOptions = {}): ChannelSessionPage {
    this.channel(channelId);
    const q = options.q?.trim().toLocaleLowerCase() ?? "";
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || q.length > 256) {
      throw new ChannelSessionError("invalid_session_query", "limit must be 1–100 and the query at most 256 characters.", 400);
    }
    const all = this.summaries(channelId);
    let sessions = all.filter((session) => !session.isDefault && Boolean(session.archivedAt) === Boolean(options.archived)
      && (!q || session.title.toLocaleLowerCase().includes(q)))
      .sort((a, b) => compare(b.activityAt, a.activityAt) || compare(a.id, b.id));
    if (options.cursor) {
      let cursor: { channelId: string; archived: boolean; q: string; activityAt: string; id: string };
      try {
        if (options.cursor.length > 4096) throw new Error("oversized cursor");
        cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
        if (cursor.channelId !== channelId || cursor.archived !== Boolean(options.archived) || cursor.q !== q
          || typeof cursor.activityAt !== "string" || typeof cursor.id !== "string") throw new Error("cursor scope mismatch");
      } catch { throw new ChannelSessionError("invalid_session_cursor", "The cursor does not belong to this conversation query.", 400); }
      sessions = sessions.filter((s) => s.activityAt < cursor.activityAt || (s.activityAt === cursor.activityAt && s.id > cursor.id));
    }
    const page = sessions.slice(0, limit);
    const last = page.at(-1);
    const active = all.filter((session) => !session.archivedAt);
    return {
      defaultSession: all.find((session) => session.isDefault), sessions: page,
      ...(sessions.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify({ channelId,
        archived: Boolean(options.archived), q, activityAt: last.activityAt, id: last.id })).toString("base64url") } : {}),
      diagnostics: this.diagnostics(channelId),
      notificationWatermarks: active.map(({ id, latestNotificationRevision }) => ({ id, latestNotificationRevision })),
      aggregate: { pendingApprovalCount: active.length ? Number(this.database.prepare(`SELECT COUNT(DISTINCT a.id) AS n
          FROM approval_requests a LEFT JOIN run_sessions r ON r.id = a.run_id
          WHERE a.status = 'pending' AND (a.expires_at IS NULL OR a.expires_at > ?)
            AND EXISTS (SELECT 1 FROM ling_threads t WHERE t.id IN (${active.map(() => '?').join(',')}) AND ${approvalSource})`)
          .get(new Date().toISOString(), ...active.map((session) => session.id))!.n) : 0,
        runningCount: active.filter((s) => s.runtimeState === "running" || s.runtimeState === "queued").length,
        waitingCount: active.filter((s) => s.runtimeState === "waiting").length,
        failedCount: active.filter((s) => s.runtimeState === "failed" || s.runtimeState === "blocked").length },
    };
  }

  update(channelId: string, threadId: string, input: UpdateChannelSessionRequest, now: string, legacy = false): ChannelSessionSummary {
    const title = input.title === undefined ? undefined : this.title(input.title, legacy);
    return this.write(() => {
      const channel = this.channel(channelId);
      if (channel.status === "archived") throw new ChannelSessionError("channel_archived", "Archived channels are read-only.");
      const session = this.get(channelId, threadId);
      if (!session) throw new ChannelSessionError("channel_session_not_found", "Conversation not found in this channel.", 404);
      if (input.archived === true) this.assertArchiveable(threadId);
      if (title !== undefined) this.database.prepare("UPDATE ling_threads SET session_title_source = 'manual' WHERE id = ?").run(threadId);
      const thread = this.ports.getLingThread(threadId)!;
      this.ports.updateLingThread(threadId, { ...(title !== undefined ? { title } : {}),
        ...(input.archived === true ? { archivedAt: now, archivedReason: "channel_branch_archived" } : {}),
        ...(input.archived === false ? { archivedAt: null, archivedReason: null,
          ...(thread.status === "archived" ? { status: "open" as const } : {}) } : {}) }, now);
      return this.get(channelId, threadId)!;
    });
  }

  /** Generic Thread edits share session lifecycle checks and placeholder title ownership. */
  updateThread(threadId: string, input: UpdateLingThreadInput, now: string): LingThread | undefined {
    // Preserve the existing projection transaction for non-channel conversations.
    if (!this.ports.getLingThread(threadId)?.channelId) return this.ports.updateLingThread(threadId, input, now);
    return this.write(() => {
      const thread = this.ports.getLingThread(threadId);
      if (!thread) return undefined;
      const diagnosed = this.database.prepare(`SELECT 1 FROM channel_session_diagnostics d JOIN channel_branches b
        ON b.id = d.branch_id WHERE b.root_thread_id = ? AND b.deleted_at IS NULL LIMIT 1`).get(threadId);
      if (diagnosed) throw new ChannelSessionError("session_requires_repair", "Repair the conversation directory before modifying this thread.");
      if (!thread.channelId || !this.get(thread.channelId, threadId)) return this.ports.updateLingThread(threadId, input, now);
      const archiving = Boolean(input.archivedAt) || input.status === "archived";
      if (archiving) this.assertArchiveable(threadId);
      if ((input.title !== undefined || input.archivedAt !== undefined || input.status === "archived")
        && this.channel(thread.channelId).status === "archived") {
        throw new ChannelSessionError("channel_archived", "Archived channels are read-only.");
      }
      if (input.title !== undefined) this.database.prepare("UPDATE ling_threads SET session_title_source = 'manual' WHERE id = ?").run(threadId);
      return this.ports.updateLingThread(threadId, { ...input,
        ...(input.status === "archived" && !input.archivedAt ? { archivedAt: now, archivedReason: "channel_branch_archived" } : {}),
        ...(input.archivedAt === null && thread.status === "archived" && input.status === undefined ? { status: "open" as const } : {}),
      }, now);
    });
  }

  assertArchiveable(threadId: string): void {
    const thread = this.ports.getLingThread(threadId);
    if (!thread?.channelId || !this.get(thread.channelId, threadId)) return;
    if (thread.surfaceKind === "channel_root") throw new ChannelSessionError("default_session_required", "The default conversation cannot be archived separately.");
    const session = this.get(thread.channelId, threadId)!;
    if (session.pendingApprovalCount > 0 || this.database.prepare(`SELECT 1 FROM ling_threads t JOIN run_sessions r
      ON ${channelSessionRunSourceSql("r", "t.id")} WHERE t.id = ? AND r.status IN ('queued','running','waiting_for_approval') LIMIT 1`).get(threadId)
      || this.database.prepare(`SELECT 1 FROM ling_threads t WHERE t.id = ? AND (${activeWorkSource} OR ${activeWorkflowSource} OR ${activeInputWaitSource})`).get(threadId)) {
      throw new ChannelSessionError("session_has_active_work", "Finish or cancel pending work and approvals before archiving this conversation.");
    }
  }

  /** Called inside the user-turn transaction; the placeholder CAS cannot overwrite a manual title. */
  nameFromFirstMessage(threadId: string, body: string): void {
    const title = [...body.trim().split(/\r?\n/u)[0]!.replace(/\s+/gu, " ")].slice(0, 40).join("");
    if (!title) return;
    this.database.prepare(`UPDATE ling_threads SET title = ?, session_title_source = 'first_message'
      WHERE id = ? AND surface_kind = 'channel_session' AND session_title_source = 'placeholder'`).run(title, threadId);
  }

  private summaries(channelId: string): ChannelSessionSummary[] {
    const rows = this.database.prepare(`SELECT t.*, b.id AS branch_id,
      (SELECT json_group_array(DISTINCT a.id) FROM approval_requests a LEFT JOIN run_sessions r ON r.id = a.run_id
        WHERE a.status = 'pending' AND (a.expires_at IS NULL OR a.expires_at > ?)
          AND ${approvalSource}) AS pending_approval_ids,
      (SELECT json_group_array(DISTINCT r.id) FROM run_sessions r WHERE ${channelSessionRunSourceSql("r", "t.id")}
        AND r.status IN ('queued','running','waiting_for_approval')) AS active_run_ids,
      (SELECT r.status FROM run_sessions r WHERE ${channelSessionRunSourceSql("r", "t.id")}
        ORDER BY CASE r.status WHEN 'waiting_for_approval' THEN 0 WHEN 'running' THEN 1 WHEN 'queued' THEN 2 WHEN 'yielded' THEN 3 ELSE 4 END, r.created_at DESC, r.id DESC LIMIT 1) AS run_status,
      (${activeWorkSource} OR ${activeWorkflowSource} OR ${activeInputWaitSource}) AS dispatch_active,
      (SELECT MAX(activity_at) FROM (
        SELECT MAX(r.created_at, COALESCE(r.started_at, r.created_at), COALESCE(r.ended_at, r.created_at)) AS activity_at
          FROM run_sessions r WHERE ${channelSessionRunSourceSql("r", "t.id")}
        UNION ALL SELECT workflow.created_at FROM channel_workflows workflow WHERE ${channelSessionWorkflowSourceSql("workflow", "t.id")}
        UNION ALL SELECT w.created_at FROM work_units w WHERE ${workSource}
      )) AS execution_activity_at,
      (SELECT input_wait.wait_status FROM user_input_requests input_wait
        WHERE input_wait.wait_status IN ('waiting','resuming','blocked')
          AND ${channelSessionInputWaitSourceSql("input_wait", "t.id")}
        ORDER BY CASE input_wait.wait_status WHEN 'blocked' THEN 0 ELSE 1 END, input_wait.updated_at DESC LIMIT 1) AS input_wait_status,
      (SELECT workflow.status FROM channel_workflows workflow WHERE ${channelSessionWorkflowSourceSql("workflow", "t.id")}
        ORDER BY CASE workflow.status WHEN 'waiting_for_approval' THEN 0 WHEN 'waiting_for_input' THEN 0
          WHEN 'blocked' THEN 1 WHEN 'running' THEN 2 WHEN 'ready' THEN 3 WHEN 'draft' THEN 3 WHEN 'failed' THEN 4 ELSE 5 END,
          workflow.updated_at DESC, workflow.id DESC LIMIT 1) AS workflow_status
      FROM ling_threads t LEFT JOIN channel_branches b ON b.root_thread_id = t.id AND b.deleted_at IS NULL
      WHERE t.workspace_id = ? AND t.channel_id = ? AND
        (t.surface_kind = 'channel_root' OR (b.id IS NOT NULL AND t.surface_kind IN ('channel_session','branch')
          AND NOT EXISTS (SELECT 1 FROM channel_session_diagnostics d WHERE d.branch_id = b.id)))
      ORDER BY t.archived_at IS NOT NULL, t.created_at, t.id`)
      .all(new Date().toISOString(), DEFAULT_WORKSPACE_ID, channelId) as Row[];
    let hasDefault = false;
    return rows.flatMap((row) => {
      const isDefault = row.surface_kind === "channel_root";
      if (isDefault && hasDefault) return [];
      if (isDefault) hasDefault = true;
      const pendingApprovalIds = JSON.parse(String(row.pending_approval_ids)) as string[];
      const pendingApprovalCount = pendingApprovalIds.length;
      const status = String(row.run_status ?? row.status);
      const workflowStatus = String(row.workflow_status ?? "");
      const runtimeState: ChannelSessionSummary["runtimeState"] = pendingApprovalCount || row.input_wait_status === "waiting" || row.input_wait_status === "resuming" || workflowStatus === "waiting_for_approval" || workflowStatus === "waiting_for_input" || row.status === "waiting_for_input" || status === "waiting_for_approval" || status === "waiting_for_input" ? "waiting"
        : row.input_wait_status === "blocked" || row.status === "blocked" || workflowStatus === "blocked" ? "blocked" : status === "running" || workflowStatus === "running" ? "running" : row.dispatch_active || status === "queued" ? "queued"
          : status === "blocked" ? "blocked" : status === "failed" || workflowStatus === "failed" ? "failed" : "idle";
      return [{ id: String(row.id), channelId, title: String(row.title), isDefault,
        surfaceKind: row.surface_kind as ChannelSessionSummary["surfaceKind"],
        ...(!isDefault && row.branch_id ? { legacyBranchId: String(row.branch_id) } : {}),
        createdAt: String(row.created_at), activityAt: [String(row.session_activity_at ?? row.created_at),
          ...(row.execution_activity_at ? [String(row.execution_activity_at)] : [])].sort(compare).at(-1)!,
        ...(row.archived_at ? { archivedAt: String(row.archived_at) } : {}),
        latestNotificationRevision: Number(row.session_notification_revision), pendingApprovalCount,
        pendingApprovalIds,
        activeRunIds: JSON.parse(String(row.active_run_ids)) as string[], runtimeState }];
    });
  }

  private diagnostics(channelId: string): ChannelSessionPage["diagnostics"] {
    return (this.database.prepare(`SELECT b.id, COALESCE(d.code, 'missing_thread') AS code
      FROM channel_branches b LEFT JOIN channel_session_diagnostics d ON d.branch_id = b.id
      LEFT JOIN ling_threads t ON t.id = b.root_thread_id
      WHERE b.channel_id = ? AND b.deleted_at IS NULL AND (d.branch_id IS NOT NULL OR t.id IS NULL)`)
      .all(channelId) as Row[]).map((row) => ({ branchId: String(row.id), code: String(row.code) }));
  }

  private channel(id: string, writable = false): Channel {
    const channel = this.ports.getChannel(id);
    if (!channel) throw new ChannelSessionError("channel_not_found", "Channel not found.", 404);
    if (writable && channel.status !== "active") throw new ChannelSessionError("channel_not_active", "This channel cannot create conversations while paused or archived.");
    return channel;
  }

  private title(value: string, legacy = false): string {
    const title = value.trim();
    if (!title || (!legacy && [...title].length > 120)) throw new ChannelSessionError("invalid_session_title", "Conversation names must contain 1–120 characters.", 400);
    return title;
  }

  private write<T>(mutate: () => T): T {
    this.database.exec("SAVEPOINT channel_session_write");
    try {
      // Acquire the SQLite writer before lifecycle/idempotency reads.
      this.database.exec("UPDATE channels SET updated_at = updated_at WHERE 0");
      const result = mutate();
      this.database.exec("RELEASE channel_session_write");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK TO channel_session_write; RELEASE channel_session_write");
      throw error;
    }
  }
}
