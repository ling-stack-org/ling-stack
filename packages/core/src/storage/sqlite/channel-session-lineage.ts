/** Internal SQL fragments use only fixed aliases supplied by stores, never request text. */
export function channelSessionThreadLineageSql(threadId: string): string {
  // UNION (rather than UNION ALL) makes malformed topic/workflow cycles finite.
  // Only topics inherit parent ownership. A true fork is its own conversation.
  return `WITH RECURSIVE session_lineage(id, workspace_id, channel_id) AS (
    SELECT seed.id, seed.workspace_id, seed.channel_id FROM ling_threads seed WHERE seed.id = ${threadId}
    UNION
    SELECT parent.id, parent.workspace_id, parent.channel_id FROM session_lineage lineage
      JOIN ling_threads child ON child.id = lineage.id
      JOIN ling_threads parent ON parent.id = child.parent_thread_id
        AND parent.workspace_id = lineage.workspace_id AND parent.channel_id = lineage.channel_id
      WHERE child.surface_kind = 'topic'
    UNION
    SELECT source.id, source.workspace_id, source.channel_id FROM session_lineage lineage
      JOIN ling_threads execution ON execution.id = lineage.id
      JOIN channel_workflows workflow ON workflow.workspace_id = lineage.workspace_id AND workflow.channel_id = lineage.channel_id
        AND (workflow.id = execution.workflow_id OR EXISTS (SELECT 1 FROM channel_workflow_steps step
          WHERE step.workflow_id = workflow.id AND step.workspace_id = lineage.workspace_id AND step.channel_id = lineage.channel_id
            AND (step.id = execution.workflow_step_id OR step.task_id = execution.task_id)))
      LEFT JOIN ling_turns source_turn ON source_turn.id = json_extract(workflow.metadata_json, '$.sourceTurnId')
        AND source_turn.workspace_id = lineage.workspace_id AND source_turn.channel_id = lineage.channel_id
      LEFT JOIN conversation_items source_item ON source_item.id = json_extract(workflow.metadata_json, '$.sourceMessageId')
        AND source_item.workspace_id = lineage.workspace_id AND source_item.channel_id = lineage.channel_id
      JOIN ling_threads source ON source.id IN (source_turn.thread_id, source_item.thread_id)
        AND source.workspace_id = lineage.workspace_id AND source.channel_id = lineage.channel_id
      WHERE execution.surface_kind NOT IN ('channel_root','channel_session','branch')
  )`;
}

export function channelSessionThreadSourceSql(threadId: string, sourceThreadId: string): string {
  return `EXISTS (${channelSessionThreadLineageSql(threadId)} SELECT 1 FROM session_lineage WHERE id = ${sourceThreadId})`;
}

/** A topic must reach a non-topic parent within its own durable scope. */
export function channelSessionTopicLineageValidSql(threadId: string): string {
  return `EXISTS (WITH RECURSIVE topic_lineage(id, workspace_id, channel_id, surface_kind, parent_thread_id) AS (
    SELECT id, workspace_id, channel_id, surface_kind, parent_thread_id FROM ling_threads WHERE id = ${threadId}
    UNION
    SELECT parent.id, parent.workspace_id, parent.channel_id, parent.surface_kind, parent.parent_thread_id
      FROM topic_lineage child JOIN ling_threads parent ON parent.id = child.parent_thread_id
        AND parent.workspace_id = child.workspace_id AND parent.channel_id = child.channel_id
      WHERE child.surface_kind = 'topic'
  ) SELECT 1 FROM topic_lineage WHERE surface_kind != 'topic')`;
}

export function channelSessionScopeSql(object: string, threadId: string): string {
  return `EXISTS (SELECT 1 FROM ling_threads scope WHERE scope.id = ${threadId}
    AND scope.workspace_id = ${object}.workspace_id AND ( ${object}.channel_id IS NULL OR scope.channel_id = ${object}.channel_id))`;
}

export function channelSessionWorkflowSourceSql(workflow: string, threadId: string): string {
  return `EXISTS (SELECT 1 FROM ling_threads workflow_source
    LEFT JOIN ling_turns workflow_source_turn ON workflow_source_turn.id = json_extract(${workflow}.metadata_json, '$.sourceTurnId')
      AND workflow_source_turn.thread_id = workflow_source.id AND workflow_source_turn.workspace_id = ${workflow}.workspace_id
      AND workflow_source_turn.channel_id = ${workflow}.channel_id
    LEFT JOIN conversation_items workflow_source_item ON workflow_source_item.id = json_extract(${workflow}.metadata_json, '$.sourceMessageId')
      AND workflow_source_item.thread_id = workflow_source.id AND workflow_source_item.workspace_id = ${workflow}.workspace_id
      AND workflow_source_item.channel_id = ${workflow}.channel_id
    WHERE workflow_source.workspace_id = ${workflow}.workspace_id AND workflow_source.channel_id = ${workflow}.channel_id
      AND (workflow_source_turn.id IS NOT NULL OR workflow_source_item.id IS NOT NULL)
      AND ${channelSessionThreadSourceSql("workflow_source.id", threadId)})`;
}

export function channelSessionExecutionThreadSourceSql(executionThread: string, threadId: string): string {
  return channelSessionThreadSourceSql(`${executionThread}.id`, threadId);
}

export function channelSessionRunSourceSql(run: string, threadId: string): string {
  // Runs inherit workspace identity from their Thread or workflow Step.
  return `(EXISTS (SELECT 1 FROM ling_threads scope WHERE scope.id = ${threadId}
    AND (${run}.channel_id IS NULL OR scope.channel_id = ${run}.channel_id))
    AND (${channelSessionThreadSourceSql(`${run}.thread_id`, threadId)} OR EXISTS (
    SELECT 1 FROM channel_workflow_steps run_step JOIN channel_workflows run_workflow ON run_workflow.id = run_step.workflow_id
    WHERE run_step.id = ${run}.workflow_step_id AND run_step.channel_id = run_workflow.channel_id
      AND run_step.workspace_id = run_workflow.workspace_id
      AND ${channelSessionWorkflowSourceSql("run_workflow", threadId)})))`;
}

export function channelSessionWorkSourceSql(work: string, threadId: string): string {
  return `(${channelSessionScopeSql(work, threadId)} AND (
    (${work}.owner_type = 'ling_turn' AND EXISTS (SELECT 1 FROM ling_turns turn
      WHERE turn.id = ${work}.owner_id AND turn.workspace_id = ${work}.workspace_id
        AND ${channelSessionThreadSourceSql("turn.thread_id", threadId)}))
    OR EXISTS (SELECT 1 FROM run_sessions source WHERE ${channelSessionRunSourceSql("source", threadId)}
      AND (source.id = ${work}.linked_run_id OR (${work}.owner_type IN ('conversation_run','run') AND source.id = ${work}.owner_id)))
    OR EXISTS (SELECT 1 FROM conversation_items item WHERE item.id = ${work}.linked_message_id
      AND item.workspace_id = ${work}.workspace_id AND ${channelSessionThreadSourceSql("item.thread_id", threadId)})
    OR EXISTS (SELECT 1 FROM channel_workflow_steps step JOIN channel_workflows workflow ON workflow.id = step.workflow_id
      WHERE ${work}.owner_type = 'workflow_step' AND ${work}.owner_id = step.id
        AND step.workspace_id = ${work}.workspace_id AND step.channel_id = workflow.channel_id
        AND step.workspace_id = workflow.workspace_id AND ${channelSessionWorkflowSourceSql("workflow", threadId)})))`;
}

export function channelSessionApprovalSourceSql(approval: string, threadId: string): string {
  // Approvals have no workspace column; their durable Run/Work/Step/Item carries it.
  return `(EXISTS (SELECT 1 FROM ling_threads scope WHERE scope.id = ${threadId}
    AND (${approval}.channel_id IS NULL OR scope.channel_id = ${approval}.channel_id)) AND (
    EXISTS (SELECT 1 FROM run_sessions run WHERE run.id = ${approval}.run_id AND ${channelSessionRunSourceSql("run", threadId)})
    OR EXISTS (SELECT 1 FROM conversation_items item, json_each(item.domain_refs_json) ref
      WHERE item.visibility = 'channel'
        AND json_extract(ref.value, '$.type') = 'approval' AND json_extract(ref.value, '$.id') = ${approval}.id
        AND ${channelSessionThreadSourceSql("item.thread_id", threadId)})
    OR EXISTS (SELECT 1 FROM work_units work WHERE work.linked_media_job_id = ${approval}.media_job_id
      AND ${channelSessionWorkSourceSql("work", threadId)})
    OR EXISTS (SELECT 1 FROM channel_workflow_steps step JOIN channel_workflows workflow ON workflow.id = step.workflow_id
      LEFT JOIN run_sessions run ON run.id = step.run_id
      WHERE step.id = ${approval}.workflow_step_id
        AND step.channel_id = workflow.channel_id AND step.workspace_id = workflow.workspace_id
        AND (${channelSessionRunSourceSql("run", threadId)} OR ${channelSessionWorkflowSourceSql("workflow", threadId)}))))`;
}

export function channelSessionInputWaitSourceSql(wait: string, threadId: string): string {
  return `(EXISTS (SELECT 1 FROM ling_threads scope WHERE scope.id = ${threadId} AND scope.workspace_id = ${wait}.workspace_id)
    AND (${channelSessionThreadSourceSql(`${wait}.thread_id`, threadId)} OR EXISTS (SELECT 1 FROM run_sessions waiting_run
      WHERE waiting_run.id = ${wait}.source_run_id AND ${channelSessionRunSourceSql("waiting_run", threadId)})))`;
}
