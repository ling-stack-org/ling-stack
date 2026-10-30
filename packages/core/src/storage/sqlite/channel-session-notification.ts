/** Match persisted replacement visibility before publishing unread/activity watermarks. */
export function channelSessionNotificationEligibleSql(item: string): string {
  const hiddenResponse = `EXISTS (SELECT 1 FROM json_each(supersession.superseded_response_message_ids_json) hidden WHERE hidden.value = ${item}.id)`;
  const hiddenRun = `EXISTS (SELECT 1 FROM json_each(${item}.domain_refs_json) ref, json_each(supersession.superseded_run_ids_json) hidden_run
    WHERE json_extract(ref.value, '$.type') = 'run' AND json_extract(ref.value, '$.id') = hidden_run.value)`;
  const hiddenReportSource = `((json_extract(${item}.payload_json, '$.sourceKind') = 'turn'
      AND json_extract(${item}.payload_json, '$.sourceId') = supersession.superseded_turn_id)
    OR (json_extract(${item}.payload_json, '$.sourceKind') = 'run' AND EXISTS (
      SELECT 1 FROM json_each(supersession.superseded_run_ids_json) hidden_run
      WHERE hidden_run.value = json_extract(${item}.payload_json, '$.sourceId'))))`;
  // SQLite may reorder AND operands. CASE must exclude unrelated/private or corrupt
  // rows before any json_extract/json_each expression can inspect their content.
  return `(CASE WHEN ${item}.visibility != 'channel' OR ${item}.kind NOT IN ('user_message','assistant_message','terminal_report') THEN 0
    WHEN NOT json_valid(${item}.payload_json) OR NOT json_valid(${item}.domain_refs_json) THEN 0
    ELSE (${item}.kind = 'user_message' OR (
    NOT EXISTS (SELECT 1 FROM ling_turns notification_turn WHERE notification_turn.id = ${item}.turn_id AND notification_turn.status = 'superseded')
    AND NOT EXISTS (SELECT 1 FROM conversation_turn_supersessions supersession
      WHERE supersession.workspace_id = ${item}.workspace_id AND supersession.owner_id = ${item}.channel_id
        AND supersession.surface_kind IN ('channel_root','channel_branch','topic_reply')
        AND (${hiddenResponse} OR ${hiddenRun} OR (${item}.kind = 'terminal_report' AND ${hiddenReportSource}))))) END)`;
}
