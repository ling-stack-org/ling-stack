import type { LingAppServerWorkflowGoalBudget, LingAppServerWorkflowUsage, RunTokenUsageEvidence } from "@ling-stack/contracts";
import type { LingThreadGoal } from "../../run-types.js";
import type { WorkItem, WorkItemWorkflowUsage } from "../../work-item-types.js";
import { isJsonRecord, parseJson, readNullableString, readString } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

interface Usage {
  runCount: number;
  observedTokens: number;
  reservedTokens: number;
  toolCalls: number;
  elapsedSeconds: number;
  partial: boolean;
  settledWithoutUsage: boolean;
}

interface AttemptCharges {
  readonly measuredTokens: number;
  readonly noDispatch: 0 | 1;
  eventTokens?: number;
}

function emptyUsage(): Usage {
  return { runCount: 0, observedTokens: 0, reservedTokens: 0, toolCalls: 0, elapsedSeconds: 0, partial: false, settledWithoutUsage: false };
}

function projectUsage({ runCount, observedTokens, toolCalls, elapsedSeconds, partial }: Usage): LingAppServerWorkflowUsage {
  return { runCount, observedTokens, toolCalls, elapsedSeconds, tokenCoverage: partial ? "partial" : "complete" };
}

export function readWorkItemWorkflowUsage(context: SqliteStoreContext, item: WorkItem, goal: LingThreadGoal | undefined,
  now: string): WorkItemWorkflowUsage {
  const rows = context.database.prepare(`
    WITH owned_runs AS (
      SELECT r.id, r.thread_id, r.status, r.started_at, r.ended_at, s.id AS step_id,
        json_extract(s.metadata_json, '$.planStageId') AS stage_id
      FROM app_server_state link
      JOIN channel_workflow_steps s ON s.workspace_id=link.workspace_id AND s.workflow_id=link.record_id
      JOIN run_sessions r ON r.workflow_step_id=s.id AND r.channel_id=s.channel_id
      WHERE link.workspace_id=? AND link.kind IN ('work_item_workflow','work_item_deliberation_workflow')
        AND json_extract(link.payload_json, '$.binding.workItemId')=?
    ), attempt_charges AS (
      SELECT c.run_id, c.attempt_id, COUNT(*)=SUM(c.state='cancelled_before_dispatch') AS no_dispatch,
        SUM(CASE WHEN c.state='measured' THEN c.input_tokens + c.output_tokens ELSE 0 END) AS measured_tokens,
        SUM(CASE WHEN c.state IN ('reserved','unresolved') THEN COALESCE(c.reserved_tokens,0) ELSE 0 END) AS reserved_tokens,
        MAX(c.state='unresolved' OR c.state='reserved' AND c.reserved_tokens IS NULL) AS unresolved
      FROM delegation_budget_charges c JOIN owned_runs r ON r.id=c.run_id
      GROUP BY c.run_id, c.attempt_id
    ), charges AS (
      SELECT run_id, SUM(reserved_tokens) AS reserved_tokens, MAX(unresolved) AS unresolved,
        json_group_object(attempt_id, json_object('measuredTokens',measured_tokens,'noDispatch',no_dispatch)) AS by_attempt
      FROM attempt_charges
      GROUP BY run_id
    )
    SELECT r.*, c.by_attempt, c.reserved_tokens, c.unresolved, e.type AS event_type,
      json_extract(e.data_json,'$.attemptId') AS event_attempt_id,
      CASE WHEN e.type IN ('message_end','context_compaction_end') AND json_type(e.data_json,'$.usage')='object'
        THEN json_extract(e.data_json,'$.usage') END AS usage_json
    FROM owned_runs r
    LEFT JOIN charges c ON c.run_id=r.id
    LEFT JOIN run_events e ON e.run_id=r.id AND (e.type IN ('context_compaction_end','tool_start')
      OR (e.type='message_end' AND json_extract(e.data_json,'$.role')='assistant'))
    ORDER BY r.id, e.seq
  `).iterate(item.workspaceId, item.id);
  const total = emptyUsage();
  const goalCharges = emptyUsage();
  const accountedRunIds = new Set(goal?.completionEvidenceRefs.filter(ref => ref.kind === "run").map(ref => ref.id));
  const byStage = new Map<string, Usage>();
  const byStep = new Map<string, Usage>();
  const nowMs = Date.parse(now);
  let current: { readonly id: string; readonly stepId: string; readonly stageId?: string; readonly threadId?: string;
    readonly started: boolean; readonly settled: boolean; readonly usage: Usage;
    readonly charges: ReadonlyMap<string, AttemptCharges>; readonly unresolved: boolean } | undefined;

  const collect = () => {
    if (!current) return;
    const { usage, settled, started, stepId, stageId, threadId, charges, unresolved } = current;
    const eventTokens = usage.observedTokens;
    for (const charge of charges.values()) usage.observedTokens += Math.max(0, charge.measuredTokens - (charge.eventTokens ?? 0));
    const missingUsage = usage.partial || unresolved || settled && usage.reservedTokens > 0
      || started && usage.observedTokens === 0 && !charges.size;
    usage.partial = missingUsage || started && !settled;
    usage.settledWithoutUsage = unresolved || settled && missingUsage;
    addUsage(total, usage);
    if (goal) {
      const alreadyAccounted = threadId === goal.threadId && accountedRunIds.has(current.id);
      // A Goal's terminal Run ledger already includes its observed events.
      addUsage(goalCharges, alreadyAccounted
        ? { ...usage, observedTokens: usage.observedTokens - eventTokens, elapsedSeconds: 0 }
        : usage);
    }
    const group = stageId ? byStage : byStep;
    const key = stageId ?? stepId;
    let stage = group.get(key);
    if (!stage) {
      stage = emptyUsage();
      group.set(key, stage);
    }
    addUsage(stage, usage);
  };

  for (const row of rows) {
    const id = readString(row, "id");
    if (!current || current.id !== id) {
      collect();
      const started = readNullableString(row, "started_at");
      const ended = readNullableString(row, "ended_at");
      const seconds = started ? Math.ceil((Math.min(ended ? Date.parse(ended) : nowMs, nowMs) - Date.parse(started)) / 1000) : 0;
      const usage = { ...emptyUsage(), runCount: 1, reservedTokens: Number(row.reserved_tokens ?? 0),
        elapsedSeconds: Number.isFinite(seconds) ? Math.max(0, seconds) : 0 };
      current = { id, stepId: readString(row, "step_id"), stageId: readNullableString(row, "stage_id"),
        threadId: readNullableString(row, "thread_id"), started: Boolean(started),
        settled: Boolean(ended) || ["succeeded", "failed", "cancelled"].includes(readString(row, "status")), usage,
        charges: new Map(Object.entries(parseJson(readNullableString(row, "by_attempt") ?? "{}") as Record<string, AttemptCharges>)),
        unresolved: row.unresolved === 1 };
    }
    const { usage } = current;
    if (row.event_type === "tool_start") usage.toolCalls++;
    if (row.event_type === "context_compaction_end" || row.event_type === "message_end") {
      const tokens = observedTokenTotal(parseJson(readNullableString(row, "usage_json") ?? "null"));
      const charge = current.charges.get(readNullableString(row, "event_attempt_id") ?? "");
      if (tokens !== undefined) {
        usage.observedTokens += tokens;
        if (charge) charge.eventTokens = (charge.eventTokens ?? 0) + tokens;
      } else if (charge?.noDispatch !== 1) usage.partial = true;
    }
  }
  collect();

  return { total: projectUsage(total),
    byStage: new Map([...byStage].map(([id, usage]) => [id, projectUsage(usage)])),
    byStep: new Map([...byStep].map(([id, usage]) => [id, projectUsage(usage)])),
    ...(goal ? { goalBudget: projectGoalBudget(goal, goalCharges) } : {}),
  };
}

function addUsage(target: Usage, source: Usage): void {
  target.runCount += source.runCount;
  target.observedTokens += source.observedTokens;
  target.reservedTokens += source.reservedTokens;
  target.toolCalls += source.toolCalls;
  target.elapsedSeconds += source.elapsedSeconds;
  target.partial ||= source.partial;
  target.settledWithoutUsage ||= source.settledWithoutUsage;
}

function observedTokenTotal(value: unknown): number | undefined {
  if (!isJsonRecord(value)) return undefined;
  const usage = value as unknown as RunTokenUsageEvidence;
  const { input, output, cacheRead, cacheWrite, totalTokens } = usage;
  if (![input, output, cacheRead, cacheWrite, totalTokens].every(count => Number.isSafeInteger(count) && count >= 0)
    || totalTokens === 0 || input + output + cacheRead + cacheWrite !== totalTokens) return undefined;
  return totalTokens;
}

function projectGoalBudget(goal: LingThreadGoal, usage: Usage): LingAppServerWorkflowGoalBudget {
  const { id: goalId, tokenBudget } = goal;
  const maxTimeSeconds = goal.supervisionPolicy?.maxTimeSeconds;
  const accountedTokens = goal.tokensUsed + usage.observedTokens;
  const availableTokens = tokenBudget === undefined ? undefined : Math.max(0, tokenBudget - accountedTokens - usage.reservedTokens);
  const timeUsedSeconds = goal.timeUsedSeconds + usage.elapsedSeconds;
  let blocker: LingAppServerWorkflowGoalBudget["blocker"];
  if (availableTokens === 0) blocker = "work_item_goal_token_budget_exhausted";
  else if (maxTimeSeconds !== undefined && timeUsedSeconds >= maxTimeSeconds) blocker = "work_item_goal_time_budget_exhausted";
  else if (tokenBudget !== undefined && usage.settledWithoutUsage) blocker = "work_item_goal_usage_unconfirmed";
  return { goalId, tokenBudget, maxTimeSeconds, accountedTokens, timeUsedSeconds, blocker,
    ...(usage.reservedTokens ? { reservedTokens: usage.reservedTokens } : {}),
    ...(availableTokens !== undefined && !usage.partial ? { tokensRemaining: availableTokens } : {}),
  };
}
