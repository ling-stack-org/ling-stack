import type { LingAppServerWorkflowGoalBudget, LingAppServerWorkflowUsage, RunTokenUsageEvidence } from "@ling-stack/contracts";
import type { LingThreadGoal } from "../../run-types.js";
import type { WorkItem, WorkItemWorkflowUsage } from "../../work-item-types.js";
import { isJsonRecord, parseJson, readNullableString, readString } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

interface Usage {
  runCount: number;
  observedTokens: number;
  toolCalls: number;
  elapsedSeconds: number;
  partial: boolean;
  settledWithoutUsage: boolean;
}

function emptyUsage(): Usage {
  return { runCount: 0, observedTokens: 0, toolCalls: 0, elapsedSeconds: 0, partial: false, settledWithoutUsage: false };
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
      WHERE link.workspace_id=? AND link.kind='work_item_workflow'
        AND json_extract(link.payload_json, '$.binding.workItemId')=?
    )
    SELECT r.*, e.type AS event_type,
      CASE WHEN e.type IN ('message_end','context_compaction_end') AND json_type(e.data_json,'$.usage')='object'
        THEN json_extract(e.data_json,'$.usage') END AS usage_json
    FROM owned_runs r
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
    readonly started: boolean; readonly settled: boolean; readonly usage: Usage } | undefined;

  const collect = () => {
    if (!current) return;
    const { usage, settled, started, stepId, stageId, threadId } = current;
    const missingUsage = usage.partial || started && usage.observedTokens === 0;
    usage.partial = missingUsage || started && !settled;
    usage.settledWithoutUsage = settled && missingUsage;
    addUsage(total, usage);
    if (goal && (threadId !== goal.threadId || !accountedRunIds.has(current.id))) addUsage(goalCharges, usage);
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
      const usage = { ...emptyUsage(), runCount: 1, elapsedSeconds: Number.isFinite(seconds) ? Math.max(0, seconds) : 0 };
      current = { id, stepId: readString(row, "step_id"), stageId: readNullableString(row, "stage_id"),
        threadId: readNullableString(row, "thread_id"), started: Boolean(started),
        settled: Boolean(ended) || ["succeeded", "failed", "cancelled"].includes(readString(row, "status")), usage };
    }
    const { usage } = current;
    if (row.event_type === "tool_start") usage.toolCalls++;
    if (row.event_type === "context_compaction_end" || row.event_type === "message_end") {
      const tokens = observedTokenTotal(parseJson(readNullableString(row, "usage_json") ?? "null"));
      if (tokens === undefined) usage.partial = true;
      else usage.observedTokens += tokens;
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
  const timeUsedSeconds = goal.timeUsedSeconds + usage.elapsedSeconds;
  let blocker: LingAppServerWorkflowGoalBudget["blocker"];
  if (tokenBudget !== undefined && accountedTokens >= tokenBudget) blocker = "work_item_goal_token_budget_exhausted";
  else if (maxTimeSeconds !== undefined && timeUsedSeconds >= maxTimeSeconds) blocker = "work_item_goal_time_budget_exhausted";
  else if (tokenBudget !== undefined && usage.settledWithoutUsage) blocker = "work_item_goal_usage_unconfirmed";
  return { goalId, tokenBudget, maxTimeSeconds, accountedTokens, timeUsedSeconds, blocker,
    ...(tokenBudget !== undefined && !usage.partial ? { tokensRemaining: Math.max(0, tokenBudget - accountedTokens) } : {}),
  };
}
