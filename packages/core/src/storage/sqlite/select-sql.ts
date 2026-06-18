export function runInterventionSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      source_run_id,
      source_work_unit_id,
      source_attempt_id,
      continuation_run_id,
      continuation_work_unit_id,
      mode,
      status,
      instruction,
      message_payload_json,
      requested_by,
      idempotency_key,
      created_at,
      updated_at,
      started_at,
      completed_at,
      failure_reason
    FROM run_interventions
    ${whereClause}
  `;
}

export function runSessionSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      status,
      cwd,
      task_id,
      channel_id,
      teammate_id,
      workflow_step_id,
      selected_skill_id,
      provider_preset_id,
      provider_name,
      provider_model,
      task_snapshot_json,
      provider_snapshot_json,
      request_snapshot_json,
      event_log_path,
      thread_id,
      work_unit_id,
      parent_run_id,
      intervention_id,
      continuation_reason,
      summary_path,
      error_message,
      created_at,
      started_at,
      ended_at,
      updated_at
    FROM run_sessions
    ${whereClause}
  `;
}

export function lingThreadSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      kind,
      channel_id,
      task_id,
      teammate_id,
      workflow_id,
      workflow_step_id,
      external_work_id,
      title,
      objective,
      status,
      active_run_id,
      last_run_id,
      parent_thread_id,
      parent_turn_id,
      forked_from_run_id,
      metadata_json,
      created_at,
      updated_at,
      pinned_at,
      archived_at,
      archived_reason
    FROM ling_threads
    ${whereClause}
  `;
}

export function lingTurnSelectSql(whereClause: string): string {
  return `
    SELECT
      ling_turns.id,
      ling_turns.workspace_id,
      ling_turns.thread_id,
      ling_turns.kind,
      ling_turns.status,
      ling_turns.title,
      ling_turns.user_instruction,
      ling_turns.channel_id,
      ling_turns.task_id,
      ling_turns.teammate_id,
      ling_turns.workflow_step_id,
      ling_turns.external_work_id,
      ling_turns.automation_id,
      ling_turns.source_message_id,
      ling_turns.source_turn_id,
      ling_turns.intervention_id,
      ling_turns.active_run_id,
      ling_turns.last_run_id,
      ling_turns.created_by_actor,
      ling_turns.created_at,
      ling_turns.updated_at,
      ling_turns.completed_at
    FROM ling_turns
    ${whereClause}
  `;
}

export function automationDefinitionSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      thread_id,
      automation_mode,
      title,
      description,
      kind,
      status,
      trigger_json,
      rrule,
      cwds_json,
      target_thread_id,
      execution_environment,
      reasoning_effort,
      model,
      target_json,
      prompt_template_json,
      execution_policy_json,
      output_policy_json,
      created_at,
      updated_at,
      last_run_id,
      next_run_at,
      last_error_message
    FROM automation_definitions
    ${whereClause}
  `;
}

export function automationDraftSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      source,
      status,
      draft_json,
      missing_fields_json,
      warnings_json,
      proposed_by_run_id,
      proposed_by_thread_id,
      confirmed_automation_id,
      discarded_at,
      created_at,
      updated_at
    FROM automation_drafts
    ${whereClause}
  `;
}

export function automationRunSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      automation_id,
      workspace_id,
      channel_id,
      thread_id,
      run_id,
      trigger_type,
      scheduled_for,
      fired_at,
      started_at,
      completed_at,
      status,
      idempotency_key,
      context_preview_artifact_id,
      output_artifact_ids_json,
      skip_reason,
      error_message
    FROM automation_runs
    ${whereClause}
  `;
}

export function channelSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      name,
      status,
      bound_path,
      default_provider_preset_id,
      default_teammate_id,
      auto_reply_mode,
      response_language,
      allowed_tools_json,
      runtime_policy_json,
      workspace_binding_json,
      created_at,
      updated_at
    FROM channels
    ${whereClause}
  `;
}

export function channelBranchSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      name,
      status,
      created_at,
      updated_at,
      archived_at,
      deleted_at
    FROM channel_branches
    ${whereClause}
  `;
}

export function stateTransitionSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      entity_type,
      entity_id,
      from_status,
      to_status,
      event,
      actor,
      reason,
      idempotency_key,
      created_at
    FROM state_transition_events
    ${whereClause}
  `;
}

export function resourceLeaseSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      resource_type,
      resource_key,
      owner_type,
      owner_id,
      status,
      acquired_at,
      expires_at,
      last_renewed_at,
      released_at,
      release_reason,
      work_unit_id,
      attempt_id
    FROM resource_leases
    ${whereClause}
  `;
}

export function workUnitSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      kind,
      owner_type,
      owner_id,
      channel_id,
      task_id,
      teammate_id,
      provider_preset_id,
      runner_id,
      requested_runner_id,
      effective_runner_id,
      runner_fallback_reason_json,
      idempotency_key,
      status,
      priority,
      attempt_count,
      active_attempt_id,
      created_by_client_id,
      created_by_actor,
      request_json,
      timeout_policy_json,
      linked_run_id,
      linked_message_id,
      linked_media_job_id,
      linked_external_work_id,
      created_at,
      updated_at,
      started_at,
      ended_at,
      last_event_at,
      last_heartbeat_at,
      error_code,
      error_message
    FROM work_units
    ${whereClause}
  `;
}

export function controlPlaneEventSelectSql(whereClause: string): string {
  return `
    SELECT
      seq,
      workspace_id,
      cwd,
      ts,
      domain,
      entity_type,
      entity_id,
      action,
      data_json
    FROM control_plane_events
    ${whereClause}
  `;
}

export function workUnitAttemptSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      work_unit_id,
      attempt_number,
      runtime_instance_id,
      runner_id,
      requested_runner_id,
      effective_runner_id,
      runner_fallback_reason_json,
      provider_preset_id,
      status,
      created_at,
      started_at,
      ended_at,
      last_event_at,
      last_heartbeat_at,
      abort_requested_at,
      error_code,
      error_message
    FROM work_unit_attempts
    ${whereClause}
  `;
}

export function runtimeEventSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      work_unit_id,
      attempt_id,
      seq,
      ts,
      type,
      actor,
      data_json
    FROM runtime_events
    ${whereClause}
  `;
}

export function runtimeSemaphoreSlotSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      resource_type,
      resource_key,
      owner_type,
      owner_id,
      work_unit_id,
      attempt_id,
      status,
      acquired_at,
      last_renewed_at,
      expires_at,
      released_at,
      release_reason
    FROM runtime_semaphore_slots
    ${whereClause}
  `;
}

export function taskSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      title,
      prompt,
      status,
      assignee_teammate_id,
      requested_skill_id,
      current_run_id,
      created_at,
      updated_at
    FROM tasks
    ${whereClause}
  `;
}

export function aiTeammateSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      template_id,
      role_key,
      display_name,
      description,
      avatar_tone,
      avatar_image_attachment_id,
      provider_preset_id,
      runner_id,
      system_prompt,
      append_system_prompt_json,
      allowed_tools_json,
      approval_profile_json,
      status,
      pinned,
      hidden,
      created_at,
      updated_at
    FROM ai_teammates
    ${whereClause}
  `;
}

export function teammateChannelMembershipSelectSql(whereClause: string): string {
  return `
    SELECT
      teammate_id,
      channel_id,
      is_default,
      created_at,
      updated_at
    FROM teammate_channel_memberships
    ${whereClause}
  `;
}

export function teammateSkillBindingSelectSql(whereClause: string): string {
  return `
    SELECT
      teammate_id,
      skill_id,
      source,
      enabled,
      created_at,
      updated_at
    FROM teammate_skill_bindings
    ${whereClause}
  `;
}

export function skillRegistryEntrySelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      pack_id,
      source,
      source_path,
      version,
      checksum,
      definition_json,
      visibility_json,
      review_status,
      created_at,
      updated_at
    FROM skill_definitions
    ${whereClause}
  `;
}

export function skillImportDraftSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      source,
      source_path,
      draft_json,
      warnings_json,
      created_at,
      updated_at
    FROM skill_import_drafts
    ${whereClause}
  `;
}

export function teammateMemoryScopeSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      teammate_id,
      kind,
      channel_id,
      enabled,
      created_at,
      updated_at
    FROM teammate_memory_scopes
    ${whereClause}
  `;
}

export function memoryObjectSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      scope_type,
      owner_id,
      title,
      body,
      tags_json,
      source_refs_json,
      review_state,
      enabled,
      sensitivity,
      verify_before_use,
      retrieval_provider_id,
      retrieval_handle,
      created_by,
      created_at,
      updated_at,
      last_used_at
    FROM memory_objects
    ${whereClause}
  `;
}

export function memorySelfImprovingMetadataSelectSql(whereClause: string): string {
  return `
    SELECT
      memory_id,
      kind,
      trigger,
      lesson,
      use_when_json,
      do_not_use_when_json,
      valid_until,
      last_seen_at,
      evidence_count,
      superseded_by,
      last_used_at,
      use_count
    FROM memory_self_improving_metadata
    ${whereClause}
  `;
}

export function memoryConsolidationJobSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      kind,
      source_refs_json,
      status,
      created_candidate_ids_json,
      error_message,
      created_at,
      updated_at
    FROM memory_consolidation_jobs
    ${whereClause}
  `;
}

export function memoryUsedEventSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      memory_ids_json,
      intent,
      recall_query,
      teammate_id,
      channel_id,
      task_id,
      run_id,
      response_id,
      policy_version,
      created_at
    FROM memory_used_events
    ${whereClause}
  `;
}

export function memoryReviewDecisionSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      memory_id,
      outcome,
      mode,
      reason_code,
      reason,
      confidence,
      requires_manual_review,
      quarantine_reason,
      target_review_state,
      target_sensitivity,
      source_refs_json,
      decided_by,
      created_at
    FROM memory_review_decisions
    ${whereClause}
  `;
}

export function teammateDirectThreadSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      teammate_id,
      title,
      workspace_binding_json,
      created_at,
      updated_at
    FROM teammate_direct_threads
    ${whereClause}
  `;
}

export function teammateDirectMessageSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      thread_id,
      teammate_id,
      author_type,
      author_id,
      body,
      attachment_ids_json,
      link_preview_ids_json,
      file_refs_json,
      status,
      error_message,
      linked_task_id,
      linked_run_id,
      created_at,
      updated_at
    FROM teammate_direct_messages
    ${whereClause}
  `;
}

export function teammateDirectLinkPreviewSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      teammate_id,
      thread_id,
      message_id,
      url,
      normalized_url,
      title,
      description,
      image_url,
      site_name,
      status,
      error_message,
      created_at,
      updated_at
    FROM teammate_direct_link_previews
    ${whereClause}
  `;
}

export function teammateDirectReplyInterventionSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      teammate_id,
      thread_id,
      source_message_id,
      source_work_unit_id,
      mode,
      status,
      instruction,
      message_payload_json,
      idempotency_key,
      requested_by,
      continuation_message_id,
      continuation_work_unit_id,
      created_at,
      updated_at,
      started_at,
      completed_at,
      failure_reason
    FROM teammate_direct_reply_interventions
    ${whereClause}
  `;
}

export function teammatePrivateAttachmentSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      teammate_id,
      thread_id,
      message_id,
      scope,
      kind,
      file_name,
      content_type,
      size_bytes,
      path,
      created_at
    FROM teammate_private_attachments
    ${whereClause}
  `;
}

export function channelMessageSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      thread_id,
      kind,
      intent,
      author_type,
      author_id,
      body,
      mentions_json,
      attachment_ids_json,
      link_preview_ids_json,
      file_refs_json,
      linked_task_id,
      linked_run_id,
      status,
      error_message,
      created_at,
      updated_at
    FROM channel_messages
    ${whereClause}
  `;
}

export function channelMessageRouteDecisionSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      schema_version,
      workspace_id,
      channel_id,
      source_message_id,
      reply_message_id,
      mode,
      action,
      selected_teammate_id,
      selected_provider_preset_id,
      confidence,
      reason,
      alternatives_json,
      context_pack_json,
      status,
      created_by,
      error_message,
      created_at,
      updated_at
    FROM channel_message_route_decisions
    ${whereClause}
  `;
}

export function channelIntentDecisionSelectSql(whereClause: string): string {
  return `
    SELECT
      schema_version,
      id,
      workspace_id,
      channel_id,
      source_message_id,
      action,
      selected_teammate_id,
      selected_teammate_ids_json,
      proposal_id,
      reply_message_id,
      reply_message_ids_json,
      workflow_id,
      reason,
      status,
      created_by,
      error_message,
      created_at,
      updated_at
    FROM channel_intent_decisions
    ${whereClause}
  `;
}

export function channelExecutionProposalSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      source_message_id,
      proposed_by_teammate_id,
      title,
      prompt,
      assignee_teammate_id,
      acceptance_criteria_json,
      collaboration_steps_json,
      required_tools_json,
      risk_summary,
      response_language,
      shaping_json,
      status,
      linked_task_id,
      linked_run_id,
      linked_workflow_id,
      error_message,
      created_at,
      updated_at
    FROM channel_execution_proposals
    ${whereClause}
  `;
}

export function channelAttachmentSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      message_id,
      kind,
      file_name,
      content_type,
      size_bytes,
      path,
      created_at
    FROM channel_attachments
    ${whereClause}
  `;
}

export function channelLinkPreviewSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      message_id,
      url,
      normalized_url,
      title,
      description,
      image_url,
      site_name,
      status,
      error_message,
      created_at,
      updated_at
    FROM channel_link_previews
    ${whereClause}
  `;
}

export function channelInputMaterializationSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      source_kind,
      source_id,
      source_fingerprint,
      extractor_id,
      extractor_version,
      content_kind,
      status,
      content_text,
      structured_summary_json,
      byte_count,
      token_estimate,
      truncated,
      policy_decision_json,
      error_code,
      error_message,
      created_at,
      updated_at,
      expires_at
    FROM channel_input_materializations
    ${whereClause}
  `;
}

export function channelBriefSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      objective,
      scope,
      acceptance_criteria_json,
      open_questions_json,
      risks_json,
      decision_ids_json,
      attachment_ids_json,
      link_preview_ids_json,
      updated_by,
      created_at,
      updated_at
    FROM channel_briefs
    ${whereClause}
  `;
}

export function channelDecisionSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      source_message_id,
      source_task_id,
      source_run_id,
      title,
      decision,
      rationale,
      alternatives_json,
      status,
      supersedes_decision_id,
      created_by,
      created_at,
      updated_at
    FROM channel_decisions
    ${whereClause}
  `;
}

export function channelHandoffSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      source_message_id,
      source_task_id,
      source_run_id,
      from_participant_id,
      from_participant_label,
      to_participant_id,
      to_participant_label,
      reason,
      required_input,
      expected_output,
      status,
      created_by,
      created_at,
      updated_at
    FROM channel_handoffs
    ${whereClause}
  `;
}

export function workflowHandoffIntentSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      workflow_id,
      source_workflow_step_id,
      source_run_id,
      source_message_id,
      channel_handoff_id,
      from_participant_id,
      from_participant_label,
      to_participant_id,
      to_participant_label,
      reason,
      required_input,
      expected_output,
      risk_summary,
      source_refs_json,
      status,
      validation_json,
      created_by,
      created_at,
      updated_at
    FROM workflow_handoff_intents
    ${whereClause}
  `;
}

export function workflowSelectorDecisionSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      workflow_id,
      source_workflow_step_id,
      selector_node_id,
      target_kind,
      selected_workflow_step_id,
      selected_graph_node_id,
      selected_teammate_id,
      selected_skill_id,
      selected_handoff_intent_id,
      reason,
      alternatives_json,
      confidence,
      requires_user_confirmation,
      status,
      source_refs_json,
      created_by,
      created_at,
      updated_at
    FROM workflow_selector_decisions
    ${whereClause}
  `;
}

export function channelContextSummarySelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      target_type,
      target_id,
      source_message_ids_json,
      decision_ids_json,
      summary,
      acceptance_criteria_json,
      open_questions_json,
      author_type,
      author_id,
      created_at,
      updated_at
    FROM channel_context_summaries
    ${whereClause}
  `;
}

export function channelCollaborationProtocolOverrideSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      version,
      default_workflow_preference,
      visible_multi_reply_max_participants,
      privacy_rules_json,
      review_rules_json,
      source_refs_json,
      updated_by,
      created_at,
      updated_at
    FROM channel_collaboration_protocols
    ${whereClause}
  `;
}

export function channelCollaborationProtocolDraftSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      base_version,
      proposed_patch_json,
      reason,
      created_by,
      source_refs_json,
      status,
      applied_protocol_version,
      expires_at,
      created_at,
      updated_at
    FROM channel_collaboration_protocol_drafts
    ${whereClause}
  `;
}

export function channelWorkflowSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      source_handoff_id,
      title,
      objective,
      status,
      created_by,
      metadata_json,
      created_at,
      updated_at
    FROM channel_workflows
    ${whereClause}
  `;
}

export function channelWorkflowStepSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      workflow_id,
      source_handoff_id,
      context_summary_id,
      task_id,
      run_id,
      position,
      title,
      prompt,
      to_participant_id,
      to_participant_label,
      status,
      blocker,
      result_summary,
      metadata_json,
      created_at,
      updated_at
    FROM channel_workflow_steps
    ${whereClause}
  `;
}

export function providerPresetSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      kind,
      display_name,
      provider_id,
      model,
      api,
      provider_transport,
      base_url,
      api_key_ref,
      headers_json,
      auth_header,
      reasoning,
      input_json,
      context_window,
      max_tokens,
      compat_json,
      capabilities_json,
      enabled,
      last_check_json,
      created_at,
      updated_at
    FROM provider_presets
    ${whereClause}
  `;
}

export function approvalRequestSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      run_id,
      task_id,
      media_job_id,
      external_work_action_id,
      workflow_step_id,
      channel_id,
      tool_call_id,
      action_type,
      risk,
      title,
      description,
      payload_json,
      status,
      created_at,
      expires_at,
      resolved_at,
      resolved_by,
      decision_reason
    FROM approval_requests
    ${whereClause}
  `;
}

export function mcpServerSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      display_name,
      transport_json,
      enabled,
      required,
      status_json,
      startup_timeout_sec,
      tool_timeout_sec,
      enabled_tools_json,
      disabled_tools_json,
      created_at,
      updated_at
    FROM mcp_servers
    ${whereClause}
  `;
}

export function mcpToolSelectSql(whereClause: string): string {
  return `
    SELECT
      server_id,
      raw_name,
      display_name,
      description,
      input_schema_json,
      callable_namespace,
      callable_name,
      side_effect_level,
      default_approval,
      enabled,
      first_seen_at,
      last_seen_at,
      updated_at
    FROM mcp_tools
    ${whereClause}
  `;
}

export function teammateMcpBindingSelectSql(whereClause: string): string {
  return `
    SELECT
      teammate_id,
      server_id,
      mode,
      selected_tool_names_json,
      approval_overrides_json,
      enabled,
      created_at,
      updated_at
    FROM teammate_mcp_bindings
    ${whereClause}
  `;
}

export function managedPluginSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      source_kind,
      version,
      enabled,
      disabled_reason,
      descriptor_json,
      created_at,
      updated_at
    FROM managed_plugins
    ${whereClause}
  `;
}

export function managedPluginContributionSelectSql(whereClause: string): string {
  return `
    SELECT
      plugin_id,
      contribution_kind,
      contribution_id,
      linked_resource_id,
      enabled,
      created_at,
      updated_at
    FROM managed_plugin_contributions
    ${whereClause}
  `;
}

export function managedPluginEventSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      plugin_id,
      type,
      actor,
      message,
      data_json,
      created_at
    FROM managed_plugin_events
    ${whereClause}
  `;
}

export function managedPluginPackageSelectSql(whereClause: string): string {
  return `
    SELECT
      plugin_id,
      source_kind,
      version,
      status,
      cache_ref,
      package_hash,
      manifest_json,
      installed_at,
      updated_at,
      uninstalled_at
    FROM managed_plugin_packages
    ${whereClause}
  `;
}

export function managedPluginRuntimeSnapshotSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      run_id,
      cwd,
      plugin_ids_json,
      capabilities_json,
      policy_overlays_json,
      created_at
    FROM managed_plugin_runtime_snapshots
    ${whereClause}
  `;
}

export function approvalPolicySelectSql(whereClause: string): string {
  return `
    SELECT
      workspace_id,
      tool_decisions_json,
      allowed_write_paths_json,
      created_at,
      updated_at
    FROM approval_policies
    ${whereClause}
  `;
}

export function artifactSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      run_id,
      media_job_id,
      external_work_id,
      type,
      path,
      title,
      content_type,
      size_bytes,
      created_at
    FROM artifacts
    ${whereClause}
  `;
}

export function externalWorkSelectSql(whereClause: string): string {
  return `
    SELECT
      ${externalWorkSelectColumnsFromAlias("")}
    FROM external_work_items
    ${whereClause}
  `;
}

export function externalWorkSelectColumnsFromAlias(alias: string): string {
  const prefix = alias ? `${alias}.` : "";
  return `
      ${prefix}id,
      ${prefix}workspace_id,
      ${prefix}channel_id,
      ${prefix}source_kind,
      ${prefix}work_item_kind,
      ${prefix}external_id,
      ${prefix}identifier,
      ${prefix}idempotency_key,
      ${prefix}workflow_id,
      ${prefix}workflow_step_id,
      ${prefix}artifact_ids_json,
      ${prefix}item_json,
      ${prefix}created_at,
      ${prefix}updated_at
  `;
}

export function workItemSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      source_type,
      source_id,
      title,
      description,
      status,
      waiting_reason,
      priority,
      labels_json,
      assignee_teammate_id,
      task_id,
      run_id,
      workflow_id,
      workflow_step_id,
      external_work_id,
      external_work_action_id,
      approval_id,
      artifact_ids_json,
      proof_artifact_ids_json,
      claim_owner_id,
      claim_token,
      claimed_at,
      heartbeat_at,
      claim_expires_at,
      attempt_count,
      retry_budget,
      completed_at,
      failed_at,
      failure_reason,
      created_at,
      updated_at
    FROM work_items
    ${whereClause}
  `;
}

export function externalWorkSchedulerStateSelectSql(whereClause: string): string {
  return `
    SELECT
      external_work_id,
      workspace_id,
      channel_id,
      subject_key,
      source_key,
      workflow_id,
      workflow_step_id,
      scheduler_status,
      attempt_count,
      last_attempt_at,
      next_attempt_at,
      max_retry_backoff_ms,
      last_error_code,
      last_error_message,
      workspace_path,
      workspace_mode,
      hook_artifact_ids_json,
      last_reconciled_at,
      created_at,
      updated_at
    FROM external_work_scheduler_state
    ${whereClause}
  `;
}

export function externalWorkActionSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      external_work_id,
      source_kind,
      action_kind,
      status,
      approval_id,
      idempotency_key,
      target_json,
      payload_json,
      approval_requirement,
      artifact_ids_json,
      execution_attempt_count,
      last_attempt_at,
      next_attempt_at,
      last_error_code,
      last_error_message,
      created_at,
      updated_at,
      executed_at
    FROM external_work_actions
    ${whereClause}
  `;
}

export function externalWorkCiTriageSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      external_work_id,
      source_kind,
      repository,
      subject_kind,
      subject_number,
      head_sha,
      failure_key,
      status,
      check_name,
      workflow_name,
      job_name,
      conclusion,
      html_url,
      first_failing_command,
      reproduction_command,
      suspected_source_path,
      task_id,
      run_id,
      artifact_ids_json,
      failure_json,
      last_error_code,
      last_error_message,
      created_at,
      updated_at
    FROM external_work_ci_triage
    ${whereClause}
  `;
}

export function mediaJobSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      provider_preset_id,
      operation,
      prompt,
      input_json,
      artifact_ids_json,
      status,
      error_message,
      created_at,
      updated_at
    FROM media_jobs
    ${whereClause}
  `;
}
