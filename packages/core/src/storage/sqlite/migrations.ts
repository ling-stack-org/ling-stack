import type { DatabaseSync } from "node:sqlite";
import { normalizeChannelRuntimePolicy } from "../../workspace-types.js";
import { stringifyJson } from "./helpers.js";
import { removeLegacySkillWorkflowPhaseMetadata } from "./skill-capability-migration.js";
import { CONTINUITY_V2_STORAGE_MIGRATION_VERSION } from "./continuity-v2-migration.js";

export interface SqliteRunStoreMigrationContext {
  readonly database: DatabaseSync;
  hasMigration(version: number): boolean;
  hasColumn(tableName: string, columnName: string): boolean;
  hasTable(tableName: string): boolean;
  recordMigration(version: number, name: string): void;
}

const INITIAL_MIGRATION_VERSION = 1;
const INITIAL_MIGRATION_NAME = "create_run_sessions_and_events";
const PROVIDERS_MIGRATION_VERSION = 2;
const PROVIDERS_MIGRATION_NAME = "create_provider_presets";
const APPROVALS_MIGRATION_VERSION = 3;
const APPROVALS_MIGRATION_NAME = "create_approval_requests";
const WORKSPACE_MIGRATION_VERSION = 4;
const WORKSPACE_MIGRATION_NAME = "create_workspace_channels_tasks";
const APPROVAL_POLICY_MIGRATION_VERSION = 5;
const APPROVAL_POLICY_MIGRATION_NAME = "create_approval_policy";
const PROVIDER_CHECKS_MIGRATION_VERSION = 6;
const PROVIDER_CHECKS_MIGRATION_NAME = "add_provider_check_results";
const ARTIFACTS_MIGRATION_VERSION = 7;
const ARTIFACTS_MIGRATION_NAME = "create_artifacts";
const MEDIA_JOBS_MIGRATION_VERSION = 8;
const MEDIA_JOBS_MIGRATION_NAME = "create_media_jobs";
const MEDIA_JOB_ARTIFACTS_MIGRATION_VERSION = 9;
const MEDIA_JOB_ARTIFACTS_MIGRATION_NAME = "allow_media_job_artifacts";
const APPROVAL_MEDIA_JOB_OWNER_MIGRATION_VERSION = 10;
const APPROVAL_MEDIA_JOB_OWNER_MIGRATION_NAME = "allow_media_job_approval_owners";
const CHANNEL_RUNTIME_MIGRATION_VERSION = 11;
const CHANNEL_RUNTIME_MIGRATION_NAME = "add_channel_runtime_state_and_leases";
const PROVIDER_SECRETS_MIGRATION_VERSION = 12;
const PROVIDER_SECRETS_MIGRATION_NAME = "create_provider_secrets";
const CHANNEL_WORKSPACE_MIGRATION_VERSION = 13;
const CHANNEL_WORKSPACE_MIGRATION_NAME = "create_channel_workspace_assets";
const CHANNEL_PROTOCOL_MIGRATION_VERSION = 14;
const CHANNEL_PROTOCOL_MIGRATION_NAME = "create_channel_collaboration_protocol";
const CHANNEL_WORKFLOW_MIGRATION_VERSION = 15;
const CHANNEL_WORKFLOW_MIGRATION_NAME = "create_channel_handoff_workflows";
const AI_TEAMMATE_WORKSPACE_MIGRATION_VERSION = 16;
const AI_TEAMMATE_WORKSPACE_MIGRATION_NAME = "create_ai_teammate_private_workspace";
const EXTERNAL_WORK_MIGRATION_VERSION = 17;
const EXTERNAL_WORK_MIGRATION_NAME = "create_external_work_items";
const EXTERNAL_WORK_SCHEDULER_MIGRATION_VERSION = 18;
const EXTERNAL_WORK_SCHEDULER_MIGRATION_NAME = "create_external_work_scheduler_state";
const EXTERNAL_WORK_ACTIONS_MIGRATION_VERSION = 19;
const EXTERNAL_WORK_ACTIONS_MIGRATION_NAME = "create_external_work_actions";
const EXTERNAL_WORK_CI_TRIAGE_MIGRATION_VERSION = 20;
const EXTERNAL_WORK_CI_TRIAGE_MIGRATION_NAME = "create_external_work_ci_triage";
const CHANNEL_EXECUTION_PROPOSALS_MIGRATION_VERSION = 21;
const CHANNEL_EXECUTION_PROPOSALS_MIGRATION_NAME = "create_channel_execution_proposals";
const RUNTIME_SUPERVISOR_MIGRATION_VERSION = 22;
const RUNTIME_SUPERVISOR_MIGRATION_NAME = "create_runtime_supervisor";
const MCP_TOOL_MANAGEMENT_MIGRATION_VERSION = 23;
const MCP_TOOL_MANAGEMENT_MIGRATION_NAME = "create_mcp_tool_management";
const LING_MEMORY_MIGRATION_VERSION = 24;
const LING_MEMORY_MIGRATION_NAME = "create_ling_memory_v1";
const SKILL_AWARE_RUN_MIGRATION_VERSION = 25;
const SKILL_AWARE_RUN_MIGRATION_NAME = "add_skill_aware_tasks_and_runs";
const PRIVATE_WORKSPACE_DATA_LIFECYCLE_MIGRATION_VERSION = 26;
const PRIVATE_WORKSPACE_DATA_LIFECYCLE_MIGRATION_NAME = "create_private_workspace_data_lifecycle";
const SKILL_REGISTRY_MIGRATION_VERSION = 27;
const SKILL_REGISTRY_MIGRATION_NAME = "create_skill_registry";
const RUN_INTERVENTIONS_MIGRATION_VERSION = 28;
const RUN_INTERVENTIONS_MIGRATION_NAME = "create_run_interventions";
const RUNNER_AUDIT_MIGRATION_VERSION = 29;
const RUNNER_AUDIT_MIGRATION_NAME = "add_runner_audit_fields";
const CHANNEL_WORKFLOW_STEP_METADATA_MIGRATION_VERSION = 30;
const CHANNEL_WORKFLOW_STEP_METADATA_MIGRATION_NAME = "add_channel_workflow_step_metadata";
const LING_THREADS_MIGRATION_VERSION = 31;
const LING_THREADS_MIGRATION_NAME = "create_ling_threads";
const APPROVAL_WORKFLOW_STEP_OWNER_MIGRATION_VERSION = 32;
const APPROVAL_WORKFLOW_STEP_OWNER_MIGRATION_NAME = "allow_workflow_step_approval_owners";
const RUN_WORKFLOW_STEP_OWNER_MIGRATION_VERSION = 33;
const RUN_WORKFLOW_STEP_OWNER_MIGRATION_NAME = "add_run_workflow_step_owner";
const MCP_STATUS_SNAPSHOTS_MIGRATION_VERSION = 34;
const MCP_STATUS_SNAPSHOTS_MIGRATION_NAME = "create_mcp_status_snapshots";
const MEMORY_REVIEW_POLICY_MIGRATION_VERSION = 35;
const MEMORY_REVIEW_POLICY_MIGRATION_NAME = "create_memory_review_policy";
const MEMORY_CONSOLIDATION_JOBS_MIGRATION_VERSION = 36;
const MEMORY_CONSOLIDATION_JOBS_MIGRATION_NAME = "create_memory_consolidation_jobs";
const MANAGED_PLUGINS_MIGRATION_VERSION = 37;
const MANAGED_PLUGINS_MIGRATION_NAME = "create_managed_plugins";
const AUTOMATIONS_MIGRATION_VERSION = 38;
const AUTOMATIONS_MIGRATION_NAME = "create_automations";
const AUTOMATION_DRAFTS_MIGRATION_VERSION = 39;
const AUTOMATION_DRAFTS_MIGRATION_NAME = "create_automation_drafts";
const MEMORY_HEALTH_MIGRATION_VERSION = 40;
const MEMORY_HEALTH_MIGRATION_NAME = "add_memory_health_metadata";
const MANAGED_PLUGIN_PACKAGES_MIGRATION_VERSION = 41;
const MANAGED_PLUGIN_PACKAGES_MIGRATION_NAME = "create_managed_plugin_packages";
const CONTROL_PLANE_EVENTS_MIGRATION_VERSION = 42;
const CONTROL_PLANE_EVENTS_MIGRATION_NAME = "create_control_plane_events";
const WORK_ITEMS_MIGRATION_VERSION = 43;
const WORK_ITEMS_MIGRATION_NAME = "create_work_items";
const LING_TURNS_MIGRATION_VERSION = 44;
const LING_TURNS_MIGRATION_NAME = "create_ling_turns";
const LING_THREAD_METADATA_MIGRATION_VERSION = 45;
const LING_THREAD_METADATA_MIGRATION_NAME = "add_ling_thread_metadata";
const LING_THREAD_FORK_LINEAGE_MIGRATION_VERSION = 46;
const LING_THREAD_FORK_LINEAGE_MIGRATION_NAME = "add_ling_thread_fork_lineage";
const LING_THREAD_VISIBILITY_MIGRATION_VERSION = 47;
const LING_THREAD_VISIBILITY_MIGRATION_NAME = "add_ling_thread_visibility_fields";
const CHANNEL_WORKFLOW_METADATA_MIGRATION_VERSION = 48;
const CHANNEL_WORKFLOW_METADATA_MIGRATION_NAME = "add_channel_workflow_metadata";
const WORKFLOW_COORDINATION_RECORDS_MIGRATION_VERSION = 49;
const WORKFLOW_COORDINATION_RECORDS_MIGRATION_NAME = "create_workflow_coordination_records";
const CHANNEL_AUTO_REPLY_ROUTER_MIGRATION_VERSION = 50;
const CHANNEL_AUTO_REPLY_ROUTER_MIGRATION_NAME = "create_channel_auto_reply_router";
const TEAMMATE_DIRECT_REPLY_INTERVENTIONS_MIGRATION_VERSION = 51;
const TEAMMATE_DIRECT_REPLY_INTERVENTIONS_MIGRATION_NAME = "create_teammate_direct_reply_interventions";
const WORKSPACE_SETTINGS_AND_CHANNEL_BINDING_MIGRATION_VERSION = 52;
const WORKSPACE_SETTINGS_AND_CHANNEL_BINDING_MIGRATION_NAME = "create_workspace_settings_and_channel_binding";
const CHANNEL_EXECUTION_PROPOSAL_WORKFLOW_LINK_MIGRATION_VERSION = 53;
const CHANNEL_EXECUTION_PROPOSAL_WORKFLOW_LINK_MIGRATION_NAME = "add_channel_execution_proposal_workflow_link";
const CHANNEL_INTENT_DECISIONS_MIGRATION_VERSION = 54;
const CHANNEL_INTENT_DECISIONS_MIGRATION_NAME = "create_channel_intent_decisions";
const RESPONSE_LANGUAGE_CONTEXT_MIGRATION_VERSION = 55;
const RESPONSE_LANGUAGE_CONTEXT_MIGRATION_NAME = "add_response_language_context";
const CHANNEL_VISIBLE_MULTI_REPLY_INTENT_MIGRATION_VERSION = 56;
const CHANNEL_VISIBLE_MULTI_REPLY_INTENT_MIGRATION_NAME = "add_channel_visible_multi_reply_intent";
const PROVIDER_TRANSPORT_MIGRATION_VERSION = 57;
const PROVIDER_TRANSPORT_MIGRATION_NAME = "add_provider_transport";
const CHANNEL_BRANCHES_MIGRATION_VERSION = 58;
const CHANNEL_BRANCHES_MIGRATION_NAME = "create_channel_branches";
const CHANNEL_ROUTE_INSPECT_METADATA_MIGRATION_VERSION = 59;
const CHANNEL_ROUTE_INSPECT_METADATA_MIGRATION_NAME = "add_channel_route_inspect_metadata";
const CHANNEL_PROTOCOL_DRAFTS_MIGRATION_VERSION = 60;
const CHANNEL_PROTOCOL_DRAFTS_MIGRATION_NAME = "create_channel_protocol_drafts";
const INTERVENTION_MESSAGE_PAYLOAD_MIGRATION_VERSION = 61;
const INTERVENTION_MESSAGE_PAYLOAD_MIGRATION_NAME = "add_intervention_message_payload";
const CHANNEL_MESSAGE_FILE_REFS_MIGRATION_VERSION = 62;
const CHANNEL_MESSAGE_FILE_REFS_MIGRATION_NAME = "add_channel_message_file_refs";
const CHANNEL_INPUT_MATERIALIZATIONS_MIGRATION_VERSION = 63;
const CHANNEL_INPUT_MATERIALIZATIONS_MIGRATION_NAME = "create_channel_input_materializations";
const CHANNEL_EXECUTION_PROPOSAL_SHAPING_MIGRATION_VERSION = 64;
const CHANNEL_EXECUTION_PROPOSAL_SHAPING_MIGRATION_NAME = "add_channel_execution_proposal_shaping";
const AUTOMATION_CODEX_STYLE_FIELDS_MIGRATION_VERSION = 65;
const AUTOMATION_CODEX_STYLE_FIELDS_MIGRATION_NAME = "add_automation_codex_style_fields";
const TEAMMATE_DIRECT_WORKSPACE_AND_PAYLOAD_MIGRATION_VERSION = 66;
const TEAMMATE_DIRECT_WORKSPACE_AND_PAYLOAD_MIGRATION_NAME = "add_teammate_direct_workspace_and_payload";
const APPROVAL_CHECKPOINTS_MIGRATION_VERSION = 67;
const APPROVAL_CHECKPOINTS_MIGRATION_NAME = "create_approval_checkpoints";
const USER_PROFILE_MIGRATION_VERSION = 68;
const USER_PROFILE_MIGRATION_NAME = "create_user_profile";
const SKILL_CANDIDATES_MIGRATION_VERSION = 69;
const SKILL_CANDIDATES_MIGRATION_NAME = "create_skill_candidates";
const PROCEDURE_OBSERVATIONS_MIGRATION_VERSION = 70;
const PROCEDURE_OBSERVATIONS_MIGRATION_NAME = "create_procedure_observations";
const SKILL_USAGE_EVENTS_MIGRATION_VERSION = 71;
const SKILL_USAGE_EVENTS_MIGRATION_NAME = "create_skill_usage_events";
const CHANNEL_PLAYBOOK_CANDIDATES_MIGRATION_VERSION = 72;
const CHANNEL_PLAYBOOK_CANDIDATES_MIGRATION_NAME = "create_channel_playbook_candidates";
const CANDIDATE_GENERATION_DECISIONS_MIGRATION_VERSION = 73;
const CANDIDATE_GENERATION_DECISIONS_MIGRATION_NAME = "create_candidate_generation_decisions";
const GOVERNANCE_NOTIFICATIONS_MIGRATION_VERSION = 74;
const GOVERNANCE_NOTIFICATIONS_MIGRATION_NAME = "create_governance_notifications";
const AI_COUNCILS_MIGRATION_VERSION = 75;
const AI_COUNCILS_MIGRATION_NAME = "create_ai_councils";
const CHANNEL_BRANCH_ROOT_THREAD_MIGRATION_VERSION = 76;
const CHANNEL_BRANCH_ROOT_THREAD_MIGRATION_NAME = "add_channel_branch_root_thread";
const SKILL_SOURCE_SNAPSHOTS_MIGRATION_VERSION = 77;
const SKILL_SOURCE_SNAPSHOTS_MIGRATION_NAME = "create_skill_source_snapshots";
const SKILL_SOURCE_UPGRADE_LIFECYCLE_MIGRATION_VERSION = 78;
const SKILL_SOURCE_UPGRADE_LIFECYCLE_MIGRATION_NAME = "create_skill_source_upgrade_lifecycle";
const TASK_ATTACHMENT_IDS_MIGRATION_VERSION = 79;
const TASK_ATTACHMENT_IDS_MIGRATION_NAME = "add_task_attachment_ids";
const PROVIDER_THINKING_MODES_MIGRATION_VERSION = 80;
const PROVIDER_THINKING_MODES_MIGRATION_NAME = "add_provider_thinking_modes";
const CHANNEL_TEAM_EVIDENCE_MIGRATION_VERSION = 81;
const CHANNEL_TEAM_EVIDENCE_MIGRATION_NAME = "create_channel_team_evidence_items";
const CHANNEL_TEAM_INCIDENTS_MIGRATION_VERSION = 82;
const CHANNEL_TEAM_INCIDENTS_MIGRATION_NAME = "create_channel_team_incidents";
const CHANNEL_TEAM_PATTERNS_MIGRATION_VERSION = 83;
const CHANNEL_TEAM_PATTERNS_MIGRATION_NAME = "create_channel_team_patterns";
const CHANNEL_TEAM_SNAPSHOTS_MIGRATION_VERSION = 84;
const CHANNEL_TEAM_SNAPSHOTS_MIGRATION_NAME = "create_channel_team_snapshots_and_evaluations";
const CONVERSATION_ATTACHMENTS_MIGRATION_VERSION = 85;
const CONVERSATION_ATTACHMENTS_MIGRATION_NAME = "create_conversation_attachments";
const LING_THREAD_CONVERSATION_MODE_MIGRATION_VERSION = 86;
const LING_THREAD_CONVERSATION_MODE_MIGRATION_NAME = "add_ling_thread_conversation_mode";
const LING_THREAD_GOALS_MIGRATION_VERSION = 87;
const LING_THREAD_GOALS_MIGRATION_NAME = "create_ling_thread_goals";
const LING_THREAD_PROPOSED_PLANS_MIGRATION_VERSION = 88;
const LING_THREAD_PROPOSED_PLANS_MIGRATION_NAME = "create_ling_thread_proposed_plans";
const PLAN_GOAL_HISTORY_MIGRATION_VERSION = 89;
const PLAN_GOAL_HISTORY_MIGRATION_NAME = "extend_plan_goal_history";
const PROVIDER_SECRET_HEADER_REFS_MIGRATION_VERSION = 90;
const PROVIDER_SECRET_HEADER_REFS_MIGRATION_NAME = "add_provider_secret_header_refs";
const GOAL_CONTINUATION_OBSERVABILITY_MIGRATION_VERSION = 91;
const GOAL_CONTINUATION_OBSERVABILITY_MIGRATION_NAME = "add_goal_continuation_observability";
const SKILL_COMPILED_RUNTIME_VIEWS_MIGRATION_VERSION = 92;
const SKILL_COMPILED_RUNTIME_VIEWS_MIGRATION_NAME = "create_skill_compiled_runtime_views";
const SKILL_REGRESSION_RUNS_MIGRATION_VERSION = 93;
const SKILL_REGRESSION_RUNS_MIGRATION_NAME = "create_skill_regression_runs";
const LING_TERMINAL_REPORTS_MIGRATION_VERSION = 94;
const LING_TERMINAL_REPORTS_MIGRATION_NAME = "create_ling_terminal_reports";
const CONVERSATION_REVISIONS_MIGRATION_VERSION = 95;
const CONVERSATION_REVISIONS_MIGRATION_NAME = "create_conversation_revisions";
// Versions 96-99 were used by local feature branches. Keep skill migrations above
// that range so existing developer workspaces rerun these idempotent repairs.
const REMOVE_SKILL_WORKFLOW_PHASE_MIGRATION_VERSION = 100;
const REMOVE_SKILL_WORKFLOW_PHASE_MIGRATION_NAME = "remove_skill_workflow_phase_metadata";
const MANAGED_OFFICIAL_SKILL_SOURCE_MIGRATION_VERSION = 101;
const MANAGED_OFFICIAL_SKILL_SOURCE_MIGRATION_NAME = "create_managed_official_skill_source";
const AI_EVOLUTION_SKILL_LIFECYCLE_MIGRATION_VERSION = 102;
const MEDIA_PRODUCTION_STUDIO_MIGRATION_VERSION = 103;
const MEDIA_PRODUCTION_STUDIO_MIGRATION_NAME = "create_media_production_studio";
const MEDIA_EXTERNAL_WORKFLOWS_MIGRATION_VERSION = 104;
const MEDIA_EXTERNAL_WORKFLOWS_MIGRATION_NAME = "create_media_external_workflows";
const CUA_DRIVER_ACTIVATION_MIGRATION_VERSION = 105;
const CUA_DRIVER_ACTIVATION_MIGRATION_NAME = "create_cua_driver_activation_state";
const MCP_AUTHORITY_REVISIONS_MIGRATION_VERSION = 106;
const MCP_AUTHORITY_REVISIONS_MIGRATION_NAME = "add_mcp_authority_revisions";
const REMOTE_CONVERSATION_STATE_MIGRATION_VERSION = 108;
const REMOTE_CONVERSATION_STATE_MIGRATION_NAME = "create_remote_conversation_state";
const TEAMMATE_MODEL_BINDING_MIGRATION_VERSION = 107;
const TEAMMATE_MODEL_BINDING_MIGRATION_NAME = "add_teammate_model_binding_mode";
const REMOTE_UNREAD_ENTITY_MIGRATION_VERSION = 109;
const REMOTE_UNREAD_ENTITY_MIGRATION_NAME = "deduplicate_remote_run_unread_entities";
const AI_EVOLUTION_SKILL_LIFECYCLE_MIGRATION_NAME = "repair_ai_evolution_skill_lifecycle";
const WORKFLOW_AGENT_CONTEXT_MIGRATION_VERSION = 112;
const WORKFLOW_AGENT_CONTEXT_MIGRATION_NAME = "add_workflow_agent_context_stamp";

export function configureSqliteRunStoreDatabase(database: DatabaseSync): void {
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
  `);
}

export function applySqliteRunStoreMigrations(context: SqliteRunStoreMigrationContext): void {
  const { database } = context;
  database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const continuityV2Active = context.hasMigration(CONTINUITY_V2_STORAGE_MIGRATION_VERSION);

    if (!context.hasMigration(INITIAL_MIGRATION_VERSION)) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS run_sessions (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          cwd TEXT NOT NULL,
          task_id TEXT NOT NULL,
          channel_id TEXT,
          teammate_id TEXT,
          provider_preset_id TEXT,
          provider_name TEXT NOT NULL,
          provider_model TEXT NOT NULL,
          task_snapshot_json TEXT NOT NULL,
	          provider_snapshot_json TEXT NOT NULL,
	          request_snapshot_json TEXT NOT NULL,
	          event_log_path TEXT NOT NULL,
	          thread_id TEXT,
	          parent_run_id TEXT,
          intervention_id TEXT,
          continuation_reason TEXT,
          summary_path TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          ended_at TEXT,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS run_events (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          ts TEXT NOT NULL,
          type TEXT NOT NULL,
          data_json TEXT NOT NULL,
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
          UNIQUE(run_id, seq)
        );

        CREATE INDEX IF NOT EXISTS idx_run_sessions_status ON run_sessions(status);
        CREATE INDEX IF NOT EXISTS idx_run_sessions_task ON run_sessions(task_id);
        CREATE INDEX IF NOT EXISTS idx_run_sessions_created_at ON run_sessions(created_at);
        CREATE INDEX IF NOT EXISTS idx_run_events_run_seq ON run_events(run_id, seq);
        CREATE INDEX IF NOT EXISTS idx_run_events_type ON run_events(type);
      `);

      context.recordMigration(INITIAL_MIGRATION_VERSION, INITIAL_MIGRATION_NAME);
    }

    if (!context.hasMigration(PROVIDERS_MIGRATION_VERSION)) {
      if (!context.hasColumn("run_sessions", "provider_preset_id")) {
        database.exec("ALTER TABLE run_sessions ADD COLUMN provider_preset_id TEXT;");
      }

      database.exec(`
        CREATE TABLE IF NOT EXISTS provider_presets (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          display_name TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          model TEXT NOT NULL,
          api TEXT NOT NULL,
          provider_transport TEXT,
          base_url TEXT,
          api_key_ref TEXT,
          headers_json TEXT NOT NULL,
          secret_header_refs_json TEXT NOT NULL DEFAULT '{}',
          auth_header INTEGER,
          reasoning INTEGER,
          thinking_modes_json TEXT NOT NULL DEFAULT '[]',
          input_json TEXT NOT NULL,
          context_window INTEGER,
          max_tokens INTEGER,
          compat_json TEXT NOT NULL,
          capabilities_json TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_provider_presets_kind ON provider_presets(kind);
        CREATE INDEX IF NOT EXISTS idx_provider_presets_enabled ON provider_presets(enabled);
      `);

      context.recordMigration(PROVIDERS_MIGRATION_VERSION, PROVIDERS_MIGRATION_NAME);
    }

    if (!context.hasMigration(APPROVALS_MIGRATION_VERSION)) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS approval_requests (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          channel_id TEXT,
          tool_call_id TEXT,
          action_type TEXT NOT NULL,
          risk TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          resolved_at TEXT,
          resolved_by TEXT,
          decision_reason TEXT,
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_run ON approval_requests(run_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_task ON approval_requests(task_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_created_at ON approval_requests(created_at);
      `);

      context.recordMigration(APPROVALS_MIGRATION_VERSION, APPROVALS_MIGRATION_NAME);
    }

    if (!context.hasMigration(WORKSPACE_MIGRATION_VERSION)) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          default_provider_preset_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS channels (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          bound_path TEXT,
          default_provider_preset_id TEXT,
          default_teammate_id TEXT,
          auto_reply_mode TEXT NOT NULL DEFAULT 'mentions_only',
          response_language TEXT,
          allowed_tools_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          status TEXT NOT NULL,
          assignee_teammate_id TEXT,
          attachment_ids_json TEXT NOT NULL DEFAULT '[]',
          current_run_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id)
        );

        CREATE INDEX IF NOT EXISTS idx_channels_workspace ON channels(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_channel_status ON tasks(channel_id, status);
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_current_run ON tasks(current_run_id);
      `);

      context.recordMigration(WORKSPACE_MIGRATION_VERSION, WORKSPACE_MIGRATION_NAME);
    }

    if (!context.hasMigration(APPROVAL_POLICY_MIGRATION_VERSION)) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS approval_policies (
          workspace_id TEXT PRIMARY KEY,
          tool_decisions_json TEXT NOT NULL,
          allowed_write_paths_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );
      `);

      context.recordMigration(APPROVAL_POLICY_MIGRATION_VERSION, APPROVAL_POLICY_MIGRATION_NAME);
    }

    if (!context.hasMigration(PROVIDER_CHECKS_MIGRATION_VERSION)) {
      if (!context.hasColumn("provider_presets", "last_check_json")) {
        database.exec("ALTER TABLE provider_presets ADD COLUMN last_check_json TEXT;");
      }

      context.recordMigration(PROVIDER_CHECKS_MIGRATION_VERSION, PROVIDER_CHECKS_MIGRATION_NAME);
    }

    if (!context.hasMigration(ARTIFACTS_MIGRATION_VERSION)) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          type TEXT NOT NULL,
          path TEXT NOT NULL,
          title TEXT,
          content_type TEXT,
          size_bytes INTEGER,
          created_at TEXT NOT NULL,
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
        CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts(created_at);
      `);

      context.recordMigration(ARTIFACTS_MIGRATION_VERSION, ARTIFACTS_MIGRATION_NAME);
    }

    if (!context.hasMigration(MEDIA_JOBS_MIGRATION_VERSION)) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS media_jobs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          provider_preset_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          prompt TEXT NOT NULL,
          input_json TEXT NOT NULL,
          artifact_ids_json TEXT NOT NULL,
          status TEXT NOT NULL,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_media_jobs_workspace ON media_jobs(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_media_jobs_provider ON media_jobs(provider_preset_id);
        CREATE INDEX IF NOT EXISTS idx_media_jobs_status ON media_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_media_jobs_created_at ON media_jobs(created_at);
      `);

      context.recordMigration(MEDIA_JOBS_MIGRATION_VERSION, MEDIA_JOBS_MIGRATION_NAME);
    }

    if (!context.hasMigration(MEDIA_JOB_ARTIFACTS_MIGRATION_VERSION)) {
      database.exec(`
        DROP TABLE IF EXISTS artifacts_next;

        CREATE TABLE artifacts_next (
          id TEXT PRIMARY KEY,
          run_id TEXT,
          media_job_id TEXT,
          type TEXT NOT NULL,
          path TEXT NOT NULL,
          title TEXT,
          content_type TEXT,
          size_bytes INTEGER,
          created_at TEXT NOT NULL,
          CHECK ((run_id IS NOT NULL AND media_job_id IS NULL) OR (run_id IS NULL AND media_job_id IS NOT NULL)),
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
          FOREIGN KEY(media_job_id) REFERENCES media_jobs(id) ON DELETE CASCADE
        );

        INSERT INTO artifacts_next (
          id,
          run_id,
          media_job_id,
          type,
          path,
          title,
          content_type,
          size_bytes,
          created_at
        )
        SELECT
          id,
          run_id,
          NULL,
          type,
          path,
          title,
          content_type,
          size_bytes,
          created_at
        FROM artifacts;

        DROP TABLE artifacts;
        ALTER TABLE artifacts_next RENAME TO artifacts;

        CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
        CREATE INDEX IF NOT EXISTS idx_artifacts_media_job ON artifacts(media_job_id);
        CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts(created_at);
      `);

      context.recordMigration(MEDIA_JOB_ARTIFACTS_MIGRATION_VERSION, MEDIA_JOB_ARTIFACTS_MIGRATION_NAME);
    }

    if (!context.hasMigration(APPROVAL_MEDIA_JOB_OWNER_MIGRATION_VERSION)) {
      database.exec(`
        DROP TABLE IF EXISTS approval_requests_next;

        CREATE TABLE approval_requests_next (
          id TEXT PRIMARY KEY,
          run_id TEXT,
          task_id TEXT,
          media_job_id TEXT,
          channel_id TEXT,
          tool_call_id TEXT,
          action_type TEXT NOT NULL,
          risk TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          resolved_at TEXT,
          resolved_by TEXT,
          decision_reason TEXT,
          CHECK (
            (run_id IS NOT NULL AND task_id IS NOT NULL AND media_job_id IS NULL)
            OR (run_id IS NULL AND task_id IS NULL AND media_job_id IS NOT NULL)
          ),
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
          FOREIGN KEY(media_job_id) REFERENCES media_jobs(id) ON DELETE CASCADE
        );

        INSERT INTO approval_requests_next (
          id,
          run_id,
          task_id,
          media_job_id,
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
        )
        SELECT
          id,
          run_id,
          task_id,
          NULL,
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
        FROM approval_requests;

        DROP TABLE approval_requests;
        ALTER TABLE approval_requests_next RENAME TO approval_requests;

        CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_run ON approval_requests(run_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_task ON approval_requests(task_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_media_job ON approval_requests(media_job_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_created_at ON approval_requests(created_at);
      `);

      context.recordMigration(APPROVAL_MEDIA_JOB_OWNER_MIGRATION_VERSION, APPROVAL_MEDIA_JOB_OWNER_MIGRATION_NAME);
    }

    const hasChannelRuntimeMigration = context.hasMigration(CHANNEL_RUNTIME_MIGRATION_VERSION);
    if (
      !hasChannelRuntimeMigration ||
      !context.hasColumn("channels", "status") ||
      !context.hasColumn("channels", "runtime_policy_json") ||
      !context.hasTable("state_transition_events") ||
      !context.hasTable("resource_leases")
    ) {
      if (!context.hasColumn("channels", "status")) {
        database.exec("ALTER TABLE channels ADD COLUMN status TEXT NOT NULL DEFAULT 'active';");
      }
      if (!context.hasColumn("channels", "runtime_policy_json")) {
        database.exec(
          `ALTER TABLE channels ADD COLUMN runtime_policy_json TEXT NOT NULL DEFAULT '${stringifyJson(normalizeChannelRuntimePolicy(undefined))}';`,
        );
      }

      database.exec(`
        CREATE TABLE IF NOT EXISTS state_transition_events (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          from_status TEXT NOT NULL,
          to_status TEXT NOT NULL,
          event TEXT NOT NULL,
          actor TEXT NOT NULL,
          reason TEXT,
          idempotency_key TEXT,
          created_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_state_transition_idempotency
        ON state_transition_events(entity_type, entity_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_state_transition_entity
        ON state_transition_events(entity_type, entity_id, created_at);

        CREATE TABLE IF NOT EXISTS resource_leases (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_key TEXT NOT NULL,
          owner_type TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          status TEXT NOT NULL,
          acquired_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          released_at TEXT
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_active_resource_lease
        ON resource_leases(workspace_id, resource_type, resource_key)
        WHERE status = 'active';

        CREATE INDEX IF NOT EXISTS idx_resource_leases_owner
        ON resource_leases(owner_type, owner_id, status);

        CREATE INDEX IF NOT EXISTS idx_resource_leases_expiry
        ON resource_leases(status, expires_at);
      `);

      if (!hasChannelRuntimeMigration) {
        context.recordMigration(CHANNEL_RUNTIME_MIGRATION_VERSION, CHANNEL_RUNTIME_MIGRATION_NAME);
      }
    }

    const hasProviderSecretsMigration = context.hasMigration(PROVIDER_SECRETS_MIGRATION_VERSION);
    if (!hasProviderSecretsMigration || !context.hasTable("provider_secrets")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS provider_secrets (
          provider_id TEXT PRIMARY KEY,
          secret_value TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(provider_id) REFERENCES provider_presets(id) ON DELETE CASCADE
        );
      `);

      if (!hasProviderSecretsMigration) {
        context.recordMigration(PROVIDER_SECRETS_MIGRATION_VERSION, PROVIDER_SECRETS_MIGRATION_NAME);
      }
    }

    const hasChannelWorkspaceMigration = context.hasMigration(CHANNEL_WORKSPACE_MIGRATION_VERSION);
    const channelWorkspaceBaseMissing =
      !context.hasColumn("channels", "default_teammate_id") ||
      !context.hasColumn("tasks", "assignee_teammate_id");
    const legacyChannelWorkspaceMissing = !continuityV2Active && (
      !context.hasTable("channel_messages") ||
      !context.hasTable("channel_attachments") ||
      !context.hasTable("channel_link_previews")
    );
    if (!hasChannelWorkspaceMigration || channelWorkspaceBaseMissing || legacyChannelWorkspaceMissing) {
      if (!context.hasColumn("channels", "default_teammate_id")) {
        database.exec("ALTER TABLE channels ADD COLUMN default_teammate_id TEXT;");
      }
      if (!context.hasColumn("tasks", "assignee_teammate_id")) {
        database.exec("ALTER TABLE tasks ADD COLUMN assignee_teammate_id TEXT;");
      }

      if (!continuityV2Active) database.exec(`
        CREATE TABLE IF NOT EXISTS channel_messages (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          thread_id TEXT,
          kind TEXT NOT NULL,
          intent TEXT NOT NULL,
          author_type TEXT NOT NULL,
          author_id TEXT,
          body TEXT NOT NULL,
          mentions_json TEXT NOT NULL,
          attachment_ids_json TEXT NOT NULL,
          link_preview_ids_json TEXT NOT NULL,
          file_refs_json TEXT NOT NULL DEFAULT '[]',
          linked_task_id TEXT,
          linked_run_id TEXT,
          status TEXT NOT NULL,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_channel_messages_channel_created
        ON channel_messages(channel_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_channel_messages_thread
        ON channel_messages(thread_id, created_at);

        CREATE TABLE IF NOT EXISTS channel_attachments (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          message_id TEXT,
          kind TEXT NOT NULL,
          file_name TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          path TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(message_id) REFERENCES channel_messages(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_channel_attachments_channel_created
        ON channel_attachments(channel_id, created_at);

        CREATE TABLE IF NOT EXISTS channel_link_previews (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          message_id TEXT,
          url TEXT NOT NULL,
          normalized_url TEXT NOT NULL,
          title TEXT,
          description TEXT,
          image_url TEXT,
          site_name TEXT,
          status TEXT NOT NULL,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(message_id) REFERENCES channel_messages(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_channel_link_previews_channel_created
        ON channel_link_previews(channel_id, created_at);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_link_previews_channel_url
        ON channel_link_previews(channel_id, normalized_url);
      `);

      if (!hasChannelWorkspaceMigration) {
        context.recordMigration(CHANNEL_WORKSPACE_MIGRATION_VERSION, CHANNEL_WORKSPACE_MIGRATION_NAME);
      }
    }

    const hasChannelProtocolMigration = context.hasMigration(CHANNEL_PROTOCOL_MIGRATION_VERSION);
    if (
      !hasChannelProtocolMigration ||
      !context.hasTable("channel_briefs") ||
      !context.hasTable("channel_decisions") ||
      !context.hasTable("channel_handoffs") ||
      (!continuityV2Active && !context.hasTable("channel_context_summaries"))
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS channel_briefs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL UNIQUE,
          objective TEXT NOT NULL,
          scope TEXT NOT NULL,
          acceptance_criteria_json TEXT NOT NULL,
          open_questions_json TEXT NOT NULL,
          risks_json TEXT NOT NULL,
          decision_ids_json TEXT NOT NULL,
          attachment_ids_json TEXT NOT NULL,
          link_preview_ids_json TEXT NOT NULL,
          updated_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_briefs_channel
        ON channel_briefs(channel_id);

        CREATE TABLE IF NOT EXISTS channel_decisions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          source_message_id TEXT,
          source_task_id TEXT,
          source_run_id TEXT,
          title TEXT NOT NULL,
          decision TEXT NOT NULL,
          rationale TEXT NOT NULL,
          alternatives_json TEXT NOT NULL,
          status TEXT NOT NULL,
          supersedes_decision_id TEXT,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(source_message_id) REFERENCES channel_messages(id) ON DELETE SET NULL,
          FOREIGN KEY(source_task_id) REFERENCES tasks(id) ON DELETE SET NULL,
          FOREIGN KEY(source_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL,
          FOREIGN KEY(supersedes_decision_id) REFERENCES channel_decisions(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_channel_decisions_channel_created
        ON channel_decisions(channel_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_channel_decisions_channel_status_created
        ON channel_decisions(channel_id, status, created_at);

        CREATE TABLE IF NOT EXISTS channel_handoffs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          source_message_id TEXT,
          source_task_id TEXT,
          source_run_id TEXT,
          from_participant_id TEXT NOT NULL,
          from_participant_label TEXT NOT NULL,
          to_participant_id TEXT NOT NULL,
          to_participant_label TEXT NOT NULL,
          reason TEXT NOT NULL,
          required_input TEXT NOT NULL,
          expected_output TEXT NOT NULL,
          status TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(source_message_id) REFERENCES channel_messages(id) ON DELETE SET NULL,
          FOREIGN KEY(source_task_id) REFERENCES tasks(id) ON DELETE SET NULL,
          FOREIGN KEY(source_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_channel_handoffs_channel_status_created
        ON channel_handoffs(channel_id, status, created_at);

      `);

      if (!continuityV2Active) {
        database.exec(`
          CREATE TABLE IF NOT EXISTS channel_context_summaries (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            target_type TEXT NOT NULL,
            target_id TEXT NOT NULL,
            source_message_ids_json TEXT NOT NULL,
            decision_ids_json TEXT NOT NULL,
            summary TEXT NOT NULL,
            acceptance_criteria_json TEXT NOT NULL,
            open_questions_json TEXT NOT NULL,
            author_type TEXT NOT NULL,
            author_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
            FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_channel_context_summaries_target_updated
          ON channel_context_summaries(channel_id, target_type, target_id, updated_at);
        `);
      }

      if (!hasChannelProtocolMigration) {
        context.recordMigration(CHANNEL_PROTOCOL_MIGRATION_VERSION, CHANNEL_PROTOCOL_MIGRATION_NAME);
      }
    }

    const hasChannelWorkflowMigration = context.hasMigration(CHANNEL_WORKFLOW_MIGRATION_VERSION);
    if (
      !hasChannelWorkflowMigration ||
      !context.hasTable("channel_workflows") ||
      !context.hasTable("channel_workflow_steps")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS channel_workflows (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          source_handoff_id TEXT,
          title TEXT NOT NULL,
          objective TEXT NOT NULL,
          status TEXT NOT NULL,
          created_by TEXT NOT NULL,
          metadata_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(source_handoff_id) REFERENCES channel_handoffs(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_channel_workflows_channel_status_updated
        ON channel_workflows(channel_id, status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_channel_workflows_handoff
        ON channel_workflows(source_handoff_id);

        CREATE TABLE IF NOT EXISTS channel_workflow_steps (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          source_handoff_id TEXT,
          context_summary_id TEXT,
          task_id TEXT,
          run_id TEXT,
          position INTEGER NOT NULL,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          to_participant_id TEXT NOT NULL,
          to_participant_label TEXT NOT NULL,
          status TEXT NOT NULL,
          blocker TEXT,
          result_summary TEXT,
          metadata_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(workflow_id) REFERENCES channel_workflows(id) ON DELETE CASCADE,
          FOREIGN KEY(source_handoff_id) REFERENCES channel_handoffs(id) ON DELETE SET NULL,
          FOREIGN KEY(context_summary_id) REFERENCES channel_context_summaries(id) ON DELETE SET NULL,
          FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL,
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_channel_workflow_steps_workflow_position
        ON channel_workflow_steps(workflow_id, position);

        CREATE INDEX IF NOT EXISTS idx_channel_workflow_steps_channel_status
        ON channel_workflow_steps(channel_id, status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_channel_workflow_steps_task
        ON channel_workflow_steps(task_id);

        CREATE INDEX IF NOT EXISTS idx_channel_workflow_steps_run
        ON channel_workflow_steps(run_id);
      `);

      if (!hasChannelWorkflowMigration) {
        context.recordMigration(CHANNEL_WORKFLOW_MIGRATION_VERSION, CHANNEL_WORKFLOW_MIGRATION_NAME);
      }
    }

    const hasAiTeammateWorkspaceMigration = context.hasMigration(AI_TEAMMATE_WORKSPACE_MIGRATION_VERSION);
    if (
      !hasAiTeammateWorkspaceMigration ||
      !context.hasTable("ai_teammates") ||
      !context.hasTable("teammate_channel_memberships") ||
      !context.hasTable("teammate_skill_bindings") ||
      !context.hasTable("teammate_memory_scopes") ||
      !context.hasTable("teammate_direct_threads") ||
      !context.hasTable("teammate_direct_messages")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS ai_teammates (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          template_id TEXT,
          role_key TEXT NOT NULL,
          display_name TEXT NOT NULL,
          description TEXT NOT NULL,
          avatar_tone TEXT,
          avatar_image_attachment_id TEXT,
          provider_preset_id TEXT,
          runner_id TEXT,
          system_prompt TEXT,
          append_system_prompt_json TEXT NOT NULL,
          allowed_tools_json TEXT NOT NULL,
          approval_profile_json TEXT NOT NULL,
          status TEXT NOT NULL,
          pinned INTEGER NOT NULL,
          hidden INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_ai_teammates_workspace_status
        ON ai_teammates(workspace_id, status, hidden, pinned);

        CREATE TABLE IF NOT EXISTS teammate_channel_memberships (
          teammate_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          is_default INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(teammate_id, channel_id),
          FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_teammate_channel_memberships_channel
        ON teammate_channel_memberships(channel_id);

        CREATE TABLE IF NOT EXISTS teammate_skill_bindings (
          teammate_id TEXT NOT NULL,
          skill_id TEXT NOT NULL,
          source TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(teammate_id, skill_id),
          FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS teammate_memory_scopes (
          id TEXT PRIMARY KEY,
          teammate_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          channel_id TEXT,
          enabled INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_teammate_memory_scopes_teammate
        ON teammate_memory_scopes(teammate_id, enabled);

        CREATE TABLE IF NOT EXISTS teammate_direct_threads (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          teammate_id TEXT NOT NULL,
          title TEXT NOT NULL,
          workspace_binding_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_teammate_direct_threads_teammate
        ON teammate_direct_threads(workspace_id, teammate_id);

        CREATE TABLE IF NOT EXISTS teammate_direct_messages (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          teammate_id TEXT NOT NULL,
          author_type TEXT NOT NULL,
          author_id TEXT,
          body TEXT NOT NULL,
          attachment_ids_json TEXT NOT NULL DEFAULT '[]',
          link_preview_ids_json TEXT NOT NULL DEFAULT '[]',
          file_refs_json TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL,
          error_message TEXT,
          linked_task_id TEXT,
          linked_run_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(thread_id) REFERENCES teammate_direct_threads(id) ON DELETE CASCADE,
          FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_teammate_direct_messages_thread_created
        ON teammate_direct_messages(thread_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_teammate_direct_messages_teammate_created
        ON teammate_direct_messages(teammate_id, created_at);
      `);

      if (!hasAiTeammateWorkspaceMigration) {
        context.recordMigration(AI_TEAMMATE_WORKSPACE_MIGRATION_VERSION, AI_TEAMMATE_WORKSPACE_MIGRATION_NAME);
      }
    }

    const hasExternalWorkMigration = context.hasMigration(EXTERNAL_WORK_MIGRATION_VERSION);
    if (
      !hasExternalWorkMigration ||
      !context.hasTable("external_work_items") ||
      !context.hasColumn("artifacts", "external_work_id")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS external_work_items (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          work_item_kind TEXT NOT NULL,
          external_id TEXT NOT NULL,
          identifier TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          workflow_step_id TEXT NOT NULL,
          artifact_ids_json TEXT NOT NULL,
          item_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_external_work_idempotency
        ON external_work_items(workspace_id, source_kind, idempotency_key);

        CREATE INDEX IF NOT EXISTS idx_external_work_channel_created
        ON external_work_items(channel_id, created_at);
      `);

      if (!context.hasColumn("artifacts", "external_work_id")) {
        database.exec(`
          DROP TABLE IF EXISTS artifacts_next;

          CREATE TABLE artifacts_next (
            id TEXT PRIMARY KEY,
            run_id TEXT,
            media_job_id TEXT,
            external_work_id TEXT,
            type TEXT NOT NULL,
            path TEXT NOT NULL,
            title TEXT,
            content_type TEXT,
            size_bytes INTEGER,
            created_at TEXT NOT NULL,
            CHECK (
              (run_id IS NOT NULL AND media_job_id IS NULL AND external_work_id IS NULL)
              OR (run_id IS NULL AND media_job_id IS NOT NULL AND external_work_id IS NULL)
              OR (run_id IS NULL AND media_job_id IS NULL AND external_work_id IS NOT NULL)
            ),
            FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
            FOREIGN KEY(media_job_id) REFERENCES media_jobs(id) ON DELETE CASCADE,
            FOREIGN KEY(external_work_id) REFERENCES external_work_items(id) ON DELETE CASCADE
          );

          INSERT INTO artifacts_next (
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
          )
          SELECT
            id,
            run_id,
            media_job_id,
            NULL,
            type,
            path,
            title,
            content_type,
            size_bytes,
            created_at
          FROM artifacts;

          DROP TABLE artifacts;
          ALTER TABLE artifacts_next RENAME TO artifacts;

          CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
          CREATE INDEX IF NOT EXISTS idx_artifacts_media_job ON artifacts(media_job_id);
          CREATE INDEX IF NOT EXISTS idx_artifacts_external_work ON artifacts(external_work_id);
          CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts(created_at);
        `);
      }

      if (!hasExternalWorkMigration) {
        context.recordMigration(EXTERNAL_WORK_MIGRATION_VERSION, EXTERNAL_WORK_MIGRATION_NAME);
      }
    }

    const hasExternalWorkSchedulerMigration = context.hasMigration(EXTERNAL_WORK_SCHEDULER_MIGRATION_VERSION);
    if (!hasExternalWorkSchedulerMigration || !context.hasTable("external_work_scheduler_state")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS external_work_scheduler_state (
          external_work_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          subject_key TEXT NOT NULL,
          source_key TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          workflow_step_id TEXT NOT NULL,
          scheduler_status TEXT NOT NULL,
          attempt_count INTEGER NOT NULL,
          last_attempt_at TEXT,
          next_attempt_at TEXT,
          max_retry_backoff_ms INTEGER NOT NULL,
          last_error_code TEXT,
          last_error_message TEXT,
          workspace_path TEXT,
          workspace_mode TEXT,
          hook_artifact_ids_json TEXT NOT NULL,
          last_reconciled_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_external_work_scheduler_subject
        ON external_work_scheduler_state(workspace_id, source_key, subject_key, scheduler_status);

        CREATE INDEX IF NOT EXISTS idx_external_work_scheduler_channel_status
        ON external_work_scheduler_state(channel_id, scheduler_status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_external_work_scheduler_retry
        ON external_work_scheduler_state(scheduler_status, next_attempt_at);
      `);

      if (!hasExternalWorkSchedulerMigration) {
        context.recordMigration(EXTERNAL_WORK_SCHEDULER_MIGRATION_VERSION, EXTERNAL_WORK_SCHEDULER_MIGRATION_NAME);
      }
    }

    const hasExternalWorkActionsMigration = context.hasMigration(EXTERNAL_WORK_ACTIONS_MIGRATION_VERSION);
    if (
      !hasExternalWorkActionsMigration ||
      !context.hasTable("external_work_actions") ||
      !context.hasColumn("approval_requests", "external_work_action_id")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS external_work_actions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          external_work_id TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          action_kind TEXT NOT NULL,
          status TEXT NOT NULL,
          approval_id TEXT,
          idempotency_key TEXT NOT NULL,
          target_json TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          approval_requirement TEXT NOT NULL,
          artifact_ids_json TEXT NOT NULL,
          execution_attempt_count INTEGER NOT NULL,
          last_attempt_at TEXT,
          next_attempt_at TEXT,
          last_error_code TEXT,
          last_error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          executed_at TEXT,
          FOREIGN KEY(external_work_id) REFERENCES external_work_items(id) ON DELETE CASCADE,
          FOREIGN KEY(approval_id) REFERENCES approval_requests(id) ON DELETE SET NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_external_work_actions_idempotency
        ON external_work_actions(workspace_id, source_kind, idempotency_key);

        CREATE INDEX IF NOT EXISTS idx_external_work_actions_external_work_status
        ON external_work_actions(workspace_id, external_work_id, status);

        CREATE INDEX IF NOT EXISTS idx_external_work_actions_approval
        ON external_work_actions(workspace_id, approval_id);

        CREATE INDEX IF NOT EXISTS idx_external_work_actions_updated
        ON external_work_actions(workspace_id, updated_at);
      `);

      if (!context.hasColumn("approval_requests", "external_work_action_id")) {
        database.exec(`
          DROP TABLE IF EXISTS approval_requests_next;

          CREATE TABLE approval_requests_next (
            id TEXT PRIMARY KEY,
            run_id TEXT,
            task_id TEXT,
            media_job_id TEXT,
            external_work_action_id TEXT,
            channel_id TEXT,
            tool_call_id TEXT,
            action_type TEXT NOT NULL,
            risk TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT,
            resolved_at TEXT,
            resolved_by TEXT,
            decision_reason TEXT,
            CHECK (
              (run_id IS NOT NULL AND task_id IS NOT NULL AND media_job_id IS NULL AND external_work_action_id IS NULL)
              OR (run_id IS NULL AND task_id IS NULL AND media_job_id IS NOT NULL AND external_work_action_id IS NULL)
              OR (run_id IS NULL AND task_id IS NULL AND media_job_id IS NULL AND external_work_action_id IS NOT NULL)
            ),
            FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
            FOREIGN KEY(media_job_id) REFERENCES media_jobs(id) ON DELETE CASCADE,
            FOREIGN KEY(external_work_action_id) REFERENCES external_work_actions(id) ON DELETE CASCADE
          );

          INSERT INTO approval_requests_next (
            id,
            run_id,
            task_id,
            media_job_id,
            external_work_action_id,
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
          )
          SELECT
            id,
            run_id,
            task_id,
            media_job_id,
            NULL,
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
          FROM approval_requests;

          DROP TABLE approval_requests;
          ALTER TABLE approval_requests_next RENAME TO approval_requests;

          CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
          CREATE INDEX IF NOT EXISTS idx_approval_requests_run ON approval_requests(run_id);
          CREATE INDEX IF NOT EXISTS idx_approval_requests_task ON approval_requests(task_id);
          CREATE INDEX IF NOT EXISTS idx_approval_requests_media_job ON approval_requests(media_job_id);
          CREATE INDEX IF NOT EXISTS idx_approval_requests_external_work_action ON approval_requests(external_work_action_id);
          CREATE INDEX IF NOT EXISTS idx_approval_requests_created_at ON approval_requests(created_at);
        `);
      }

      if (!hasExternalWorkActionsMigration) {
        context.recordMigration(EXTERNAL_WORK_ACTIONS_MIGRATION_VERSION, EXTERNAL_WORK_ACTIONS_MIGRATION_NAME);
      }
    }

    const hasExternalWorkCiTriageMigration = context.hasMigration(EXTERNAL_WORK_CI_TRIAGE_MIGRATION_VERSION);
    if (!hasExternalWorkCiTriageMigration || !context.hasTable("external_work_ci_triage")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS external_work_ci_triage (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          external_work_id TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          repository TEXT NOT NULL,
          subject_kind TEXT NOT NULL,
          subject_number INTEGER NOT NULL,
          head_sha TEXT NOT NULL,
          failure_key TEXT NOT NULL,
          status TEXT NOT NULL,
          check_name TEXT NOT NULL,
          workflow_name TEXT,
          job_name TEXT,
          conclusion TEXT NOT NULL,
          html_url TEXT,
          first_failing_command TEXT,
          reproduction_command TEXT,
          suspected_source_path TEXT,
          task_id TEXT,
          run_id TEXT,
          artifact_ids_json TEXT NOT NULL,
          failure_json TEXT NOT NULL,
          last_error_code TEXT,
          last_error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(external_work_id) REFERENCES external_work_items(id) ON DELETE CASCADE,
          FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL,
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_external_work_ci_triage_failure
        ON external_work_ci_triage(workspace_id, source_kind, failure_key);

        CREATE INDEX IF NOT EXISTS idx_external_work_ci_triage_external_work_status
        ON external_work_ci_triage(workspace_id, external_work_id, status);

        CREATE INDEX IF NOT EXISTS idx_external_work_ci_triage_channel_updated
        ON external_work_ci_triage(workspace_id, channel_id, updated_at);

        CREATE INDEX IF NOT EXISTS idx_external_work_ci_triage_head
        ON external_work_ci_triage(workspace_id, head_sha);
      `);

      if (!hasExternalWorkCiTriageMigration) {
        context.recordMigration(EXTERNAL_WORK_CI_TRIAGE_MIGRATION_VERSION, EXTERNAL_WORK_CI_TRIAGE_MIGRATION_NAME);
      }
    }

    const hasChannelExecutionProposalsMigration = context.hasMigration(CHANNEL_EXECUTION_PROPOSALS_MIGRATION_VERSION);
    if (!hasChannelExecutionProposalsMigration || !context.hasTable("channel_execution_proposals")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS channel_execution_proposals (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          source_message_id TEXT NOT NULL,
          proposed_by_teammate_id TEXT NOT NULL,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          assignee_teammate_id TEXT NOT NULL,
          acceptance_criteria_json TEXT NOT NULL,
          collaboration_steps_json TEXT NOT NULL,
          required_tools_json TEXT NOT NULL,
          risk_summary TEXT,
          response_language TEXT,
          shaping_json TEXT,
          status TEXT NOT NULL,
          linked_task_id TEXT,
          linked_run_id TEXT,
          linked_workflow_id TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(source_message_id) REFERENCES channel_messages(id) ON DELETE CASCADE,
          FOREIGN KEY(linked_task_id) REFERENCES tasks(id) ON DELETE SET NULL,
          FOREIGN KEY(linked_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_channel_execution_proposals_channel_created
        ON channel_execution_proposals(channel_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_channel_execution_proposals_source
        ON channel_execution_proposals(source_message_id);

        CREATE INDEX IF NOT EXISTS idx_channel_execution_proposals_status
        ON channel_execution_proposals(channel_id, status, updated_at);
      `);

      if (!hasChannelExecutionProposalsMigration) {
        context.recordMigration(CHANNEL_EXECUTION_PROPOSALS_MIGRATION_VERSION, CHANNEL_EXECUTION_PROPOSALS_MIGRATION_NAME);
      }
    }

    const hasChannelExecutionProposalWorkflowLinkMigration = context.hasMigration(CHANNEL_EXECUTION_PROPOSAL_WORKFLOW_LINK_MIGRATION_VERSION);
    if (
      !hasChannelExecutionProposalWorkflowLinkMigration ||
      !context.hasColumn("channel_execution_proposals", "linked_workflow_id")
    ) {
      if (context.hasTable("channel_execution_proposals") && !context.hasColumn("channel_execution_proposals", "linked_workflow_id")) {
        database.exec("ALTER TABLE channel_execution_proposals ADD COLUMN linked_workflow_id TEXT;");
      }
      if (!hasChannelExecutionProposalWorkflowLinkMigration) {
        context.recordMigration(CHANNEL_EXECUTION_PROPOSAL_WORKFLOW_LINK_MIGRATION_VERSION, CHANNEL_EXECUTION_PROPOSAL_WORKFLOW_LINK_MIGRATION_NAME);
      }
    }

    if (!continuityV2Active) {
      const hasChannelIntentDecisionsMigration = context.hasMigration(CHANNEL_INTENT_DECISIONS_MIGRATION_VERSION);
      if (!hasChannelIntentDecisionsMigration || !context.hasTable("channel_intent_decisions")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS channel_intent_decisions (
          id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          source_message_id TEXT NOT NULL,
          action TEXT NOT NULL,
          selected_teammate_id TEXT,
          selected_teammate_ids_json TEXT,
          proposal_id TEXT,
          reply_message_id TEXT,
          reply_message_ids_json TEXT,
          workflow_id TEXT,
          reason TEXT NOT NULL,
          status TEXT NOT NULL,
          created_by TEXT NOT NULL,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(source_message_id) REFERENCES channel_messages(id) ON DELETE CASCADE,
          FOREIGN KEY(proposal_id) REFERENCES channel_execution_proposals(id) ON DELETE SET NULL,
          FOREIGN KEY(reply_message_id) REFERENCES channel_messages(id) ON DELETE SET NULL,
          FOREIGN KEY(workflow_id) REFERENCES channel_workflows(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_channel_intent_decisions_channel_created
        ON channel_intent_decisions(workspace_id, channel_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_channel_intent_decisions_source
        ON channel_intent_decisions(workspace_id, source_message_id);

        CREATE INDEX IF NOT EXISTS idx_channel_intent_decisions_status
        ON channel_intent_decisions(workspace_id, channel_id, status, updated_at);
      `);
      if (!hasChannelIntentDecisionsMigration) {
        context.recordMigration(CHANNEL_INTENT_DECISIONS_MIGRATION_VERSION, CHANNEL_INTENT_DECISIONS_MIGRATION_NAME);
      }
      }

      const hasChannelVisibleMultiReplyIntentMigration = context.hasMigration(CHANNEL_VISIBLE_MULTI_REPLY_INTENT_MIGRATION_VERSION);
      if (
        !hasChannelVisibleMultiReplyIntentMigration ||
        !context.hasColumn("channel_intent_decisions", "selected_teammate_ids_json") ||
        !context.hasColumn("channel_intent_decisions", "reply_message_ids_json")
      ) {
        if (context.hasTable("channel_intent_decisions") && !context.hasColumn("channel_intent_decisions", "selected_teammate_ids_json")) {
          database.exec("ALTER TABLE channel_intent_decisions ADD COLUMN selected_teammate_ids_json TEXT;");
        }
        if (context.hasTable("channel_intent_decisions") && !context.hasColumn("channel_intent_decisions", "reply_message_ids_json")) {
          database.exec("ALTER TABLE channel_intent_decisions ADD COLUMN reply_message_ids_json TEXT;");
        }
        if (!hasChannelVisibleMultiReplyIntentMigration) {
          context.recordMigration(CHANNEL_VISIBLE_MULTI_REPLY_INTENT_MIGRATION_VERSION, CHANNEL_VISIBLE_MULTI_REPLY_INTENT_MIGRATION_NAME);
        }
      }
    }

    const hasResponseLanguageContextMigration = context.hasMigration(RESPONSE_LANGUAGE_CONTEXT_MIGRATION_VERSION);
    if (
      !hasResponseLanguageContextMigration ||
      !context.hasColumn("channels", "response_language") ||
      !context.hasColumn("channel_execution_proposals", "response_language")
    ) {
      if (context.hasTable("channels") && !context.hasColumn("channels", "response_language")) {
        database.exec("ALTER TABLE channels ADD COLUMN response_language TEXT;");
      }
      if (context.hasTable("channel_execution_proposals") && !context.hasColumn("channel_execution_proposals", "response_language")) {
        database.exec("ALTER TABLE channel_execution_proposals ADD COLUMN response_language TEXT;");
      }
      if (!hasResponseLanguageContextMigration) {
        context.recordMigration(RESPONSE_LANGUAGE_CONTEXT_MIGRATION_VERSION, RESPONSE_LANGUAGE_CONTEXT_MIGRATION_NAME);
      }
    }

    const hasChannelExecutionProposalShapingMigration = context.hasMigration(CHANNEL_EXECUTION_PROPOSAL_SHAPING_MIGRATION_VERSION);
    if (
      !hasChannelExecutionProposalShapingMigration ||
      !context.hasColumn("channel_execution_proposals", "shaping_json")
    ) {
      if (context.hasTable("channel_execution_proposals") && !context.hasColumn("channel_execution_proposals", "shaping_json")) {
        database.exec("ALTER TABLE channel_execution_proposals ADD COLUMN shaping_json TEXT;");
      }
      if (!hasChannelExecutionProposalShapingMigration) {
        context.recordMigration(CHANNEL_EXECUTION_PROPOSAL_SHAPING_MIGRATION_VERSION, CHANNEL_EXECUTION_PROPOSAL_SHAPING_MIGRATION_NAME);
      }
    }

    const hasProviderTransportMigration = context.hasMigration(PROVIDER_TRANSPORT_MIGRATION_VERSION);
    if (!hasProviderTransportMigration || !context.hasColumn("provider_presets", "provider_transport")) {
      if (context.hasTable("provider_presets") && !context.hasColumn("provider_presets", "provider_transport")) {
        database.exec("ALTER TABLE provider_presets ADD COLUMN provider_transport TEXT;");
      }
      if (!hasProviderTransportMigration) {
        context.recordMigration(PROVIDER_TRANSPORT_MIGRATION_VERSION, PROVIDER_TRANSPORT_MIGRATION_NAME);
      }
    }

    const hasProviderThinkingModesMigration = context.hasMigration(PROVIDER_THINKING_MODES_MIGRATION_VERSION);
    if (!hasProviderThinkingModesMigration || !context.hasColumn("provider_presets", "thinking_modes_json")) {
      if (context.hasTable("provider_presets") && !context.hasColumn("provider_presets", "thinking_modes_json")) {
        database.exec("ALTER TABLE provider_presets ADD COLUMN thinking_modes_json TEXT NOT NULL DEFAULT '[]';");
      }
      if (!hasProviderThinkingModesMigration) {
        context.recordMigration(PROVIDER_THINKING_MODES_MIGRATION_VERSION, PROVIDER_THINKING_MODES_MIGRATION_NAME);
      }
    }

    const hasChannelTeamEvidenceMigration = context.hasMigration(CHANNEL_TEAM_EVIDENCE_MIGRATION_VERSION);
    if (!hasChannelTeamEvidenceMigration || !context.hasTable("channel_team_evidence_items")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS channel_team_evidence_items (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          turn_id TEXT,
          agent_id TEXT,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          visibility TEXT NOT NULL,
          evidence_grade TEXT,
          summary TEXT NOT NULL,
          concerns_json TEXT NOT NULL,
          recommendations_json TEXT NOT NULL,
          confidence REAL,
          source_refs_json TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          expires_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_channel_team_evidence_channel_updated
        ON channel_team_evidence_items(workspace_id, channel_id, updated_at);

        CREATE INDEX IF NOT EXISTS idx_channel_team_evidence_turn
        ON channel_team_evidence_items(workspace_id, channel_id, turn_id, updated_at);

        CREATE INDEX IF NOT EXISTS idx_channel_team_evidence_agent
        ON channel_team_evidence_items(workspace_id, channel_id, agent_id, updated_at);

        CREATE INDEX IF NOT EXISTS idx_channel_team_evidence_kind_status
        ON channel_team_evidence_items(workspace_id, channel_id, kind, status, updated_at);
      `);
      if (!hasChannelTeamEvidenceMigration) {
        context.recordMigration(CHANNEL_TEAM_EVIDENCE_MIGRATION_VERSION, CHANNEL_TEAM_EVIDENCE_MIGRATION_NAME);
      }
    }

    const hasChannelTeamIncidentsMigration = context.hasMigration(CHANNEL_TEAM_INCIDENTS_MIGRATION_VERSION);
    if (!hasChannelTeamIncidentsMigration || !context.hasTable("channel_team_incidents")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS channel_team_incidents (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          incident_type TEXT NOT NULL,
          agent_id TEXT,
          capability_scope TEXT,
          provider_preset_id TEXT,
          kind TEXT NOT NULL,
          severity TEXT,
          availability_state TEXT,
          model_signature_json TEXT NOT NULL,
          summary TEXT NOT NULL,
          source_refs_json TEXT NOT NULL,
          recovery_required INTEGER NOT NULL DEFAULT 0,
          recovered_at TEXT,
          observed_at TEXT NOT NULL,
          expires_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_channel_team_incidents_agent_scope
        ON channel_team_incidents(workspace_id, agent_id, capability_scope, observed_at);

        CREATE INDEX IF NOT EXISTS idx_channel_team_incidents_provider
        ON channel_team_incidents(workspace_id, provider_preset_id, observed_at);

        CREATE INDEX IF NOT EXISTS idx_channel_team_incidents_type_kind
        ON channel_team_incidents(workspace_id, incident_type, kind, observed_at);
      `);
      if (!hasChannelTeamIncidentsMigration) {
        context.recordMigration(CHANNEL_TEAM_INCIDENTS_MIGRATION_VERSION, CHANNEL_TEAM_INCIDENTS_MIGRATION_NAME);
      }
    }

    const hasChannelTeamPatternsMigration = context.hasMigration(CHANNEL_TEAM_PATTERNS_MIGRATION_VERSION);
    if (!hasChannelTeamPatternsMigration || !context.hasTable("channel_team_patterns")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS channel_team_patterns (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          pattern TEXT NOT NULL,
          summary TEXT NOT NULL,
          evidence_count INTEGER NOT NULL,
          adopted_count INTEGER NOT NULL,
          failure_count INTEGER NOT NULL,
          source_refs_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_by TEXT NOT NULL,
          provisional_effect TEXT,
          provisional_rationale TEXT,
          verify_before_use INTEGER NOT NULL DEFAULT 0,
          superseded_by_pattern_id TEXT,
          last_seen_at TEXT NOT NULL,
          expires_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_channel_team_patterns_channel_status
        ON channel_team_patterns(workspace_id, channel_id, status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_channel_team_patterns_expiry
        ON channel_team_patterns(workspace_id, channel_id, status, expires_at);
      `);
      if (!hasChannelTeamPatternsMigration) {
        context.recordMigration(CHANNEL_TEAM_PATTERNS_MIGRATION_VERSION, CHANNEL_TEAM_PATTERNS_MIGRATION_NAME);
      }
    }

    const hasChannelTeamSnapshotsMigration = context.hasMigration(CHANNEL_TEAM_SNAPSHOTS_MIGRATION_VERSION);
    if (
      !hasChannelTeamSnapshotsMigration ||
      !context.hasTable("channel_team_snapshots") ||
      !context.hasTable("channel_team_evaluations")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS channel_team_snapshots (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_by TEXT NOT NULL,
          state_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_channel_team_snapshots_channel_created
        ON channel_team_snapshots(workspace_id, channel_id, created_at);

        CREATE TABLE IF NOT EXISTS channel_team_evaluations (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          snapshot_id TEXT,
          cases_json TEXT NOT NULL,
          results_json TEXT NOT NULL,
          summary_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(snapshot_id) REFERENCES channel_team_snapshots(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_channel_team_evaluations_channel_created
        ON channel_team_evaluations(workspace_id, channel_id, created_at);
      `);
      if (!hasChannelTeamSnapshotsMigration) {
        context.recordMigration(CHANNEL_TEAM_SNAPSHOTS_MIGRATION_VERSION, CHANNEL_TEAM_SNAPSHOTS_MIGRATION_NAME);
      }
    }

    const hasRuntimeSupervisorMigration = context.hasMigration(RUNTIME_SUPERVISOR_MIGRATION_VERSION);
    if (
      !hasRuntimeSupervisorMigration ||
      !context.hasColumn("run_sessions", "work_unit_id") ||
      !context.hasTable("work_units") ||
      !context.hasTable("work_unit_attempts") ||
      !context.hasTable("runtime_events") ||
      !context.hasTable("runtime_heartbeats") ||
      !context.hasTable("runtime_semaphore_slots") ||
      !context.hasColumn("resource_leases", "last_renewed_at") ||
      !context.hasColumn("resource_leases", "release_reason") ||
      !context.hasColumn("resource_leases", "work_unit_id") ||
      !context.hasColumn("resource_leases", "attempt_id")
    ) {
      if (!context.hasColumn("run_sessions", "work_unit_id")) {
        database.exec("ALTER TABLE run_sessions ADD COLUMN work_unit_id TEXT;");
      }
      if (!context.hasColumn("resource_leases", "last_renewed_at")) {
        database.exec("ALTER TABLE resource_leases ADD COLUMN last_renewed_at TEXT;");
        database.exec("UPDATE resource_leases SET last_renewed_at = acquired_at WHERE last_renewed_at IS NULL;");
      }
      if (!context.hasColumn("resource_leases", "release_reason")) {
        database.exec("ALTER TABLE resource_leases ADD COLUMN release_reason TEXT;");
      }
      if (!context.hasColumn("resource_leases", "work_unit_id")) {
        database.exec("ALTER TABLE resource_leases ADD COLUMN work_unit_id TEXT;");
      }
      if (!context.hasColumn("resource_leases", "attempt_id")) {
        database.exec("ALTER TABLE resource_leases ADD COLUMN attempt_id TEXT;");
      }

      database.exec(`
        CREATE TABLE IF NOT EXISTS work_units (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          owner_type TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          channel_id TEXT,
          task_id TEXT,
          teammate_id TEXT,
          provider_preset_id TEXT,
          runner_id TEXT,
          requested_runner_id TEXT,
          effective_runner_id TEXT,
          runner_fallback_reason_json TEXT,
          idempotency_key TEXT NOT NULL,
          status TEXT NOT NULL,
          priority INTEGER NOT NULL,
          attempt_count INTEGER NOT NULL,
          active_attempt_id TEXT,
          created_by_client_id TEXT,
          created_by_actor TEXT NOT NULL,
          request_json TEXT NOT NULL,
          timeout_policy_json TEXT NOT NULL,
          linked_run_id TEXT,
          linked_message_id TEXT,
          linked_media_job_id TEXT,
          linked_external_work_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          ended_at TEXT,
          last_event_at TEXT,
          last_heartbeat_at TEXT,
          error_code TEXT,
          error_message TEXT,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(linked_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_work_units_idempotency
        ON work_units(workspace_id, kind, owner_type, owner_id, idempotency_key);

        CREATE INDEX IF NOT EXISTS idx_work_units_status_priority
        ON work_units(workspace_id, status, priority, created_at);

        CREATE INDEX IF NOT EXISTS idx_work_units_owner
        ON work_units(workspace_id, owner_type, owner_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_work_units_linked_run
        ON work_units(linked_run_id);

        CREATE INDEX IF NOT EXISTS idx_run_sessions_work_unit
        ON run_sessions(work_unit_id);

        CREATE TABLE IF NOT EXISTS work_unit_attempts (
          id TEXT PRIMARY KEY,
          work_unit_id TEXT NOT NULL,
          attempt_number INTEGER NOT NULL,
          runtime_instance_id TEXT NOT NULL,
          runner_id TEXT NOT NULL,
          requested_runner_id TEXT,
          effective_runner_id TEXT,
          runner_fallback_reason_json TEXT,
          provider_preset_id TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          started_at TEXT,
          ended_at TEXT,
          last_event_at TEXT,
          last_heartbeat_at TEXT,
          abort_requested_at TEXT,
          error_code TEXT,
          error_message TEXT,
          FOREIGN KEY(work_unit_id) REFERENCES work_units(id) ON DELETE CASCADE,
          UNIQUE(work_unit_id, attempt_number)
        );

        CREATE INDEX IF NOT EXISTS idx_work_unit_attempts_work_unit
        ON work_unit_attempts(work_unit_id, attempt_number);

        CREATE INDEX IF NOT EXISTS idx_work_unit_attempts_runtime
        ON work_unit_attempts(runtime_instance_id, status);

        CREATE TABLE IF NOT EXISTS runtime_events (
          id TEXT PRIMARY KEY,
          work_unit_id TEXT NOT NULL,
          attempt_id TEXT,
          seq INTEGER NOT NULL,
          ts TEXT NOT NULL,
          type TEXT NOT NULL,
          actor TEXT NOT NULL,
          data_json TEXT NOT NULL,
          FOREIGN KEY(work_unit_id) REFERENCES work_units(id) ON DELETE CASCADE,
          FOREIGN KEY(attempt_id) REFERENCES work_unit_attempts(id) ON DELETE SET NULL,
          UNIQUE(work_unit_id, seq)
        );

        CREATE INDEX IF NOT EXISTS idx_runtime_events_work_unit_seq
        ON runtime_events(work_unit_id, seq);

        CREATE INDEX IF NOT EXISTS idx_runtime_events_type_ts
        ON runtime_events(type, ts);

        CREATE TABLE IF NOT EXISTS runtime_heartbeats (
          id TEXT PRIMARY KEY,
          work_unit_id TEXT NOT NULL,
          attempt_id TEXT NOT NULL,
          runtime_instance_id TEXT NOT NULL,
          ts TEXT NOT NULL,
          source TEXT NOT NULL,
          detail_json TEXT,
          FOREIGN KEY(work_unit_id) REFERENCES work_units(id) ON DELETE CASCADE,
          FOREIGN KEY(attempt_id) REFERENCES work_unit_attempts(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_runtime_heartbeats_attempt_ts
        ON runtime_heartbeats(attempt_id, ts);

        CREATE INDEX IF NOT EXISTS idx_runtime_heartbeats_runtime_ts
        ON runtime_heartbeats(runtime_instance_id, ts);

        CREATE TABLE IF NOT EXISTS runtime_semaphore_slots (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_key TEXT NOT NULL,
          owner_type TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          work_unit_id TEXT NOT NULL,
          attempt_id TEXT NOT NULL,
          status TEXT NOT NULL,
          acquired_at TEXT NOT NULL,
          last_renewed_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          released_at TEXT,
          release_reason TEXT,
          FOREIGN KEY(work_unit_id) REFERENCES work_units(id) ON DELETE CASCADE,
          FOREIGN KEY(attempt_id) REFERENCES work_unit_attempts(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_runtime_semaphore_active
        ON runtime_semaphore_slots(workspace_id, resource_type, resource_key, status, expires_at);

        CREATE INDEX IF NOT EXISTS idx_runtime_semaphore_owner
        ON runtime_semaphore_slots(owner_id, status);

        CREATE INDEX IF NOT EXISTS idx_runtime_semaphore_work_unit
        ON runtime_semaphore_slots(work_unit_id, status);

        CREATE INDEX IF NOT EXISTS idx_resource_leases_work_unit
        ON resource_leases(work_unit_id, attempt_id, status);
      `);

      if (!hasRuntimeSupervisorMigration) {
        context.recordMigration(RUNTIME_SUPERVISOR_MIGRATION_VERSION, RUNTIME_SUPERVISOR_MIGRATION_NAME);
      }
    }

    const hasMcpToolManagementMigration = context.hasMigration(MCP_TOOL_MANAGEMENT_MIGRATION_VERSION);
    if (
      !hasMcpToolManagementMigration ||
      !context.hasTable("mcp_servers") ||
      !context.hasTable("mcp_server_secrets") ||
      !context.hasTable("mcp_tools") ||
      !context.hasTable("teammate_mcp_bindings")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS mcp_servers (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          transport_json TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          required INTEGER NOT NULL,
          status_json TEXT NOT NULL,
          startup_timeout_sec INTEGER,
          tool_timeout_sec INTEGER,
          enabled_tools_json TEXT,
          disabled_tools_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_mcp_servers_workspace
        ON mcp_servers(workspace_id, enabled, created_at);

        CREATE TABLE IF NOT EXISTS mcp_server_secrets (
          server_id TEXT NOT NULL,
          secret_name TEXT NOT NULL,
          secret_value TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(server_id, secret_name),
          FOREIGN KEY(server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS mcp_tools (
          server_id TEXT NOT NULL,
          raw_name TEXT NOT NULL,
          display_name TEXT NOT NULL,
          description TEXT,
          input_schema_json TEXT NOT NULL,
          callable_namespace TEXT NOT NULL,
          callable_name TEXT NOT NULL,
          side_effect_level TEXT NOT NULL,
          default_approval TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(server_id, raw_name),
          FOREIGN KEY(server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_mcp_tools_server_enabled
        ON mcp_tools(server_id, enabled, raw_name);

        CREATE TABLE IF NOT EXISTS teammate_mcp_bindings (
          teammate_id TEXT NOT NULL,
          server_id TEXT NOT NULL,
          mode TEXT NOT NULL,
          selected_tool_names_json TEXT NOT NULL,
          approval_overrides_json TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(teammate_id, server_id),
          FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE,
          FOREIGN KEY(server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_teammate_mcp_bindings_server
        ON teammate_mcp_bindings(server_id, enabled);
      `);

      if (!hasMcpToolManagementMigration) {
        context.recordMigration(MCP_TOOL_MANAGEMENT_MIGRATION_VERSION, MCP_TOOL_MANAGEMENT_MIGRATION_NAME);
      }
    }

    const hasLingMemoryMigration = context.hasMigration(LING_MEMORY_MIGRATION_VERSION);
    if (!hasLingMemoryMigration || !context.hasTable("memory_objects") || !context.hasTable("memory_used_events")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS memory_objects (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          scope_type TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          tags_json TEXT NOT NULL,
          source_refs_json TEXT NOT NULL,
          review_state TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          sensitivity TEXT NOT NULL,
          verify_before_use INTEGER NOT NULL DEFAULT 0,
          retrieval_provider_id TEXT,
          retrieval_handle TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_used_at TEXT,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_memory_objects_scope
        ON memory_objects(workspace_id, scope_type, owner_id, review_state, enabled);

        CREATE INDEX IF NOT EXISTS idx_memory_objects_updated
        ON memory_objects(workspace_id, updated_at);

        CREATE INDEX IF NOT EXISTS idx_memory_objects_last_used
        ON memory_objects(workspace_id, last_used_at);

        CREATE TABLE IF NOT EXISTS memory_used_events (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          memory_ids_json TEXT NOT NULL,
          intent TEXT NOT NULL,
          recall_query TEXT NOT NULL,
          teammate_id TEXT,
          channel_id TEXT,
          task_id TEXT,
          run_id TEXT,
          response_id TEXT,
          policy_version TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_memory_used_events_run
        ON memory_used_events(workspace_id, run_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_memory_used_events_response
        ON memory_used_events(workspace_id, response_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_memory_used_events_teammate_channel
        ON memory_used_events(workspace_id, teammate_id, channel_id, created_at);
      `);

      if (!hasLingMemoryMigration) {
        context.recordMigration(LING_MEMORY_MIGRATION_VERSION, LING_MEMORY_MIGRATION_NAME);
      }
    }

    const hasMemoryReviewPolicyMigration = context.hasMigration(MEMORY_REVIEW_POLICY_MIGRATION_VERSION);
    if (
      !hasMemoryReviewPolicyMigration ||
      !context.hasTable("memory_review_policy") ||
      !context.hasTable("memory_review_decisions") ||
      !context.hasTable("memory_review_actions") ||
      !context.hasColumn("memory_review_actions", "source_refs_json")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS memory_review_policy (
          workspace_id TEXT PRIMARY KEY,
          mode TEXT NOT NULL,
          auto_active_same_scope INTEGER NOT NULL,
          auto_active_user_explicit INTEGER NOT NULL,
          require_manual_for_workspace INTEGER NOT NULL,
          require_manual_for_persona INTEGER NOT NULL,
          require_manual_for_cross_scope INTEGER NOT NULL,
          quarantine_secret_adjacent INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS memory_review_decisions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          memory_id TEXT NOT NULL,
          outcome TEXT NOT NULL,
          mode TEXT NOT NULL,
          reason_code TEXT NOT NULL,
          reason TEXT NOT NULL,
          confidence TEXT NOT NULL,
          requires_manual_review INTEGER NOT NULL,
          quarantine_reason TEXT,
          target_review_state TEXT NOT NULL,
          target_sensitivity TEXT NOT NULL,
          source_refs_json TEXT NOT NULL,
          decided_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(memory_id) REFERENCES memory_objects(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_memory_review_decisions_memory
        ON memory_review_decisions(memory_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_memory_review_decisions_workspace_outcome
        ON memory_review_decisions(workspace_id, outcome, created_at);

        CREATE TABLE IF NOT EXISTS memory_review_actions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          memory_id TEXT NOT NULL,
          action TEXT NOT NULL,
          previous_review_state TEXT NOT NULL,
          next_review_state TEXT NOT NULL,
          source_refs_json TEXT NOT NULL DEFAULT '[]',
          edited_memory_json TEXT,
          reason TEXT,
          actor TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(memory_id) REFERENCES memory_objects(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_memory_review_actions_memory
        ON memory_review_actions(memory_id, created_at);
      `);
      if (context.hasTable("memory_review_actions") && !context.hasColumn("memory_review_actions", "source_refs_json")) {
        database.exec("ALTER TABLE memory_review_actions ADD COLUMN source_refs_json TEXT NOT NULL DEFAULT '[]';");
      }

      if (!hasMemoryReviewPolicyMigration) {
        context.recordMigration(MEMORY_REVIEW_POLICY_MIGRATION_VERSION, MEMORY_REVIEW_POLICY_MIGRATION_NAME);
      }
    }

    const hasMemoryConsolidationJobsMigration = context.hasMigration(MEMORY_CONSOLIDATION_JOBS_MIGRATION_VERSION);
    if (!hasMemoryConsolidationJobsMigration || !context.hasTable("memory_consolidation_jobs")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS memory_consolidation_jobs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          source_refs_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_candidate_ids_json TEXT NOT NULL,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_memory_consolidation_jobs_workspace
        ON memory_consolidation_jobs(workspace_id, status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_memory_consolidation_jobs_kind
        ON memory_consolidation_jobs(workspace_id, kind, updated_at);
      `);

      if (!hasMemoryConsolidationJobsMigration) {
        context.recordMigration(MEMORY_CONSOLIDATION_JOBS_MIGRATION_VERSION, MEMORY_CONSOLIDATION_JOBS_MIGRATION_NAME);
      }
    }

    const hasMemoryHealthMigration = context.hasMigration(MEMORY_HEALTH_MIGRATION_VERSION);
    if (
      !hasMemoryHealthMigration ||
      !context.hasColumn("memory_objects", "verify_before_use") ||
      !context.hasTable("memory_self_improving_metadata")
    ) {
      if (context.hasTable("memory_objects") && !context.hasColumn("memory_objects", "verify_before_use")) {
        database.exec("ALTER TABLE memory_objects ADD COLUMN verify_before_use INTEGER NOT NULL DEFAULT 0;");
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS memory_self_improving_metadata (
          memory_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          trigger TEXT NOT NULL,
          lesson TEXT NOT NULL,
          use_when_json TEXT NOT NULL,
          do_not_use_when_json TEXT NOT NULL,
          valid_until TEXT,
          last_seen_at TEXT,
          evidence_count INTEGER NOT NULL,
          superseded_by TEXT,
          last_used_at TEXT,
          use_count INTEGER NOT NULL,
          FOREIGN KEY(memory_id) REFERENCES memory_objects(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_memory_self_improving_metadata_kind
        ON memory_self_improving_metadata(kind);

        CREATE INDEX IF NOT EXISTS idx_memory_self_improving_metadata_superseded
        ON memory_self_improving_metadata(superseded_by);
      `);

      if (!hasMemoryHealthMigration) {
        context.recordMigration(MEMORY_HEALTH_MIGRATION_VERSION, MEMORY_HEALTH_MIGRATION_NAME);
      }
    }

    const hasManagedPluginsMigration = context.hasMigration(MANAGED_PLUGINS_MIGRATION_VERSION);
    if (
      !hasManagedPluginsMigration ||
      !context.hasTable("managed_plugins") ||
      !context.hasTable("managed_plugin_contributions") ||
      !context.hasTable("managed_plugin_health_snapshots") ||
      !context.hasTable("managed_plugin_events")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS managed_plugins (
          id TEXT PRIMARY KEY,
          source_kind TEXT NOT NULL,
          version TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          disabled_reason TEXT,
          descriptor_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS managed_plugin_contributions (
          plugin_id TEXT NOT NULL,
          contribution_kind TEXT NOT NULL,
          contribution_id TEXT NOT NULL,
          linked_resource_id TEXT,
          enabled INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(plugin_id, contribution_kind, contribution_id),
          FOREIGN KEY(plugin_id) REFERENCES managed_plugins(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_managed_plugin_contributions_linked
        ON managed_plugin_contributions(linked_resource_id);

        CREATE TABLE IF NOT EXISTS managed_plugin_health_snapshots (
          plugin_id TEXT PRIMARY KEY,
          status_json TEXT NOT NULL,
          checked_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(plugin_id) REFERENCES managed_plugins(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_managed_plugin_health_expires
        ON managed_plugin_health_snapshots(expires_at);

        CREATE TABLE IF NOT EXISTS managed_plugin_events (
          id TEXT PRIMARY KEY,
          plugin_id TEXT NOT NULL,
          type TEXT NOT NULL,
          actor TEXT NOT NULL,
          message TEXT,
          data_json TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY(plugin_id) REFERENCES managed_plugins(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_managed_plugin_events_plugin_created
        ON managed_plugin_events(plugin_id, created_at);
      `);

      if (!hasManagedPluginsMigration) {
        context.recordMigration(MANAGED_PLUGINS_MIGRATION_VERSION, MANAGED_PLUGINS_MIGRATION_NAME);
      }
    }

    const hasManagedPluginPackagesMigration = context.hasMigration(MANAGED_PLUGIN_PACKAGES_MIGRATION_VERSION);
    if (
      !hasManagedPluginPackagesMigration ||
      !context.hasTable("managed_plugin_packages") ||
      !context.hasTable("managed_plugin_runtime_snapshots")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS managed_plugin_packages (
          plugin_id TEXT PRIMARY KEY,
          source_kind TEXT NOT NULL,
          version TEXT NOT NULL,
          status TEXT NOT NULL,
          cache_ref TEXT NOT NULL,
          package_hash TEXT,
          manifest_json TEXT NOT NULL,
          installed_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          uninstalled_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_managed_plugin_packages_status
        ON managed_plugin_packages(status);

        CREATE TABLE IF NOT EXISTS managed_plugin_runtime_snapshots (
          id TEXT PRIMARY KEY,
          run_id TEXT,
          cwd TEXT NOT NULL,
          plugin_ids_json TEXT NOT NULL,
          capabilities_json TEXT NOT NULL,
          policy_overlays_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_managed_plugin_runtime_snapshots_run
        ON managed_plugin_runtime_snapshots(run_id);

        CREATE INDEX IF NOT EXISTS idx_managed_plugin_runtime_snapshots_created
        ON managed_plugin_runtime_snapshots(created_at);
      `);

      if (!hasManagedPluginPackagesMigration) {
        context.recordMigration(MANAGED_PLUGIN_PACKAGES_MIGRATION_VERSION, MANAGED_PLUGIN_PACKAGES_MIGRATION_NAME);
      }
    }

    const hasSkillAwareRunMigration = context.hasMigration(SKILL_AWARE_RUN_MIGRATION_VERSION);
    if (
      !hasSkillAwareRunMigration ||
      !context.hasColumn("tasks", "requested_skill_id") ||
      !context.hasColumn("run_sessions", "selected_skill_id")
    ) {
      if (!context.hasColumn("tasks", "requested_skill_id")) {
        database.exec("ALTER TABLE tasks ADD COLUMN requested_skill_id TEXT;");
      }
      if (!context.hasColumn("run_sessions", "selected_skill_id")) {
        database.exec("ALTER TABLE run_sessions ADD COLUMN selected_skill_id TEXT;");
      }
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_requested_skill
        ON tasks(requested_skill_id);

        CREATE INDEX IF NOT EXISTS idx_run_sessions_selected_skill
        ON run_sessions(selected_skill_id);
      `);
      if (!hasSkillAwareRunMigration) {
        context.recordMigration(SKILL_AWARE_RUN_MIGRATION_VERSION, SKILL_AWARE_RUN_MIGRATION_NAME);
      }
    }

    const hasPrivateWorkspaceDataLifecycleMigration = context.hasMigration(PRIVATE_WORKSPACE_DATA_LIFECYCLE_MIGRATION_VERSION);
    if (
      !hasPrivateWorkspaceDataLifecycleMigration ||
      !context.hasColumn("teammate_direct_messages", "attachment_ids_json") ||
      !context.hasTable("teammate_private_attachments") ||
      !context.hasTable("retention_tombstones")
    ) {
      if (!context.hasColumn("teammate_direct_messages", "attachment_ids_json")) {
        database.exec("ALTER TABLE teammate_direct_messages ADD COLUMN attachment_ids_json TEXT NOT NULL DEFAULT '[]';");
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS teammate_private_attachments (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          teammate_id TEXT NOT NULL,
          thread_id TEXT,
          message_id TEXT,
          scope TEXT NOT NULL,
          kind TEXT NOT NULL,
          file_name TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          path TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE,
          FOREIGN KEY(thread_id) REFERENCES teammate_direct_threads(id) ON DELETE CASCADE,
          FOREIGN KEY(message_id) REFERENCES teammate_direct_messages(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_teammate_private_attachments_owner
        ON teammate_private_attachments(teammate_id, scope, created_at);

        CREATE INDEX IF NOT EXISTS idx_teammate_private_attachments_thread
        ON teammate_private_attachments(thread_id, created_at);

        CREATE TABLE IF NOT EXISTS retention_tombstones (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          reason TEXT,
          deleted_counts_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_retention_tombstones_entity
        ON retention_tombstones(workspace_id, entity_type, entity_id, created_at);
      `);
      if (!hasPrivateWorkspaceDataLifecycleMigration) {
        context.recordMigration(PRIVATE_WORKSPACE_DATA_LIFECYCLE_MIGRATION_VERSION, PRIVATE_WORKSPACE_DATA_LIFECYCLE_MIGRATION_NAME);
      }
    }

    const hasSkillRegistryMigration = context.hasMigration(SKILL_REGISTRY_MIGRATION_VERSION);
    if (
      !hasSkillRegistryMigration ||
      !context.hasTable("skill_packs") ||
      !context.hasTable("skill_definitions") ||
      !context.hasTable("skill_import_drafts")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS skill_packs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          source TEXT NOT NULL,
          name TEXT NOT NULL,
          version TEXT,
          description TEXT NOT NULL,
          source_path TEXT,
          checksum TEXT,
          review_status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_skill_packs_workspace_status
        ON skill_packs(workspace_id, review_status, updated_at);

        CREATE TABLE IF NOT EXISTS skill_definitions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          pack_id TEXT NOT NULL,
          source TEXT NOT NULL,
          source_path TEXT,
          version TEXT,
          checksum TEXT,
          definition_json TEXT NOT NULL,
          visibility_json TEXT NOT NULL,
          review_status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(pack_id) REFERENCES skill_packs(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_skill_definitions_workspace_status
        ON skill_definitions(workspace_id, review_status, source, id);

        CREATE TABLE IF NOT EXISTS skill_import_drafts (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          source TEXT NOT NULL,
          source_path TEXT,
          draft_json TEXT NOT NULL,
          warnings_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_skill_import_drafts_workspace_updated
        ON skill_import_drafts(workspace_id, updated_at);
      `);
      if (!hasSkillRegistryMigration) {
        context.recordMigration(SKILL_REGISTRY_MIGRATION_VERSION, SKILL_REGISTRY_MIGRATION_NAME);
      }
    }

    const hasRunInterventionsMigration = context.hasMigration(RUN_INTERVENTIONS_MIGRATION_VERSION);
    if (
      !hasRunInterventionsMigration ||
      !context.hasTable("run_interventions") ||
      !context.hasColumn("run_sessions", "parent_run_id") ||
      !context.hasColumn("run_sessions", "intervention_id") ||
      !context.hasColumn("run_sessions", "continuation_reason")
    ) {
      if (!context.hasColumn("run_sessions", "parent_run_id")) {
        database.exec("ALTER TABLE run_sessions ADD COLUMN parent_run_id TEXT;");
      }
      if (!context.hasColumn("run_sessions", "intervention_id")) {
        database.exec("ALTER TABLE run_sessions ADD COLUMN intervention_id TEXT;");
      }
      if (!context.hasColumn("run_sessions", "continuation_reason")) {
        database.exec("ALTER TABLE run_sessions ADD COLUMN continuation_reason TEXT;");
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS run_interventions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          source_run_id TEXT NOT NULL,
          source_work_unit_id TEXT,
          source_attempt_id TEXT,
          continuation_run_id TEXT,
          continuation_work_unit_id TEXT,
          mode TEXT NOT NULL,
          status TEXT NOT NULL,
          instruction TEXT NOT NULL,
          message_payload_json TEXT,
          requested_by TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          failure_reason TEXT,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(source_run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
          FOREIGN KEY(continuation_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_run_interventions_idempotency
        ON run_interventions(source_run_id, idempotency_key);

        CREATE INDEX IF NOT EXISTS idx_run_interventions_source_status
        ON run_interventions(source_run_id, status, created_at);

        CREATE INDEX IF NOT EXISTS idx_run_interventions_continuation
        ON run_interventions(continuation_run_id);

        CREATE INDEX IF NOT EXISTS idx_run_sessions_parent_run
        ON run_sessions(parent_run_id);

        CREATE INDEX IF NOT EXISTS idx_run_sessions_intervention
        ON run_sessions(intervention_id);
      `);
      if (!hasRunInterventionsMigration) {
        context.recordMigration(RUN_INTERVENTIONS_MIGRATION_VERSION, RUN_INTERVENTIONS_MIGRATION_NAME);
      }
    }

    const hasRunnerAuditMigration = context.hasMigration(RUNNER_AUDIT_MIGRATION_VERSION);
    if (
      !hasRunnerAuditMigration ||
      !context.hasColumn("ai_teammates", "runner_id") ||
      !context.hasColumn("work_units", "requested_runner_id") ||
      !context.hasColumn("work_units", "effective_runner_id") ||
      !context.hasColumn("work_units", "runner_fallback_reason_json") ||
      !context.hasColumn("work_unit_attempts", "requested_runner_id") ||
      !context.hasColumn("work_unit_attempts", "effective_runner_id") ||
      !context.hasColumn("work_unit_attempts", "runner_fallback_reason_json")
    ) {
      if (!context.hasColumn("ai_teammates", "runner_id")) {
        database.exec("ALTER TABLE ai_teammates ADD COLUMN runner_id TEXT;");
      }
      if (!context.hasColumn("work_units", "requested_runner_id")) {
        database.exec("ALTER TABLE work_units ADD COLUMN requested_runner_id TEXT;");
      }
      if (!context.hasColumn("work_units", "effective_runner_id")) {
        database.exec("ALTER TABLE work_units ADD COLUMN effective_runner_id TEXT;");
      }
      if (!context.hasColumn("work_units", "runner_fallback_reason_json")) {
        database.exec("ALTER TABLE work_units ADD COLUMN runner_fallback_reason_json TEXT;");
      }
      if (!context.hasColumn("work_unit_attempts", "requested_runner_id")) {
        database.exec("ALTER TABLE work_unit_attempts ADD COLUMN requested_runner_id TEXT;");
      }
      if (!context.hasColumn("work_unit_attempts", "effective_runner_id")) {
        database.exec("ALTER TABLE work_unit_attempts ADD COLUMN effective_runner_id TEXT;");
      }
      if (!context.hasColumn("work_unit_attempts", "runner_fallback_reason_json")) {
        database.exec("ALTER TABLE work_unit_attempts ADD COLUMN runner_fallback_reason_json TEXT;");
      }
      if (!hasRunnerAuditMigration) {
        context.recordMigration(RUNNER_AUDIT_MIGRATION_VERSION, RUNNER_AUDIT_MIGRATION_NAME);
      }
    }

    const hasChannelWorkflowStepMetadataMigration = context.hasMigration(CHANNEL_WORKFLOW_STEP_METADATA_MIGRATION_VERSION);
    if (!hasChannelWorkflowStepMetadataMigration || !context.hasColumn("channel_workflow_steps", "metadata_json")) {
      if (!context.hasColumn("channel_workflow_steps", "metadata_json")) {
        database.exec("ALTER TABLE channel_workflow_steps ADD COLUMN metadata_json TEXT;");
      }
      if (!hasChannelWorkflowStepMetadataMigration) {
        context.recordMigration(CHANNEL_WORKFLOW_STEP_METADATA_MIGRATION_VERSION, CHANNEL_WORKFLOW_STEP_METADATA_MIGRATION_NAME);
      }
    }

    const hasLingThreadsMigration = context.hasMigration(LING_THREADS_MIGRATION_VERSION);
    if (!hasLingThreadsMigration || !context.hasTable("ling_threads") || !context.hasColumn("run_sessions", "thread_id")) {
      if (!context.hasColumn("run_sessions", "thread_id")) {
        database.exec("ALTER TABLE run_sessions ADD COLUMN thread_id TEXT;");
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS ling_threads (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          channel_id TEXT,
          task_id TEXT,
          teammate_id TEXT,
          workflow_id TEXT,
          workflow_step_id TEXT,
          external_work_id TEXT,
          title TEXT NOT NULL,
          objective TEXT NOT NULL,
          status TEXT NOT NULL,
          active_run_id TEXT,
          last_run_id TEXT,
          parent_thread_id TEXT,
          parent_turn_id TEXT,
          forked_from_run_id TEXT,
          metadata_json TEXT,
          conversation_mode TEXT NOT NULL DEFAULT 'default',
          conversation_mode_updated_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          pinned_at TEXT,
          archived_at TEXT,
          archived_reason TEXT,
          surface_kind TEXT NOT NULL DEFAULT 'work',
          relation_kind TEXT NOT NULL DEFAULT 'root',
          anchor_item_id TEXT,
          fork_context_snapshot_id TEXT,
          next_item_sequence INTEGER NOT NULL DEFAULT 1,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(active_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL,
          FOREIGN KEY(last_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL,
          FOREIGN KEY(parent_thread_id) REFERENCES ling_threads(id) ON DELETE SET NULL,
          FOREIGN KEY(parent_turn_id) REFERENCES ling_turns(id) ON DELETE SET NULL,
          FOREIGN KEY(forked_from_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_ling_threads_owner
        ON ling_threads(workspace_id, kind, task_id, workflow_step_id, external_work_id, teammate_id, channel_id);

        CREATE INDEX IF NOT EXISTS idx_ling_threads_status_updated
        ON ling_threads(workspace_id, status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_ling_threads_visible_channel
        ON ling_threads(channel_id, archived_at, pinned_at, updated_at);

        CREATE INDEX IF NOT EXISTS idx_run_sessions_thread
        ON run_sessions(thread_id);
      `);
      if (!hasLingThreadsMigration) {
        context.recordMigration(LING_THREADS_MIGRATION_VERSION, LING_THREADS_MIGRATION_NAME);
      }
    }

    const hasApprovalWorkflowStepOwnerMigration = context.hasMigration(APPROVAL_WORKFLOW_STEP_OWNER_MIGRATION_VERSION);
    if (!hasApprovalWorkflowStepOwnerMigration || !context.hasColumn("approval_requests", "workflow_step_id")) {
      database.exec(`
        DROP TABLE IF EXISTS approval_requests_next;

        CREATE TABLE approval_requests_next (
          id TEXT PRIMARY KEY,
          run_id TEXT,
          task_id TEXT,
          media_job_id TEXT,
          external_work_action_id TEXT,
          workflow_step_id TEXT,
          channel_id TEXT,
          tool_call_id TEXT,
          action_type TEXT NOT NULL,
          risk TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          resolved_at TEXT,
          resolved_by TEXT,
          decision_reason TEXT,
          CHECK (
            (run_id IS NOT NULL AND task_id IS NOT NULL AND media_job_id IS NULL AND external_work_action_id IS NULL AND workflow_step_id IS NULL)
            OR (run_id IS NULL AND task_id IS NULL AND media_job_id IS NOT NULL AND external_work_action_id IS NULL AND workflow_step_id IS NULL)
            OR (run_id IS NULL AND task_id IS NULL AND media_job_id IS NULL AND external_work_action_id IS NOT NULL AND workflow_step_id IS NULL)
            OR (run_id IS NULL AND task_id IS NULL AND media_job_id IS NULL AND external_work_action_id IS NULL AND workflow_step_id IS NOT NULL)
          ),
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
          FOREIGN KEY(media_job_id) REFERENCES media_jobs(id) ON DELETE CASCADE,
          FOREIGN KEY(external_work_action_id) REFERENCES external_work_actions(id) ON DELETE CASCADE,
          FOREIGN KEY(workflow_step_id) REFERENCES channel_workflow_steps(id) ON DELETE CASCADE
        );

        INSERT INTO approval_requests_next (
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
        )
        SELECT
          id,
          run_id,
          task_id,
          media_job_id,
          external_work_action_id,
          NULL,
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
        FROM approval_requests;

        DROP TABLE approval_requests;
        ALTER TABLE approval_requests_next RENAME TO approval_requests;

        CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_run ON approval_requests(run_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_task ON approval_requests(task_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_media_job ON approval_requests(media_job_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_external_work_action ON approval_requests(external_work_action_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_workflow_step ON approval_requests(workflow_step_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_created_at ON approval_requests(created_at);
      `);
      if (!hasApprovalWorkflowStepOwnerMigration) {
        context.recordMigration(APPROVAL_WORKFLOW_STEP_OWNER_MIGRATION_VERSION, APPROVAL_WORKFLOW_STEP_OWNER_MIGRATION_NAME);
      }
    }

    const hasRunWorkflowStepOwnerMigration = context.hasMigration(RUN_WORKFLOW_STEP_OWNER_MIGRATION_VERSION);
    if (!hasRunWorkflowStepOwnerMigration || !context.hasColumn("run_sessions", "workflow_step_id")) {
      if (!context.hasColumn("run_sessions", "workflow_step_id")) {
        database.exec("ALTER TABLE run_sessions ADD COLUMN workflow_step_id TEXT;");
      }
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_run_sessions_workflow_step
        ON run_sessions(workflow_step_id);
      `);
      if (!hasRunWorkflowStepOwnerMigration) {
        context.recordMigration(RUN_WORKFLOW_STEP_OWNER_MIGRATION_VERSION, RUN_WORKFLOW_STEP_OWNER_MIGRATION_NAME);
      }
    }

    const hasMcpStatusSnapshotsMigration = context.hasMigration(MCP_STATUS_SNAPSHOTS_MIGRATION_VERSION);
    if (!hasMcpStatusSnapshotsMigration || !context.hasTable("mcp_status_snapshots")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS mcp_status_snapshots (
          server_id TEXT PRIMARY KEY,
          status_json TEXT NOT NULL,
          checked_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_mcp_status_snapshots_expires
        ON mcp_status_snapshots(expires_at);
      `);
      if (!hasMcpStatusSnapshotsMigration) {
        context.recordMigration(MCP_STATUS_SNAPSHOTS_MIGRATION_VERSION, MCP_STATUS_SNAPSHOTS_MIGRATION_NAME);
      }
    }

    const hasAutomationsMigration = context.hasMigration(AUTOMATIONS_MIGRATION_VERSION);
    if (!hasAutomationsMigration || !context.hasTable("automation_definitions") || !context.hasTable("automation_runs")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS automation_definitions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT,
          thread_id TEXT NOT NULL,
          automation_mode TEXT NOT NULL DEFAULT 'cron',
          title TEXT NOT NULL,
          description TEXT,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          trigger_json TEXT NOT NULL,
          rrule TEXT,
          cwds_json TEXT NOT NULL DEFAULT '[]',
          target_thread_id TEXT,
          execution_environment TEXT,
          reasoning_effort TEXT,
          model TEXT,
          target_json TEXT NOT NULL,
          prompt_template_json TEXT NOT NULL,
          execution_policy_json TEXT NOT NULL,
          output_policy_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_run_id TEXT,
          next_run_at TEXT,
          last_error_message TEXT,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(thread_id) REFERENCES ling_threads(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS automation_runs (
          id TEXT PRIMARY KEY,
          automation_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          channel_id TEXT,
          thread_id TEXT NOT NULL,
          run_id TEXT,
          trigger_type TEXT NOT NULL,
          scheduled_for TEXT,
          fired_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          status TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          context_preview_artifact_id TEXT,
          output_artifact_ids_json TEXT NOT NULL,
          skip_reason TEXT,
          error_message TEXT,
          FOREIGN KEY(automation_id) REFERENCES automation_definitions(id) ON DELETE CASCADE,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(thread_id) REFERENCES ling_threads(id) ON DELETE CASCADE,
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_automation_definitions_status
        ON automation_definitions(status);

        CREATE INDEX IF NOT EXISTS idx_automation_definitions_kind
        ON automation_definitions(kind);

        CREATE INDEX IF NOT EXISTS idx_automation_definitions_channel
        ON automation_definitions(channel_id);

        CREATE INDEX IF NOT EXISTS idx_automation_runs_automation
        ON automation_runs(automation_id, fired_at);

        CREATE INDEX IF NOT EXISTS idx_automation_runs_run
        ON automation_runs(run_id);

        CREATE INDEX IF NOT EXISTS idx_automation_runs_status
        ON automation_runs(status);
      `);
      if (!hasAutomationsMigration) {
        context.recordMigration(AUTOMATIONS_MIGRATION_VERSION, AUTOMATIONS_MIGRATION_NAME);
      }
    }

    const hasAutomationCodexStyleFieldsMigration = context.hasMigration(AUTOMATION_CODEX_STYLE_FIELDS_MIGRATION_VERSION);
    if (
      !hasAutomationCodexStyleFieldsMigration ||
      !context.hasColumn("automation_definitions", "automation_mode") ||
      !context.hasColumn("automation_definitions", "cwds_json")
    ) {
      if (!context.hasColumn("automation_definitions", "automation_mode")) {
        database.exec("ALTER TABLE automation_definitions ADD COLUMN automation_mode TEXT NOT NULL DEFAULT 'cron';");
      }
      if (!context.hasColumn("automation_definitions", "rrule")) {
        database.exec("ALTER TABLE automation_definitions ADD COLUMN rrule TEXT;");
      }
      if (!context.hasColumn("automation_definitions", "cwds_json")) {
        database.exec("ALTER TABLE automation_definitions ADD COLUMN cwds_json TEXT NOT NULL DEFAULT '[]';");
      }
      if (!context.hasColumn("automation_definitions", "target_thread_id")) {
        database.exec("ALTER TABLE automation_definitions ADD COLUMN target_thread_id TEXT;");
      }
      if (!context.hasColumn("automation_definitions", "execution_environment")) {
        database.exec("ALTER TABLE automation_definitions ADD COLUMN execution_environment TEXT;");
      }
      if (!context.hasColumn("automation_definitions", "reasoning_effort")) {
        database.exec("ALTER TABLE automation_definitions ADD COLUMN reasoning_effort TEXT;");
      }
      if (!context.hasColumn("automation_definitions", "model")) {
        database.exec("ALTER TABLE automation_definitions ADD COLUMN model TEXT;");
      }
      if (!hasAutomationCodexStyleFieldsMigration) {
        context.recordMigration(AUTOMATION_CODEX_STYLE_FIELDS_MIGRATION_VERSION, AUTOMATION_CODEX_STYLE_FIELDS_MIGRATION_NAME);
      }
    }

    const hasAutomationDraftsMigration = context.hasMigration(AUTOMATION_DRAFTS_MIGRATION_VERSION);
    if (!hasAutomationDraftsMigration || !context.hasTable("automation_drafts")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS automation_drafts (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT,
          source TEXT NOT NULL,
          status TEXT NOT NULL,
          draft_json TEXT NOT NULL,
          missing_fields_json TEXT NOT NULL,
          warnings_json TEXT NOT NULL,
          proposed_by_run_id TEXT,
          proposed_by_thread_id TEXT,
          confirmed_automation_id TEXT,
          discarded_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(confirmed_automation_id) REFERENCES automation_definitions(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_automation_drafts_status
        ON automation_drafts(workspace_id, status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_automation_drafts_confirmed_automation
        ON automation_drafts(confirmed_automation_id);
      `);
      if (!hasAutomationDraftsMigration) {
        context.recordMigration(AUTOMATION_DRAFTS_MIGRATION_VERSION, AUTOMATION_DRAFTS_MIGRATION_NAME);
      }
    }

    const hasControlPlaneEventsMigration = context.hasMigration(CONTROL_PLANE_EVENTS_MIGRATION_VERSION);
    if (!hasControlPlaneEventsMigration || !context.hasTable("control_plane_events")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS control_plane_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id TEXT NOT NULL,
          cwd TEXT NOT NULL,
          ts TEXT NOT NULL,
          domain TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          action TEXT NOT NULL,
          data_json TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS control_plane_events_workspace_seq
        ON control_plane_events(workspace_id, seq);

        CREATE INDEX IF NOT EXISTS control_plane_events_workspace_domain_seq
        ON control_plane_events(workspace_id, domain, seq);
      `);
      if (!hasControlPlaneEventsMigration) {
        context.recordMigration(CONTROL_PLANE_EVENTS_MIGRATION_VERSION, CONTROL_PLANE_EVENTS_MIGRATION_NAME);
      }
    }

    const hasWorkItemsMigration = context.hasMigration(WORK_ITEMS_MIGRATION_VERSION);
    if (!hasWorkItemsMigration || !context.hasTable("work_items") || !context.hasTable("work_item_dependencies")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS work_items (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT,
          source_type TEXT NOT NULL,
          source_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL,
          waiting_reason TEXT,
          priority TEXT NOT NULL,
          labels_json TEXT NOT NULL,
          assignee_teammate_id TEXT,
          task_id TEXT,
          run_id TEXT,
          workflow_id TEXT,
          workflow_step_id TEXT,
          external_work_id TEXT,
          external_work_action_id TEXT,
          approval_id TEXT,
          artifact_ids_json TEXT NOT NULL,
          proof_artifact_ids_json TEXT NOT NULL,
          claim_owner_id TEXT,
          claim_token TEXT,
          claimed_at TEXT,
          heartbeat_at TEXT,
          claim_expires_at TEXT,
          attempt_count INTEGER NOT NULL,
          retry_budget INTEGER NOT NULL,
          completed_at TEXT,
          failed_at TEXT,
          failure_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(workspace_id, source_type, source_id)
        );

        CREATE TABLE IF NOT EXISTS work_item_dependencies (
          work_item_id TEXT NOT NULL,
          depends_on_work_item_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(work_item_id, depends_on_work_item_id),
          FOREIGN KEY(work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
          FOREIGN KEY(depends_on_work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_work_items_channel_status
        ON work_items(workspace_id, channel_id, status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_work_items_source
        ON work_items(workspace_id, source_type, source_id);

        CREATE INDEX IF NOT EXISTS idx_work_items_assignee
        ON work_items(workspace_id, assignee_teammate_id, status);

        CREATE INDEX IF NOT EXISTS idx_work_items_claim
        ON work_items(workspace_id, claim_expires_at);
      `);
      if (!hasWorkItemsMigration) {
        context.recordMigration(WORK_ITEMS_MIGRATION_VERSION, WORK_ITEMS_MIGRATION_NAME);
      }
    }

    const hasLingTurnsMigration = context.hasMigration(LING_TURNS_MIGRATION_VERSION);
    if (!hasLingTurnsMigration || !context.hasTable("ling_turns") || !context.hasTable("ling_turn_runs")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS ling_turns (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          title TEXT NOT NULL,
          user_instruction TEXT NOT NULL,
          channel_id TEXT,
          task_id TEXT,
          teammate_id TEXT,
          workflow_step_id TEXT,
          external_work_id TEXT,
          automation_id TEXT,
          source_item_id TEXT,
          source_turn_id TEXT,
          intervention_id TEXT,
          active_run_id TEXT,
          last_run_id TEXT,
          created_by_actor TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(thread_id) REFERENCES ling_threads(id) ON DELETE CASCADE,
          FOREIGN KEY(source_turn_id) REFERENCES ling_turns(id) ON DELETE SET NULL,
          FOREIGN KEY(active_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL,
          FOREIGN KEY(last_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_ling_turns_thread_updated
        ON ling_turns(thread_id, updated_at DESC);

        CREATE INDEX IF NOT EXISTS idx_ling_turns_workspace_status
        ON ling_turns(workspace_id, status, updated_at DESC);

        CREATE INDEX IF NOT EXISTS idx_ling_turns_source
        ON ling_turns(source_turn_id);

        CREATE TABLE IF NOT EXISTS ling_turn_runs (
          turn_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          attempt_number INTEGER NOT NULL,
          role TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(turn_id, run_id),
          UNIQUE(run_id),
          UNIQUE(turn_id, attempt_number),
          FOREIGN KEY(turn_id) REFERENCES ling_turns(id) ON DELETE CASCADE,
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_ling_turn_runs_run
        ON ling_turn_runs(run_id);
      `);
      if (!hasLingTurnsMigration) {
        context.recordMigration(LING_TURNS_MIGRATION_VERSION, LING_TURNS_MIGRATION_NAME);
      }
    }

    const hasConversationAttachmentsMigration = context.hasMigration(CONVERSATION_ATTACHMENTS_MIGRATION_VERSION);
    if (!hasConversationAttachmentsMigration || !context.hasTable("conversation_attachments")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS conversation_attachments (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          thread_id TEXT,
          turn_id TEXT,
          kind TEXT NOT NULL,
          file_name TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          path TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(thread_id) REFERENCES ling_threads(id) ON DELETE CASCADE,
          FOREIGN KEY(turn_id) REFERENCES ling_turns(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_conversation_attachments_thread_created
        ON conversation_attachments(thread_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_conversation_attachments_turn_created
        ON conversation_attachments(turn_id, created_at);
      `);
      if (!hasConversationAttachmentsMigration) {
        context.recordMigration(CONVERSATION_ATTACHMENTS_MIGRATION_VERSION, CONVERSATION_ATTACHMENTS_MIGRATION_NAME);
      }
    }

    const hasProviderSecretHeaderRefsMigration = context.hasMigration(PROVIDER_SECRET_HEADER_REFS_MIGRATION_VERSION);
    if (
      !hasProviderSecretHeaderRefsMigration ||
      (context.hasTable("provider_presets") && !context.hasColumn("provider_presets", "secret_header_refs_json"))
    ) {
      if (context.hasTable("provider_presets") && !context.hasColumn("provider_presets", "secret_header_refs_json")) {
        database.exec("ALTER TABLE provider_presets ADD COLUMN secret_header_refs_json TEXT NOT NULL DEFAULT '{}';");
      }
      if (!hasProviderSecretHeaderRefsMigration) {
        context.recordMigration(PROVIDER_SECRET_HEADER_REFS_MIGRATION_VERSION, PROVIDER_SECRET_HEADER_REFS_MIGRATION_NAME);
      }
    }

    const hasLingThreadMetadataMigration = context.hasMigration(LING_THREAD_METADATA_MIGRATION_VERSION);
    if (!hasLingThreadMetadataMigration || !context.hasColumn("ling_threads", "metadata_json")) {
      if (!context.hasColumn("ling_threads", "metadata_json")) {
        database.exec("ALTER TABLE ling_threads ADD COLUMN metadata_json TEXT;");
      }
      if (!hasLingThreadMetadataMigration) {
        context.recordMigration(LING_THREAD_METADATA_MIGRATION_VERSION, LING_THREAD_METADATA_MIGRATION_NAME);
      }
    }

    const hasLingThreadForkLineageMigration = context.hasMigration(LING_THREAD_FORK_LINEAGE_MIGRATION_VERSION);
    if (
      !hasLingThreadForkLineageMigration ||
      !context.hasColumn("ling_threads", "parent_thread_id") ||
      !context.hasColumn("ling_threads", "parent_turn_id") ||
      !context.hasColumn("ling_threads", "forked_from_run_id")
    ) {
      if (!context.hasColumn("ling_threads", "parent_thread_id")) {
        database.exec("ALTER TABLE ling_threads ADD COLUMN parent_thread_id TEXT;");
      }
      if (!context.hasColumn("ling_threads", "parent_turn_id")) {
        database.exec("ALTER TABLE ling_threads ADD COLUMN parent_turn_id TEXT;");
      }
      if (!context.hasColumn("ling_threads", "forked_from_run_id")) {
        database.exec("ALTER TABLE ling_threads ADD COLUMN forked_from_run_id TEXT;");
      }
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_ling_threads_parent
        ON ling_threads(parent_thread_id, updated_at);

        CREATE INDEX IF NOT EXISTS idx_ling_threads_parent_turn
        ON ling_threads(parent_turn_id);
      `);
      if (!hasLingThreadForkLineageMigration) {
        context.recordMigration(LING_THREAD_FORK_LINEAGE_MIGRATION_VERSION, LING_THREAD_FORK_LINEAGE_MIGRATION_NAME);
      }
    }

    const hasLingThreadVisibilityMigration = context.hasMigration(LING_THREAD_VISIBILITY_MIGRATION_VERSION);
    if (
      !hasLingThreadVisibilityMigration ||
      !context.hasColumn("ling_threads", "pinned_at") ||
      !context.hasColumn("ling_threads", "archived_at") ||
      !context.hasColumn("ling_threads", "archived_reason")
    ) {
      if (!context.hasColumn("ling_threads", "pinned_at")) {
        database.exec("ALTER TABLE ling_threads ADD COLUMN pinned_at TEXT;");
      }
      if (!context.hasColumn("ling_threads", "archived_at")) {
        database.exec("ALTER TABLE ling_threads ADD COLUMN archived_at TEXT;");
      }
      if (!context.hasColumn("ling_threads", "archived_reason")) {
        database.exec("ALTER TABLE ling_threads ADD COLUMN archived_reason TEXT;");
      }
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_ling_threads_visible_channel
        ON ling_threads(channel_id, archived_at, pinned_at, updated_at);

        CREATE INDEX IF NOT EXISTS idx_ling_threads_archived
        ON ling_threads(channel_id, archived_at, updated_at);

        CREATE INDEX IF NOT EXISTS idx_ling_threads_pinned
        ON ling_threads(parent_thread_id, pinned_at, updated_at);
      `);
      if (!hasLingThreadVisibilityMigration) {
        context.recordMigration(LING_THREAD_VISIBILITY_MIGRATION_VERSION, LING_THREAD_VISIBILITY_MIGRATION_NAME);
      }
    }

    const hasLingThreadConversationModeMigration = context.hasMigration(LING_THREAD_CONVERSATION_MODE_MIGRATION_VERSION);
    if (
      !hasLingThreadConversationModeMigration ||
      !context.hasColumn("ling_threads", "conversation_mode") ||
      !context.hasColumn("ling_threads", "conversation_mode_updated_at")
    ) {
      if (!context.hasColumn("ling_threads", "conversation_mode")) {
        database.exec("ALTER TABLE ling_threads ADD COLUMN conversation_mode TEXT NOT NULL DEFAULT 'default';");
      }
      if (!context.hasColumn("ling_threads", "conversation_mode_updated_at")) {
        database.exec("ALTER TABLE ling_threads ADD COLUMN conversation_mode_updated_at TEXT;");
      }
      if (!hasLingThreadConversationModeMigration) {
        context.recordMigration(LING_THREAD_CONVERSATION_MODE_MIGRATION_VERSION, LING_THREAD_CONVERSATION_MODE_MIGRATION_NAME);
      }
    }

    const hasLingThreadGoalsMigration = context.hasMigration(LING_THREAD_GOALS_MIGRATION_VERSION);
    if (!hasLingThreadGoalsMigration || !context.hasTable("ling_thread_goals")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS ling_thread_goals (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          objective TEXT NOT NULL,
          status TEXT NOT NULL,
          token_budget INTEGER,
          tokens_used INTEGER NOT NULL DEFAULT 0,
          time_used_seconds INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          cleared_at TEXT,
          replaced_by_goal_id TEXT,
          last_run_id TEXT,
          blocked_reason TEXT,
          completion_evidence_refs_json TEXT NOT NULL DEFAULT '[]',
          completed_by TEXT,
          completed_reason TEXT,
          completion_verification_summary TEXT,
          usage_source TEXT,
          continuation_chain_id TEXT,
          continuation_depth INTEGER NOT NULL DEFAULT 0,
          no_evidence_continuation_count INTEGER NOT NULL DEFAULT 0,
          last_blocker_fingerprint TEXT,
          same_blocker_count INTEGER NOT NULL DEFAULT 0,
          last_continuation_stop_reason TEXT,
          last_continuation_stopped_at TEXT,
          last_continuation_evidence_delta_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_ling_thread_goals_thread_status_updated
          ON ling_thread_goals(thread_id, status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_ling_thread_goals_last_run
          ON ling_thread_goals(last_run_id);
      `);
      if (!hasLingThreadGoalsMigration) {
        context.recordMigration(LING_THREAD_GOALS_MIGRATION_VERSION, LING_THREAD_GOALS_MIGRATION_NAME);
      }
    }

    const hasLingThreadProposedPlansMigration = context.hasMigration(LING_THREAD_PROPOSED_PLANS_MIGRATION_VERSION);
    if (!hasLingThreadProposedPlansMigration || !context.hasTable("ling_thread_proposed_plans")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS ling_thread_proposed_plans (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          channel_id TEXT,
          goal_id TEXT,
          source_agent_id TEXT,
          owner_agent_id TEXT,
          source_turn_id TEXT,
          source_message_id TEXT,
          source_run_id TEXT,
          parent_plan_id TEXT,
          superseded_by_plan_id TEXT,
          plan_group_id TEXT,
          version INTEGER,
          title TEXT NOT NULL,
          body_markdown TEXT NOT NULL,
          status TEXT NOT NULL,
          saved_at TEXT,
          accepted_at TEXT,
          converted_at TEXT,
          archived_at TEXT,
          archived_reason TEXT,
          accepted_task_id TEXT,
          accepted_workflow_id TEXT,
          accepted_workflow_step_id TEXT,
          accepted_run_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ling_thread_proposed_plans_thread_status_updated
          ON ling_thread_proposed_plans(thread_id, status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_ling_thread_proposed_plans_channel
          ON ling_thread_proposed_plans(workspace_id, channel_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_ling_thread_proposed_plans_goal
          ON ling_thread_proposed_plans(workspace_id, goal_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_ling_thread_proposed_plans_parent
          ON ling_thread_proposed_plans(parent_plan_id);
        CREATE INDEX IF NOT EXISTS idx_ling_thread_proposed_plans_superseded
          ON ling_thread_proposed_plans(superseded_by_plan_id);
        CREATE INDEX IF NOT EXISTS idx_ling_thread_proposed_plans_source_message
          ON ling_thread_proposed_plans(source_message_id);
        CREATE INDEX IF NOT EXISTS idx_ling_thread_proposed_plans_acceptance_refs
          ON ling_thread_proposed_plans(accepted_task_id, accepted_workflow_id, accepted_run_id);
      `);
      if (!hasLingThreadProposedPlansMigration) {
        context.recordMigration(LING_THREAD_PROPOSED_PLANS_MIGRATION_VERSION, LING_THREAD_PROPOSED_PLANS_MIGRATION_NAME);
      }
    }

    const hasPlanGoalHistoryMigration = context.hasMigration(PLAN_GOAL_HISTORY_MIGRATION_VERSION);
    if (
      !hasPlanGoalHistoryMigration ||
      !context.hasColumn("ling_thread_goals", "completed_by") ||
      !context.hasColumn("ling_thread_proposed_plans", "channel_id")
    ) {
      if (context.hasTable("ling_thread_goals")) {
        if (!context.hasColumn("ling_thread_goals", "completed_by")) {
          database.exec("ALTER TABLE ling_thread_goals ADD COLUMN completed_by TEXT;");
        }
        if (!context.hasColumn("ling_thread_goals", "completed_reason")) {
          database.exec("ALTER TABLE ling_thread_goals ADD COLUMN completed_reason TEXT;");
        }
        if (!context.hasColumn("ling_thread_goals", "completion_verification_summary")) {
          database.exec("ALTER TABLE ling_thread_goals ADD COLUMN completion_verification_summary TEXT;");
        }
        if (!context.hasColumn("ling_thread_goals", "usage_source")) {
          database.exec("ALTER TABLE ling_thread_goals ADD COLUMN usage_source TEXT;");
        }
        if (!context.hasColumn("ling_thread_goals", "continuation_chain_id")) {
          database.exec("ALTER TABLE ling_thread_goals ADD COLUMN continuation_chain_id TEXT;");
        }
        if (!context.hasColumn("ling_thread_goals", "continuation_depth")) {
          database.exec("ALTER TABLE ling_thread_goals ADD COLUMN continuation_depth INTEGER NOT NULL DEFAULT 0;");
        }
        if (!context.hasColumn("ling_thread_goals", "no_evidence_continuation_count")) {
          database.exec("ALTER TABLE ling_thread_goals ADD COLUMN no_evidence_continuation_count INTEGER NOT NULL DEFAULT 0;");
        }
        if (!context.hasColumn("ling_thread_goals", "last_blocker_fingerprint")) {
          database.exec("ALTER TABLE ling_thread_goals ADD COLUMN last_blocker_fingerprint TEXT;");
        }
        if (!context.hasColumn("ling_thread_goals", "same_blocker_count")) {
          database.exec("ALTER TABLE ling_thread_goals ADD COLUMN same_blocker_count INTEGER NOT NULL DEFAULT 0;");
        }
      }

      if (context.hasTable("ling_thread_proposed_plans")) {
        if (!context.hasColumn("ling_thread_proposed_plans", "channel_id")) {
          database.exec("ALTER TABLE ling_thread_proposed_plans ADD COLUMN channel_id TEXT;");
        }
        if (!context.hasColumn("ling_thread_proposed_plans", "goal_id")) {
          database.exec("ALTER TABLE ling_thread_proposed_plans ADD COLUMN goal_id TEXT;");
        }
        if (!context.hasColumn("ling_thread_proposed_plans", "source_agent_id")) {
          database.exec("ALTER TABLE ling_thread_proposed_plans ADD COLUMN source_agent_id TEXT;");
        }
        if (!context.hasColumn("ling_thread_proposed_plans", "owner_agent_id")) {
          database.exec("ALTER TABLE ling_thread_proposed_plans ADD COLUMN owner_agent_id TEXT;");
        }
        if (!context.hasColumn("ling_thread_proposed_plans", "parent_plan_id")) {
          database.exec("ALTER TABLE ling_thread_proposed_plans ADD COLUMN parent_plan_id TEXT;");
        }
        if (!context.hasColumn("ling_thread_proposed_plans", "superseded_by_plan_id")) {
          database.exec("ALTER TABLE ling_thread_proposed_plans ADD COLUMN superseded_by_plan_id TEXT;");
        }
        if (!context.hasColumn("ling_thread_proposed_plans", "plan_group_id")) {
          database.exec("ALTER TABLE ling_thread_proposed_plans ADD COLUMN plan_group_id TEXT;");
        }
        if (!context.hasColumn("ling_thread_proposed_plans", "version")) {
          database.exec("ALTER TABLE ling_thread_proposed_plans ADD COLUMN version INTEGER;");
        }
        if (!context.hasColumn("ling_thread_proposed_plans", "archived_at")) {
          database.exec("ALTER TABLE ling_thread_proposed_plans ADD COLUMN archived_at TEXT;");
        }
        if (!context.hasColumn("ling_thread_proposed_plans", "archived_reason")) {
          database.exec("ALTER TABLE ling_thread_proposed_plans ADD COLUMN archived_reason TEXT;");
        }
        database.exec(`
          UPDATE ling_thread_proposed_plans
          SET channel_id = (
            SELECT ling_threads.channel_id
            FROM ling_threads
            WHERE ling_threads.workspace_id = ling_thread_proposed_plans.workspace_id
              AND ling_threads.id = ling_thread_proposed_plans.thread_id
          )
          WHERE channel_id IS NULL;
          CREATE INDEX IF NOT EXISTS idx_ling_thread_proposed_plans_channel
            ON ling_thread_proposed_plans(workspace_id, channel_id, updated_at);
          CREATE INDEX IF NOT EXISTS idx_ling_thread_proposed_plans_goal
            ON ling_thread_proposed_plans(workspace_id, goal_id, updated_at);
          CREATE INDEX IF NOT EXISTS idx_ling_thread_proposed_plans_parent
            ON ling_thread_proposed_plans(parent_plan_id);
          CREATE INDEX IF NOT EXISTS idx_ling_thread_proposed_plans_superseded
            ON ling_thread_proposed_plans(superseded_by_plan_id);
        `);
      }
      if (!hasPlanGoalHistoryMigration) {
        context.recordMigration(PLAN_GOAL_HISTORY_MIGRATION_VERSION, PLAN_GOAL_HISTORY_MIGRATION_NAME);
      }
    }

    const hasGoalContinuationObservabilityMigration = context.hasMigration(GOAL_CONTINUATION_OBSERVABILITY_MIGRATION_VERSION);
    if (
      !hasGoalContinuationObservabilityMigration ||
      !context.hasColumn("ling_thread_goals", "last_continuation_stop_reason") ||
      !context.hasColumn("ling_thread_goals", "last_continuation_stopped_at") ||
      !context.hasColumn("ling_thread_goals", "last_continuation_evidence_delta_json")
    ) {
      if (context.hasTable("ling_thread_goals")) {
        if (!context.hasColumn("ling_thread_goals", "last_continuation_stop_reason")) {
          database.exec("ALTER TABLE ling_thread_goals ADD COLUMN last_continuation_stop_reason TEXT;");
        }
        if (!context.hasColumn("ling_thread_goals", "last_continuation_stopped_at")) {
          database.exec("ALTER TABLE ling_thread_goals ADD COLUMN last_continuation_stopped_at TEXT;");
        }
        if (!context.hasColumn("ling_thread_goals", "last_continuation_evidence_delta_json")) {
          database.exec("ALTER TABLE ling_thread_goals ADD COLUMN last_continuation_evidence_delta_json TEXT;");
        }
      }
      if (!hasGoalContinuationObservabilityMigration) {
        context.recordMigration(GOAL_CONTINUATION_OBSERVABILITY_MIGRATION_VERSION, GOAL_CONTINUATION_OBSERVABILITY_MIGRATION_NAME);
      }
    }

    const hasChannelWorkflowMetadataMigration = context.hasMigration(CHANNEL_WORKFLOW_METADATA_MIGRATION_VERSION);
    if (!hasChannelWorkflowMetadataMigration || !context.hasColumn("channel_workflows", "metadata_json")) {
      if (!context.hasColumn("channel_workflows", "metadata_json")) {
        database.exec("ALTER TABLE channel_workflows ADD COLUMN metadata_json TEXT;");
      }
      if (!hasChannelWorkflowMetadataMigration) {
        context.recordMigration(CHANNEL_WORKFLOW_METADATA_MIGRATION_VERSION, CHANNEL_WORKFLOW_METADATA_MIGRATION_NAME);
      }
    }

    const hasWorkflowCoordinationRecordsMigration = context.hasMigration(WORKFLOW_COORDINATION_RECORDS_MIGRATION_VERSION);
    if (
      !hasWorkflowCoordinationRecordsMigration ||
      !context.hasTable("workflow_handoff_intents") ||
      !context.hasTable("workflow_selector_decisions")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS workflow_handoff_intents (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          workflow_id TEXT,
          source_workflow_step_id TEXT,
          source_run_id TEXT,
          source_message_id TEXT,
          channel_handoff_id TEXT,
          from_participant_id TEXT NOT NULL,
          from_participant_label TEXT NOT NULL,
          to_participant_id TEXT NOT NULL,
          to_participant_label TEXT,
          reason TEXT NOT NULL,
          required_input TEXT NOT NULL,
          expected_output TEXT NOT NULL,
          risk_summary TEXT,
          source_refs_json TEXT NOT NULL,
          status TEXT NOT NULL,
          validation_json TEXT,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_workflow_handoff_intents_workflow
        ON workflow_handoff_intents(workflow_id, status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_workflow_handoff_intents_step
        ON workflow_handoff_intents(source_workflow_step_id, status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_workflow_handoff_intents_channel
        ON workflow_handoff_intents(channel_id, status, updated_at);

        CREATE TABLE IF NOT EXISTS workflow_selector_decisions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          source_workflow_step_id TEXT,
          selector_node_id TEXT,
          target_kind TEXT NOT NULL,
          selected_workflow_step_id TEXT,
          selected_graph_node_id TEXT,
          selected_teammate_id TEXT,
          selected_skill_id TEXT,
          selected_handoff_intent_id TEXT,
          reason TEXT NOT NULL,
          alternatives_json TEXT NOT NULL,
          confidence TEXT NOT NULL,
          requires_user_confirmation INTEGER NOT NULL,
          status TEXT NOT NULL,
          source_refs_json TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_workflow_selector_decisions_workflow
        ON workflow_selector_decisions(workflow_id, status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_workflow_selector_decisions_step
        ON workflow_selector_decisions(source_workflow_step_id, status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_workflow_selector_decisions_selected_step
        ON workflow_selector_decisions(selected_workflow_step_id, status, updated_at);
      `);

      if (!hasWorkflowCoordinationRecordsMigration) {
        context.recordMigration(WORKFLOW_COORDINATION_RECORDS_MIGRATION_VERSION, WORKFLOW_COORDINATION_RECORDS_MIGRATION_NAME);
      }
    }

    const hasWorkflowAgentContextMigration = context.hasMigration(WORKFLOW_AGENT_CONTEXT_MIGRATION_VERSION);
    if (
      !hasWorkflowAgentContextMigration
      || !context.hasColumn("workflow_handoff_intents", "agent_context_json")
    ) {
      if (!context.hasColumn("workflow_handoff_intents", "agent_context_json")) {
        database.exec("ALTER TABLE workflow_handoff_intents ADD COLUMN agent_context_json TEXT;");
      }
      if (!hasWorkflowAgentContextMigration) {
        context.recordMigration(WORKFLOW_AGENT_CONTEXT_MIGRATION_VERSION, WORKFLOW_AGENT_CONTEXT_MIGRATION_NAME);
      }
    }
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_workflow_handoff_intents_channel_handoff
      ON workflow_handoff_intents(channel_handoff_id, updated_at);
    `);

    const hasChannelAutoReplyRouterMigration = context.hasMigration(CHANNEL_AUTO_REPLY_ROUTER_MIGRATION_VERSION);
    if (
      !hasChannelAutoReplyRouterMigration ||
      !context.hasColumn("channels", "auto_reply_mode") ||
      !context.hasTable("channel_message_route_decisions")
    ) {
      if (!context.hasColumn("channels", "auto_reply_mode")) {
        database.exec("ALTER TABLE channels ADD COLUMN auto_reply_mode TEXT NOT NULL DEFAULT 'mentions_only';");
      }

      database.exec(`
        CREATE TABLE IF NOT EXISTS channel_message_route_decisions (
          id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          source_message_id TEXT NOT NULL,
          reply_message_id TEXT,
          mode TEXT NOT NULL,
          action TEXT NOT NULL,
          selected_teammate_id TEXT,
          selected_provider_preset_id TEXT,
          confidence REAL,
          reason TEXT NOT NULL,
          alternatives_json TEXT NOT NULL,
          context_pack_json TEXT,
          status TEXT NOT NULL,
          created_by TEXT NOT NULL,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(source_message_id) REFERENCES channel_messages(id) ON DELETE CASCADE,
          FOREIGN KEY(reply_message_id) REFERENCES channel_messages(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_channel_message_route_decisions_source
        ON channel_message_route_decisions(source_message_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_channel_message_route_decisions_channel
        ON channel_message_route_decisions(channel_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_channel_message_route_decisions_status
        ON channel_message_route_decisions(channel_id, status, updated_at);
      `);

      if (!hasChannelAutoReplyRouterMigration) {
        context.recordMigration(CHANNEL_AUTO_REPLY_ROUTER_MIGRATION_VERSION, CHANNEL_AUTO_REPLY_ROUTER_MIGRATION_NAME);
      }
    }

    const hasTeammateDirectReplyInterventionsMigration = context.hasMigration(TEAMMATE_DIRECT_REPLY_INTERVENTIONS_MIGRATION_VERSION);
    if (!hasTeammateDirectReplyInterventionsMigration || !context.hasTable("teammate_direct_reply_interventions")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS teammate_direct_reply_interventions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          teammate_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          source_message_id TEXT NOT NULL,
          source_work_unit_id TEXT,
          mode TEXT NOT NULL,
          status TEXT NOT NULL,
          instruction TEXT NOT NULL,
          message_payload_json TEXT,
          idempotency_key TEXT NOT NULL,
          requested_by TEXT NOT NULL,
          continuation_message_id TEXT,
          continuation_work_unit_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          failure_reason TEXT,
          UNIQUE(workspace_id, teammate_id, thread_id, idempotency_key),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE,
          FOREIGN KEY(thread_id) REFERENCES teammate_direct_threads(id) ON DELETE CASCADE,
          FOREIGN KEY(source_message_id) REFERENCES teammate_direct_messages(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_teammate_direct_reply_interventions_thread
        ON teammate_direct_reply_interventions(teammate_id, thread_id, status, created_at);

        CREATE INDEX IF NOT EXISTS idx_teammate_direct_reply_interventions_source_work_unit
        ON teammate_direct_reply_interventions(source_work_unit_id, status, created_at);
      `);
      if (!hasTeammateDirectReplyInterventionsMigration) {
        context.recordMigration(TEAMMATE_DIRECT_REPLY_INTERVENTIONS_MIGRATION_VERSION, TEAMMATE_DIRECT_REPLY_INTERVENTIONS_MIGRATION_NAME);
      }
    }

    const hasInterventionMessagePayloadMigration = context.hasMigration(INTERVENTION_MESSAGE_PAYLOAD_MIGRATION_VERSION);
    if (
      !hasInterventionMessagePayloadMigration ||
      (context.hasTable("run_interventions") && !context.hasColumn("run_interventions", "message_payload_json")) ||
      (context.hasTable("teammate_direct_reply_interventions") && !context.hasColumn("teammate_direct_reply_interventions", "message_payload_json"))
    ) {
      if (context.hasTable("run_interventions") && !context.hasColumn("run_interventions", "message_payload_json")) {
        database.exec("ALTER TABLE run_interventions ADD COLUMN message_payload_json TEXT;");
      }
      if (context.hasTable("teammate_direct_reply_interventions") && !context.hasColumn("teammate_direct_reply_interventions", "message_payload_json")) {
        database.exec("ALTER TABLE teammate_direct_reply_interventions ADD COLUMN message_payload_json TEXT;");
      }
      if (!hasInterventionMessagePayloadMigration) {
        context.recordMigration(INTERVENTION_MESSAGE_PAYLOAD_MIGRATION_VERSION, INTERVENTION_MESSAGE_PAYLOAD_MIGRATION_NAME);
      }
    }

    const hasChannelMessageFileRefsMigration = context.hasMigration(CHANNEL_MESSAGE_FILE_REFS_MIGRATION_VERSION);
    if (
      !hasChannelMessageFileRefsMigration ||
      (context.hasTable("channel_messages") && !context.hasColumn("channel_messages", "file_refs_json"))
    ) {
      if (context.hasTable("channel_messages") && !context.hasColumn("channel_messages", "file_refs_json")) {
        database.exec("ALTER TABLE channel_messages ADD COLUMN file_refs_json TEXT NOT NULL DEFAULT '[]';");
      }
      if (!hasChannelMessageFileRefsMigration) {
        context.recordMigration(CHANNEL_MESSAGE_FILE_REFS_MIGRATION_VERSION, CHANNEL_MESSAGE_FILE_REFS_MIGRATION_NAME);
      }
    }

    const hasTeammateDirectWorkspaceAndPayloadMigration = context.hasMigration(TEAMMATE_DIRECT_WORKSPACE_AND_PAYLOAD_MIGRATION_VERSION);
    if (
      !hasTeammateDirectWorkspaceAndPayloadMigration ||
      (context.hasTable("teammate_direct_threads") && !context.hasColumn("teammate_direct_threads", "workspace_binding_json")) ||
      (context.hasTable("teammate_direct_messages") && !context.hasColumn("teammate_direct_messages", "link_preview_ids_json")) ||
      (context.hasTable("teammate_direct_messages") && !context.hasColumn("teammate_direct_messages", "file_refs_json")) ||
      !context.hasTable("teammate_direct_link_previews")
    ) {
      if (context.hasTable("teammate_direct_threads") && !context.hasColumn("teammate_direct_threads", "workspace_binding_json")) {
        database.exec("ALTER TABLE teammate_direct_threads ADD COLUMN workspace_binding_json TEXT;");
      }
      if (context.hasTable("teammate_direct_messages") && !context.hasColumn("teammate_direct_messages", "link_preview_ids_json")) {
        database.exec("ALTER TABLE teammate_direct_messages ADD COLUMN link_preview_ids_json TEXT NOT NULL DEFAULT '[]';");
      }
      if (context.hasTable("teammate_direct_messages") && !context.hasColumn("teammate_direct_messages", "file_refs_json")) {
        database.exec("ALTER TABLE teammate_direct_messages ADD COLUMN file_refs_json TEXT NOT NULL DEFAULT '[]';");
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS teammate_direct_link_previews (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          teammate_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          message_id TEXT,
          url TEXT NOT NULL,
          normalized_url TEXT NOT NULL,
          title TEXT,
          description TEXT,
          image_url TEXT,
          site_name TEXT,
          status TEXT NOT NULL,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE,
          FOREIGN KEY(thread_id) REFERENCES teammate_direct_threads(id) ON DELETE CASCADE,
          FOREIGN KEY(message_id) REFERENCES teammate_direct_messages(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_teammate_direct_link_previews_thread_created
        ON teammate_direct_link_previews(teammate_id, thread_id, created_at);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_teammate_direct_link_previews_thread_url
        ON teammate_direct_link_previews(teammate_id, thread_id, normalized_url);
      `);
      if (!hasTeammateDirectWorkspaceAndPayloadMigration) {
        context.recordMigration(TEAMMATE_DIRECT_WORKSPACE_AND_PAYLOAD_MIGRATION_VERSION, TEAMMATE_DIRECT_WORKSPACE_AND_PAYLOAD_MIGRATION_NAME);
      }
    }

    const hasChannelInputMaterializationsMigration = context.hasMigration(CHANNEL_INPUT_MATERIALIZATIONS_MIGRATION_VERSION);
    if (
      !hasChannelInputMaterializationsMigration ||
      !context.hasTable("channel_input_materializations")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS channel_input_materializations (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          source_id TEXT NOT NULL,
          source_fingerprint TEXT NOT NULL,
          extractor_id TEXT NOT NULL,
          extractor_version TEXT NOT NULL,
          content_kind TEXT NOT NULL,
          status TEXT NOT NULL,
          content_text TEXT,
          structured_summary_json TEXT,
          byte_count INTEGER,
          token_estimate INTEGER,
          truncated INTEGER NOT NULL DEFAULT 0,
          policy_decision_json TEXT,
          error_code TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          expires_at TEXT,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_input_materializations_source
        ON channel_input_materializations(channel_id, source_kind, source_id, source_fingerprint, extractor_id);

        CREATE INDEX IF NOT EXISTS idx_channel_input_materializations_lookup
        ON channel_input_materializations(channel_id, source_kind, source_id, updated_at);

        CREATE INDEX IF NOT EXISTS idx_channel_input_materializations_status
        ON channel_input_materializations(channel_id, status, updated_at);
      `);
      if (!hasChannelInputMaterializationsMigration) {
        context.recordMigration(CHANNEL_INPUT_MATERIALIZATIONS_MIGRATION_VERSION, CHANNEL_INPUT_MATERIALIZATIONS_MIGRATION_NAME);
      }
    }

    const hasWorkspaceSettingsAndChannelBindingMigration = context.hasMigration(WORKSPACE_SETTINGS_AND_CHANNEL_BINDING_MIGRATION_VERSION);
    if (
      !hasWorkspaceSettingsAndChannelBindingMigration ||
      !context.hasColumn("channels", "workspace_binding_json") ||
      !context.hasTable("workspace_settings")
    ) {
      if (!context.hasColumn("channels", "workspace_binding_json")) {
        database.exec("ALTER TABLE channels ADD COLUMN workspace_binding_json TEXT;");
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS workspace_settings (
          workspace_id TEXT PRIMARY KEY,
          settings_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );
      `);
      if (!hasWorkspaceSettingsAndChannelBindingMigration) {
        context.recordMigration(WORKSPACE_SETTINGS_AND_CHANNEL_BINDING_MIGRATION_VERSION, WORKSPACE_SETTINGS_AND_CHANNEL_BINDING_MIGRATION_NAME);
      }
    }

    const hasChannelBranchesMigration = context.hasMigration(CHANNEL_BRANCHES_MIGRATION_VERSION);
    if (
      !hasChannelBranchesMigration ||
      !context.hasTable("channel_branches") ||
      !context.hasColumn("channel_branches", "archived_at") ||
      !context.hasColumn("channel_branches", "deleted_at")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS channel_branches (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          root_thread_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT,
          deleted_at TEXT,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_channel_branches_channel_status
        ON channel_branches(channel_id, status, created_at);

        CREATE INDEX IF NOT EXISTS idx_channel_branches_workspace_status
        ON channel_branches(workspace_id, status, updated_at);
      `);
      if (!hasChannelBranchesMigration) {
        context.recordMigration(CHANNEL_BRANCHES_MIGRATION_VERSION, CHANNEL_BRANCHES_MIGRATION_NAME);
      }
    }

    const hasChannelRouteInspectMetadataMigration = context.hasMigration(CHANNEL_ROUTE_INSPECT_METADATA_MIGRATION_VERSION);
    if (
      !hasChannelRouteInspectMetadataMigration ||
      (context.hasTable("channel_message_route_decisions") && !context.hasColumn("channel_message_route_decisions", "context_pack_json"))
    ) {
      if (context.hasTable("channel_message_route_decisions") && !context.hasColumn("channel_message_route_decisions", "context_pack_json")) {
        database.exec("ALTER TABLE channel_message_route_decisions ADD COLUMN context_pack_json TEXT;");
      }
      if (!hasChannelRouteInspectMetadataMigration) {
        context.recordMigration(CHANNEL_ROUTE_INSPECT_METADATA_MIGRATION_VERSION, CHANNEL_ROUTE_INSPECT_METADATA_MIGRATION_NAME);
      }
    }

    const hasChannelProtocolDraftsMigration = context.hasMigration(CHANNEL_PROTOCOL_DRAFTS_MIGRATION_VERSION);
    if (
      !hasChannelProtocolDraftsMigration ||
      !context.hasTable("channel_collaboration_protocols") ||
      !context.hasTable("channel_collaboration_protocol_drafts")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS channel_collaboration_protocols (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          default_workflow_preference TEXT NOT NULL,
          visible_multi_reply_max_participants INTEGER NOT NULL,
          privacy_rules_json TEXT NOT NULL,
          review_rules_json TEXT NOT NULL,
          source_refs_json TEXT NOT NULL,
          updated_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(workspace_id, channel_id),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_channel_collaboration_protocols_channel
        ON channel_collaboration_protocols(workspace_id, channel_id, updated_at);

        CREATE TABLE IF NOT EXISTS channel_collaboration_protocol_drafts (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          base_version INTEGER,
          proposed_patch_json TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_by TEXT NOT NULL,
          source_refs_json TEXT NOT NULL,
          status TEXT NOT NULL,
          applied_protocol_version INTEGER,
          expires_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_channel_collaboration_protocol_drafts_channel
        ON channel_collaboration_protocol_drafts(workspace_id, channel_id, status, updated_at);
      `);
      if (!hasChannelProtocolDraftsMigration) {
        context.recordMigration(CHANNEL_PROTOCOL_DRAFTS_MIGRATION_VERSION, CHANNEL_PROTOCOL_DRAFTS_MIGRATION_NAME);
      }
    }

    const hasApprovalCheckpointsMigration = context.hasMigration(APPROVAL_CHECKPOINTS_MIGRATION_VERSION);
    if (!hasApprovalCheckpointsMigration || !context.hasTable("approval_checkpoints")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS approval_checkpoints (
          id TEXT PRIMARY KEY,
          approval_id TEXT NOT NULL UNIQUE,
          run_id TEXT,
          task_id TEXT,
          media_job_id TEXT,
          external_work_action_id TEXT,
          workflow_step_id TEXT,
          channel_id TEXT,
          tool_call_id TEXT,
          action_type TEXT NOT NULL,
          risk TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          status TEXT NOT NULL,
          side_effect_json TEXT NOT NULL,
          preview_artifact_ids_json TEXT NOT NULL DEFAULT '[]',
          result_artifact_ids_json TEXT NOT NULL DEFAULT '[]',
          runner_resume_handle_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          resolved_at TEXT,
          resumed_at TEXT,
          resume_failure_reason TEXT,
          FOREIGN KEY(approval_id) REFERENCES approval_requests(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_approval_checkpoints_approval
        ON approval_checkpoints(approval_id);

        CREATE INDEX IF NOT EXISTS idx_approval_checkpoints_run
        ON approval_checkpoints(run_id);

        CREATE INDEX IF NOT EXISTS idx_approval_checkpoints_workflow_step
        ON approval_checkpoints(workflow_step_id);

        CREATE INDEX IF NOT EXISTS idx_approval_checkpoints_status
        ON approval_checkpoints(status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_approval_checkpoints_created_at
        ON approval_checkpoints(created_at);

        INSERT OR IGNORE INTO approval_checkpoints (
          id,
          approval_id,
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
          status,
          side_effect_json,
          preview_artifact_ids_json,
          result_artifact_ids_json,
          runner_resume_handle_json,
          created_at,
          updated_at,
          resolved_at,
          resumed_at,
          resume_failure_reason
        )
        SELECT
          'approval_checkpoint_' || id,
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
          status,
          payload_json,
          '[]',
          '[]',
          NULL,
          created_at,
          COALESCE(resolved_at, created_at),
          resolved_at,
          NULL,
          NULL
        FROM approval_requests;
      `);
      if (!hasApprovalCheckpointsMigration) {
        context.recordMigration(APPROVAL_CHECKPOINTS_MIGRATION_VERSION, APPROVAL_CHECKPOINTS_MIGRATION_NAME);
      }
    }

    const hasUserProfileMigration = context.hasMigration(USER_PROFILE_MIGRATION_VERSION);
    if (!hasUserProfileMigration || !context.hasTable("user_profile")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS user_profile (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          handle TEXT,
          avatar_data_url TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      if (!hasUserProfileMigration) {
        context.recordMigration(USER_PROFILE_MIGRATION_VERSION, USER_PROFILE_MIGRATION_NAME);
      }
    }

    const hasSkillCandidatesMigration = context.hasMigration(SKILL_CANDIDATES_MIGRATION_VERSION);
    if (
      !hasSkillCandidatesMigration ||
      !context.hasTable("skill_candidates") ||
      !context.hasTable("skill_candidate_review_records")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS skill_candidates (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          origin TEXT NOT NULL,
          target_skill_id TEXT,
          proposed_action TEXT NOT NULL,
          status TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          definition_json TEXT NOT NULL,
          duplicate_analysis_json TEXT NOT NULL,
          safety_findings_json TEXT NOT NULL,
          source_refs_json TEXT NOT NULL,
          review_notes_json TEXT NOT NULL,
          expires_at TEXT,
          superseded_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_skill_candidates_workspace_status_updated
        ON skill_candidates(workspace_id, status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_skill_candidates_target_skill
        ON skill_candidates(workspace_id, target_skill_id, status);

        CREATE TABLE IF NOT EXISTS skill_candidate_review_records (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          candidate_id TEXT NOT NULL,
          action TEXT NOT NULL,
          actor TEXT NOT NULL,
          previous_status TEXT NOT NULL,
          next_status TEXT NOT NULL,
          reason TEXT,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_skill_candidate_reviews_candidate_created
        ON skill_candidate_review_records(candidate_id, created_at);
      `);
      if (!hasSkillCandidatesMigration) {
        context.recordMigration(SKILL_CANDIDATES_MIGRATION_VERSION, SKILL_CANDIDATES_MIGRATION_NAME);
      }
    }

    const hasProcedureObservationsMigration = context.hasMigration(PROCEDURE_OBSERVATIONS_MIGRATION_VERSION);
    if (
      !hasProcedureObservationsMigration ||
      !context.hasTable("procedure_observations")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS procedure_observations (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          cluster_id TEXT NOT NULL,
          channel_id TEXT,
          teammate_id TEXT,
          task_id TEXT,
          run_id TEXT,
          source TEXT NOT NULL,
          signals_json TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          normalized_goal TEXT NOT NULL,
          positive_triggers_json TEXT NOT NULL,
          negative_triggers_json TEXT NOT NULL,
          procedure_steps_json TEXT NOT NULL,
          validation_steps_json TEXT NOT NULL,
          source_refs_json TEXT NOT NULL,
          confidence TEXT NOT NULL,
          reusable_score REAL NOT NULL,
          route_kind TEXT,
          route_reason_code TEXT,
          route_blockers_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_procedure_observations_cluster
        ON procedure_observations(workspace_id, cluster_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_procedure_observations_route
        ON procedure_observations(workspace_id, route_kind, created_at);
      `);
      if (!hasProcedureObservationsMigration) {
        context.recordMigration(PROCEDURE_OBSERVATIONS_MIGRATION_VERSION, PROCEDURE_OBSERVATIONS_MIGRATION_NAME);
      }
    }

    const hasSkillUsageEventsMigration = context.hasMigration(SKILL_USAGE_EVENTS_MIGRATION_VERSION);
    if (
      !hasSkillUsageEventsMigration ||
      !context.hasTable("skill_usage_events")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS skill_usage_events (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          skill_id TEXT,
          candidate_id TEXT,
          run_id TEXT,
          teammate_id TEXT,
          channel_id TEXT,
          kind TEXT NOT NULL,
          reason TEXT,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_skill_usage_events_skill
        ON skill_usage_events(workspace_id, skill_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_skill_usage_events_candidate
        ON skill_usage_events(workspace_id, candidate_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_skill_usage_events_run
        ON skill_usage_events(workspace_id, run_id, kind);
      `);
      if (!hasSkillUsageEventsMigration) {
        context.recordMigration(SKILL_USAGE_EVENTS_MIGRATION_VERSION, SKILL_USAGE_EVENTS_MIGRATION_NAME);
      }
    }

    const hasChannelPlaybookCandidatesMigration = context.hasMigration(CHANNEL_PLAYBOOK_CANDIDATES_MIGRATION_VERSION);
    if (
      !hasChannelPlaybookCandidatesMigration ||
      !context.hasTable("channel_playbook_candidates")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS channel_playbook_candidates (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          normalized_goal TEXT NOT NULL,
          procedure_steps_json TEXT NOT NULL,
          validation_steps_json TEXT NOT NULL,
          positive_triggers_json TEXT NOT NULL,
          negative_triggers_json TEXT NOT NULL,
          source_refs_json TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_by TEXT NOT NULL,
          status TEXT NOT NULL,
          activated_at TEXT,
          expires_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_channel_playbook_candidates_channel
        ON channel_playbook_candidates(workspace_id, channel_id, status, updated_at);
      `);
      if (!hasChannelPlaybookCandidatesMigration) {
        context.recordMigration(CHANNEL_PLAYBOOK_CANDIDATES_MIGRATION_VERSION, CHANNEL_PLAYBOOK_CANDIDATES_MIGRATION_NAME);
      }
    }

    const hasCandidateGenerationDecisionsMigration = context.hasMigration(CANDIDATE_GENERATION_DECISIONS_MIGRATION_VERSION);
    if (
      !hasCandidateGenerationDecisionsMigration ||
      !context.hasTable("candidate_generation_decisions")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS candidate_generation_decisions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          observation_id TEXT NOT NULL,
          cluster_id TEXT NOT NULL,
          source TEXT NOT NULL,
          route_json TEXT NOT NULL,
          decision TEXT NOT NULL,
          blockers_json TEXT NOT NULL,
          duplicate_decision TEXT,
          reason TEXT NOT NULL,
          created_candidate_id TEXT,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_candidate_generation_decisions_cluster
        ON candidate_generation_decisions(workspace_id, cluster_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_candidate_generation_decisions_observation
        ON candidate_generation_decisions(workspace_id, observation_id, created_at);
      `);
      if (!hasCandidateGenerationDecisionsMigration) {
        context.recordMigration(CANDIDATE_GENERATION_DECISIONS_MIGRATION_VERSION, CANDIDATE_GENERATION_DECISIONS_MIGRATION_NAME);
      }
    }

    const hasGovernanceNotificationsMigration = context.hasMigration(GOVERNANCE_NOTIFICATIONS_MIGRATION_VERSION);
    if (
      !hasGovernanceNotificationsMigration ||
      !context.hasTable("governance_notifications")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS governance_notifications (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          surface_kind TEXT NOT NULL,
          surface_teammate_id TEXT,
          surface_thread_id TEXT,
          surface_channel_id TEXT,
          kind TEXT NOT NULL,
          severity TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          source_refs_json TEXT NOT NULL,
          target_route_json TEXT NOT NULL,
          status TEXT NOT NULL,
          delivery_status TEXT NOT NULL,
          delivery_blocked_reason TEXT,
          deliver_after TEXT,
          delivered_at TEXT,
          dedupe_key TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          resolved_at TEXT,
          UNIQUE(workspace_id, dedupe_key),
          CHECK (
            (surface_kind = 'workspace' AND surface_teammate_id IS NULL AND surface_thread_id IS NULL AND surface_channel_id IS NULL)
            OR (surface_kind = 'channel' AND surface_channel_id IS NOT NULL AND surface_teammate_id IS NULL AND surface_thread_id IS NULL)
            OR (surface_kind = 'teammate_direct' AND surface_teammate_id IS NOT NULL AND surface_thread_id IS NOT NULL AND surface_channel_id IS NULL)
            OR (surface_kind = 'ling_agent' AND surface_teammate_id IS NOT NULL AND surface_thread_id IS NULL AND surface_channel_id IS NULL)
          )
        );

        CREATE INDEX IF NOT EXISTS idx_governance_notifications_surface
        ON governance_notifications(workspace_id, surface_kind, surface_channel_id, surface_teammate_id, status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_governance_notifications_status
        ON governance_notifications(workspace_id, status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_governance_notifications_kind
        ON governance_notifications(workspace_id, kind, status, updated_at);
      `);
      if (!hasGovernanceNotificationsMigration) {
        context.recordMigration(GOVERNANCE_NOTIFICATIONS_MIGRATION_VERSION, GOVERNANCE_NOTIFICATIONS_MIGRATION_NAME);
      }
    }
    const hasAiCouncilsMigration = context.hasMigration(AI_COUNCILS_MIGRATION_VERSION);
    if (
      !hasAiCouncilsMigration ||
      !context.hasTable("ai_councils") ||
      !context.hasTable("ai_council_members") ||
      !context.hasTable("channel_council_policies")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS ai_councils (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          source TEXT NOT NULL,
          template_id TEXT,
          display_name TEXT NOT NULL,
          description TEXT NOT NULL,
          routing_policy_json TEXT NOT NULL,
          governance_profile_json TEXT NOT NULL,
          status TEXT NOT NULL,
          pinned INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_ai_councils_workspace_status
        ON ai_councils(workspace_id, status, pinned);

        CREATE TABLE IF NOT EXISTS ai_council_members (
          council_id TEXT NOT NULL,
          teammate_id TEXT NOT NULL,
          slot_key TEXT,
          label TEXT,
          position INTEGER NOT NULL,
          enabled INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(council_id, teammate_id),
          FOREIGN KEY(council_id) REFERENCES ai_councils(id) ON DELETE CASCADE,
          FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_ai_council_members_teammate
        ON ai_council_members(teammate_id);

        CREATE TABLE IF NOT EXISTS channel_council_policies (
          workspace_id TEXT NOT NULL,
          channel_id TEXT PRIMARY KEY,
          attached_council_ids_json TEXT NOT NULL,
          preferred_council_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(preferred_council_id) REFERENCES ai_councils(id) ON DELETE SET NULL
        );
      `);
      if (!hasAiCouncilsMigration) {
        context.recordMigration(AI_COUNCILS_MIGRATION_VERSION, AI_COUNCILS_MIGRATION_NAME);
      }
    }
    const hasChannelBranchRootThreadMigration = context.hasMigration(CHANNEL_BRANCH_ROOT_THREAD_MIGRATION_VERSION);
    if (
      !hasChannelBranchRootThreadMigration ||
      (context.hasTable("channel_branches") && !context.hasColumn("channel_branches", "root_thread_id"))
    ) {
      if (context.hasTable("channel_branches") && !context.hasColumn("channel_branches", "root_thread_id")) {
        database.exec("ALTER TABLE channel_branches ADD COLUMN root_thread_id TEXT;");
      }
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_channel_branches_root_thread
        ON channel_branches(root_thread_id);
      `);
      if (!hasChannelBranchRootThreadMigration) {
        context.recordMigration(CHANNEL_BRANCH_ROOT_THREAD_MIGRATION_VERSION, CHANNEL_BRANCH_ROOT_THREAD_MIGRATION_NAME);
      }
    }
    const hasSkillSourceSnapshotsMigration = context.hasMigration(SKILL_SOURCE_SNAPSHOTS_MIGRATION_VERSION);
    if (
      !hasSkillSourceSnapshotsMigration ||
      !context.hasTable("skill_source_snapshots")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS skill_source_snapshots (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          skill_id TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          source_path TEXT,
          upstream_name TEXT,
          upstream_version TEXT,
          upstream_skill_path TEXT,
          source_checksum TEXT NOT NULL,
          raw_skill_markdown TEXT NOT NULL,
          raw_skill_markdown_artifact_id TEXT,
          agent_metadata_json TEXT NOT NULL,
          referenced_files_json TEXT NOT NULL,
          warnings_json TEXT NOT NULL,
          review_status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_skill_source_snapshots_skill
        ON skill_source_snapshots(workspace_id, skill_id, review_status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_skill_source_snapshots_source
        ON skill_source_snapshots(workspace_id, source_kind, review_status, updated_at);
      `);
      if (!hasSkillSourceSnapshotsMigration) {
        context.recordMigration(SKILL_SOURCE_SNAPSHOTS_MIGRATION_VERSION, SKILL_SOURCE_SNAPSHOTS_MIGRATION_NAME);
      }
    }
    const hasSkillSourceUpgradeLifecycleMigration = context.hasMigration(SKILL_SOURCE_UPGRADE_LIFECYCLE_MIGRATION_VERSION);
    if (
      !hasSkillSourceUpgradeLifecycleMigration ||
      !context.hasTable("skill_source_upgrade_policies") ||
      !context.hasTable("skill_source_artifacts") ||
      !context.hasColumn("skill_source_snapshots", "raw_skill_markdown_artifact_id")
    ) {
      if (!context.hasColumn("skill_source_snapshots", "raw_skill_markdown_artifact_id")) {
        database.exec("ALTER TABLE skill_source_snapshots ADD COLUMN raw_skill_markdown_artifact_id TEXT;");
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS skill_source_upgrade_policies (
          workspace_id TEXT PRIMARY KEY,
          mode TEXT NOT NULL,
          approved_root_ids_json TEXT NOT NULL,
          allow_new_skills INTEGER NOT NULL,
          allow_global_gstack_upgrade INTEGER NOT NULL,
          last_checked_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS skill_source_artifacts (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          snapshot_id TEXT NOT NULL,
          path TEXT NOT NULL,
          kind TEXT NOT NULL,
          checksum TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          storage_ref TEXT NOT NULL,
          media_type TEXT,
          review_status TEXT NOT NULL,
          included_in_runtime INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(snapshot_id) REFERENCES skill_source_snapshots(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_skill_source_artifacts_snapshot
        ON skill_source_artifacts(workspace_id, snapshot_id, review_status, updated_at);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_source_artifacts_checksum_path
        ON skill_source_artifacts(workspace_id, snapshot_id, path, checksum);
      `);
      if (!hasSkillSourceUpgradeLifecycleMigration) {
        context.recordMigration(SKILL_SOURCE_UPGRADE_LIFECYCLE_MIGRATION_VERSION, SKILL_SOURCE_UPGRADE_LIFECYCLE_MIGRATION_NAME);
      }
    }
    const hasSkillCompiledRuntimeViewsMigration = context.hasMigration(SKILL_COMPILED_RUNTIME_VIEWS_MIGRATION_VERSION);
    if (
      !hasSkillCompiledRuntimeViewsMigration ||
      !context.hasTable("skill_compiled_runtime_views")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS skill_compiled_runtime_views (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          skill_id TEXT NOT NULL,
          source_snapshot_id TEXT NOT NULL,
          compiler_version TEXT NOT NULL,
          core_rules_markdown TEXT NOT NULL,
          lazy_references_json TEXT NOT NULL,
          source_map_json TEXT NOT NULL,
          token_estimate INTEGER NOT NULL,
          fallback_policy TEXT NOT NULL,
          authority_boundary_json TEXT NOT NULL,
          review_status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(source_snapshot_id) REFERENCES skill_source_snapshots(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_skill_compiled_runtime_views_skill
        ON skill_compiled_runtime_views(workspace_id, skill_id, review_status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_skill_compiled_runtime_views_snapshot
        ON skill_compiled_runtime_views(workspace_id, source_snapshot_id, review_status, updated_at);
      `);
      if (!hasSkillCompiledRuntimeViewsMigration) {
        context.recordMigration(SKILL_COMPILED_RUNTIME_VIEWS_MIGRATION_VERSION, SKILL_COMPILED_RUNTIME_VIEWS_MIGRATION_NAME);
      }
    }
    const hasSkillRegressionRunsMigration = context.hasMigration(SKILL_REGRESSION_RUNS_MIGRATION_VERSION);
    if (
      !hasSkillRegressionRunsMigration ||
      !context.hasTable("skill_regression_runs")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS skill_regression_runs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          skill_id TEXT NOT NULL,
          source_snapshot_id TEXT,
          compiled_view_id TEXT,
          suite_id TEXT,
          fixtures_json TEXT NOT NULL,
          observations_json TEXT NOT NULL,
          results_json TEXT NOT NULL,
          summary_json TEXT NOT NULL,
          lifecycle_verdict TEXT NOT NULL,
          auto_safe_eligible INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(source_snapshot_id) REFERENCES skill_source_snapshots(id) ON DELETE SET NULL,
          FOREIGN KEY(compiled_view_id) REFERENCES skill_compiled_runtime_views(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_skill_regression_runs_skill
        ON skill_regression_runs(workspace_id, skill_id, lifecycle_verdict, created_at);

        CREATE INDEX IF NOT EXISTS idx_skill_regression_runs_snapshot
        ON skill_regression_runs(workspace_id, source_snapshot_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_skill_regression_runs_compiled_view
        ON skill_regression_runs(workspace_id, compiled_view_id, created_at);
      `);
      if (!hasSkillRegressionRunsMigration) {
        context.recordMigration(SKILL_REGRESSION_RUNS_MIGRATION_VERSION, SKILL_REGRESSION_RUNS_MIGRATION_NAME);
      }
    }
    const hasLingTerminalReportsMigration = context.hasMigration(LING_TERMINAL_REPORTS_MIGRATION_VERSION);
    if (
      !hasLingTerminalReportsMigration ||
      !context.hasTable("ling_terminal_reports")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS ling_terminal_reports (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT,
          thread_id TEXT,
          turn_id TEXT,
          source_message_id TEXT,
          source_kind TEXT NOT NULL,
          source_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          status TEXT NOT NULL,
          outcome_status TEXT,
          language TEXT NOT NULL,
          evidence_snapshot_json TEXT NOT NULL,
          evidence_fingerprint TEXT NOT NULL,
          report_json TEXT,
          synthesis_mode TEXT,
          prompt_version TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          validation_codes_json TEXT NOT NULL DEFAULT '[]',
          published_message_id TEXT,
          error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          committed_at TEXT,
          UNIQUE (workspace_id, source_kind, source_id, generation),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_ling_terminal_reports_channel_thread
        ON ling_terminal_reports(workspace_id, channel_id, thread_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_ling_terminal_reports_fingerprint
        ON ling_terminal_reports(workspace_id, evidence_fingerprint);
      `);
      if (!hasLingTerminalReportsMigration) {
        context.recordMigration(LING_TERMINAL_REPORTS_MIGRATION_VERSION, LING_TERMINAL_REPORTS_MIGRATION_NAME);
      }
    }
    const hasTaskAttachmentIdsMigration = context.hasMigration(TASK_ATTACHMENT_IDS_MIGRATION_VERSION);
    const hasConversationRevisionsMigration = context.hasMigration(CONVERSATION_REVISIONS_MIGRATION_VERSION);
    if (
      !hasConversationRevisionsMigration ||
      !context.hasTable("conversation_message_revisions") ||
      !context.hasTable("conversation_turn_supersessions")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS conversation_message_revisions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          surface_kind TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          lane_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          body TEXT NOT NULL,
          mentions_json TEXT NOT NULL,
          attachment_ids_json TEXT NOT NULL,
          link_preview_ids_json TEXT NOT NULL,
          file_refs_json TEXT NOT NULL,
          supersedes_revision_id TEXT,
          source_turn_id TEXT,
          source_run_id TEXT,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(workspace_id, surface_kind, message_id, revision),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(supersedes_revision_id) REFERENCES conversation_message_revisions(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_conversation_message_revisions_owner
        ON conversation_message_revisions(workspace_id, surface_kind, owner_id, lane_id, created_at);

        CREATE TABLE IF NOT EXISTS conversation_turn_supersessions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          surface_kind TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          lane_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          superseded_turn_id TEXT,
          superseded_run_ids_json TEXT NOT NULL,
          superseded_response_message_ids_json TEXT NOT NULL,
          replacement_revision_id TEXT NOT NULL,
          replacement_turn_id TEXT,
          reason TEXT NOT NULL,
          replacement_status TEXT NOT NULL,
          failure_reason TEXT,
          idempotency_key TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(workspace_id, idempotency_key),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(replacement_revision_id) REFERENCES conversation_message_revisions(id) ON DELETE RESTRICT
        );

        CREATE INDEX IF NOT EXISTS idx_conversation_turn_supersessions_owner
        ON conversation_turn_supersessions(workspace_id, surface_kind, owner_id, lane_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_conversation_turn_supersessions_pending
        ON conversation_turn_supersessions(workspace_id, replacement_status, updated_at);
      `);
      if (!hasConversationRevisionsMigration) {
        context.recordMigration(CONVERSATION_REVISIONS_MIGRATION_VERSION, CONVERSATION_REVISIONS_MIGRATION_NAME);
      }
    }
    if (!context.hasMigration(REMOVE_SKILL_WORKFLOW_PHASE_MIGRATION_VERSION)) {
      removeLegacySkillWorkflowPhaseMetadata(context);
      context.recordMigration(REMOVE_SKILL_WORKFLOW_PHASE_MIGRATION_VERSION, REMOVE_SKILL_WORKFLOW_PHASE_MIGRATION_NAME);
    }

    const hasManagedOfficialSkillSourceMigration = context.hasMigration(MANAGED_OFFICIAL_SKILL_SOURCE_MIGRATION_VERSION);
    if (!hasManagedOfficialSkillSourceMigration || !context.hasTable("official_skill_source_subscriptions")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS official_skill_source_subscriptions (
          workspace_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          origin_url TEXT NOT NULL,
          ref TEXT NOT NULL,
          revision TEXT,
          version TEXT,
          last_synced_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(workspace_id, source_id),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        DROP TABLE IF EXISTS gstack_source_connections;
      `);
      if (!hasManagedOfficialSkillSourceMigration) {
        context.recordMigration(MANAGED_OFFICIAL_SKILL_SOURCE_MIGRATION_VERSION, MANAGED_OFFICIAL_SKILL_SOURCE_MIGRATION_NAME);
      }
    }

    if (!context.hasMigration(AI_EVOLUTION_SKILL_LIFECYCLE_MIGRATION_VERSION)) {
      database.exec(`
        INSERT OR IGNORE INTO skill_packs (
          id, workspace_id, source, name, version, description, source_path,
          checksum, review_status, created_at, updated_at
        )
        SELECT
          'ling-generated', candidate.workspace_id, 'custom', 'AI evolution', NULL,
          'Skills created through the governed AI evolution review flow.', NULL,
          NULL, 'published', candidate.created_at, candidate.updated_at
        FROM skill_candidates candidate
        WHERE EXISTS (
          SELECT 1
          FROM skill_definitions skill
          WHERE skill.workspace_id = candidate.workspace_id
            AND (
              skill.source_path = candidate.id
              OR skill.source_path = 'skill-candidates/' || candidate.id
            )
        )
        ORDER BY candidate.created_at ASC
        LIMIT 1;

        UPDATE skill_definitions
        SET
          pack_id = 'ling-generated',
          source = 'custom',
          source_path = 'skill-candidates/' || (
            SELECT candidate.id
            FROM skill_candidates candidate
            WHERE candidate.workspace_id = skill_definitions.workspace_id
              AND (
                skill_definitions.source_path = candidate.id
                OR skill_definitions.source_path = 'skill-candidates/' || candidate.id
              )
            LIMIT 1
          )
        WHERE EXISTS (
          SELECT 1
          FROM skill_candidates candidate
          WHERE candidate.workspace_id = skill_definitions.workspace_id
            AND (
              skill_definitions.source_path = candidate.id
              OR skill_definitions.source_path = 'skill-candidates/' || candidate.id
            )
        );

        UPDATE skill_candidates
        SET
          status = 'published',
          updated_at = COALESCE((
            SELECT MAX(skill.updated_at)
            FROM skill_definitions skill
            WHERE skill.workspace_id = skill_candidates.workspace_id
              AND skill.source_path = 'skill-candidates/' || skill_candidates.id
          ), updated_at)
        WHERE status = 'approved_for_draft'
          AND EXISTS (
            SELECT 1
            FROM skill_definitions skill
            WHERE skill.workspace_id = skill_candidates.workspace_id
              AND skill.source_path = 'skill-candidates/' || skill_candidates.id
          );

        INSERT INTO skill_usage_events (
          id, workspace_id, skill_id, candidate_id, run_id, teammate_id,
          channel_id, kind, reason, created_at
        )
        SELECT
          'skill_usage_' || lower(hex(randomblob(16))),
          candidate.workspace_id,
          skill.id,
          candidate.id,
          NULL,
          NULL,
          NULL,
          'published',
          'Reconciled published AI evolution skill during migration.',
          MAX(candidate.updated_at, skill.updated_at)
        FROM skill_candidates candidate
        INNER JOIN skill_definitions skill
          ON skill.workspace_id = candidate.workspace_id
          AND skill.source_path = 'skill-candidates/' || candidate.id
        WHERE candidate.status = 'published'
          AND NOT EXISTS (
            SELECT 1
            FROM skill_usage_events event
            WHERE event.workspace_id = candidate.workspace_id
              AND event.candidate_id = candidate.id
              AND event.skill_id = skill.id
              AND event.kind = 'published'
          );
      `);
      context.recordMigration(AI_EVOLUTION_SKILL_LIFECYCLE_MIGRATION_VERSION, AI_EVOLUTION_SKILL_LIFECYCLE_MIGRATION_NAME);
    }
    if (!hasTaskAttachmentIdsMigration || !context.hasColumn("tasks", "attachment_ids_json")) {
      if (!context.hasColumn("tasks", "attachment_ids_json")) {
        database.exec("ALTER TABLE tasks ADD COLUMN attachment_ids_json TEXT NOT NULL DEFAULT '[]';");
      }
      if (!hasTaskAttachmentIdsMigration) {
        context.recordMigration(TASK_ATTACHMENT_IDS_MIGRATION_VERSION, TASK_ATTACHMENT_IDS_MIGRATION_NAME);
      }
    }

    const hasMediaProductionStudioMigration = context.hasMigration(MEDIA_PRODUCTION_STUDIO_MIGRATION_VERSION);
    if (
      !hasMediaProductionStudioMigration ||
      !context.hasTable("media_projects") ||
      !context.hasTable("media_scenes") ||
      !context.hasTable("media_scene_runs") ||
      !context.hasTable("media_job_execution_handles")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS media_projects (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          default_provider_preset_id TEXT,
          canvas_viewport_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_media_projects_workspace_updated
        ON media_projects(workspace_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS media_scenes (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          sort_order INTEGER NOT NULL,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          provider_preset_id TEXT,
          ratio TEXT NOT NULL,
          duration_seconds INTEGER NOT NULL,
          reference_artifact_ids_json TEXT NOT NULL,
          canvas_position_json TEXT NOT NULL,
          selected_media_scene_run_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(project_id) REFERENCES media_projects(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_media_scenes_project_sort
        ON media_scenes(project_id, sort_order, created_at);

        CREATE TABLE IF NOT EXISTS media_scene_runs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          scene_id TEXT NOT NULL,
          media_job_id TEXT NOT NULL,
          provider_snapshot_json TEXT NOT NULL,
          input_snapshot_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(media_job_id) REFERENCES media_jobs(id) ON DELETE RESTRICT
        );

        CREATE INDEX IF NOT EXISTS idx_media_scene_runs_project_created
        ON media_scene_runs(project_id, created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_media_scene_runs_scene_created
        ON media_scene_runs(scene_id, created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_media_scene_runs_media_job
        ON media_scene_runs(media_job_id);

        CREATE TABLE IF NOT EXISTS media_job_execution_handles (
          media_job_id TEXT PRIMARY KEY,
          adapter_kind TEXT NOT NULL,
          external_operation_id TEXT NOT NULL,
          recovery_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(media_job_id) REFERENCES media_jobs(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_media_job_execution_handles_updated
        ON media_job_execution_handles(updated_at);
      `);
      if (!hasMediaProductionStudioMigration) {
        context.recordMigration(MEDIA_PRODUCTION_STUDIO_MIGRATION_VERSION, MEDIA_PRODUCTION_STUDIO_MIGRATION_NAME);
      }
    }

    const hasMediaExternalWorkflowsMigration = context.hasMigration(MEDIA_EXTERNAL_WORKFLOWS_MIGRATION_VERSION);
    if (
      !hasMediaExternalWorkflowsMigration ||
      !context.hasTable("media_workflow_connections") ||
      !context.hasTable("media_workflow_definitions") ||
      !context.hasTable("media_workflow_versions") ||
      !context.hasColumn("media_jobs", "source_kind")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS media_workflow_connections (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          adapter_kind TEXT NOT NULL,
          base_url TEXT NOT NULL,
          auth_mode TEXT NOT NULL,
          secret_ref TEXT,
          network_policy TEXT NOT NULL,
          protocol_variant TEXT NOT NULL,
          status TEXT NOT NULL,
          health_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_media_workflow_connections_workspace
        ON media_workflow_connections(workspace_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS media_workflow_definitions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL,
          current_version_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(connection_id) REFERENCES media_workflow_connections(id) ON DELETE RESTRICT
        );

        CREATE INDEX IF NOT EXISTS idx_media_workflow_definitions_workspace
        ON media_workflow_definitions(workspace_id, status, updated_at DESC);

        CREATE INDEX IF NOT EXISTS idx_media_workflow_definitions_connection
        ON media_workflow_definitions(connection_id, status);

        CREATE TABLE IF NOT EXISTS media_workflow_versions (
          id TEXT PRIMARY KEY,
          workflow_definition_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          source_format TEXT NOT NULL,
          source_digest TEXT NOT NULL,
          graph_snapshot_json TEXT NOT NULL,
          input_fields_json TEXT NOT NULL,
          output_rules_json TEXT NOT NULL,
          validation_json TEXT NOT NULL,
          test_media_job_id TEXT,
          created_at TEXT NOT NULL,
          UNIQUE(workflow_definition_id, version),
          FOREIGN KEY(workflow_definition_id) REFERENCES media_workflow_definitions(id) ON DELETE CASCADE,
          FOREIGN KEY(test_media_job_id) REFERENCES media_jobs(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_media_workflow_versions_definition
        ON media_workflow_versions(workflow_definition_id, version DESC);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_media_workflow_versions_digest
        ON media_workflow_versions(workflow_definition_id, source_digest);
      `);

      if (!context.hasColumn("media_projects", "default_execution_mode")) {
        database.exec("ALTER TABLE media_projects ADD COLUMN default_execution_mode TEXT NOT NULL DEFAULT 'direct';");
      }
      if (!context.hasColumn("media_projects", "default_workflow_definition_id")) {
        database.exec("ALTER TABLE media_projects ADD COLUMN default_workflow_definition_id TEXT;");
      }
      if (!context.hasColumn("media_scenes", "execution_mode")) {
        database.exec("ALTER TABLE media_scenes ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'direct';");
      }
      if (!context.hasColumn("media_scenes", "workflow_definition_id")) {
        database.exec("ALTER TABLE media_scenes ADD COLUMN workflow_definition_id TEXT;");
      }
      if (!context.hasColumn("media_scenes", "workflow_input_values_json")) {
        database.exec("ALTER TABLE media_scenes ADD COLUMN workflow_input_values_json TEXT NOT NULL DEFAULT '{}';");
      }
      if (!context.hasColumn("media_scene_runs", "execution_snapshot_json")) {
        database.exec("ALTER TABLE media_scene_runs ADD COLUMN execution_snapshot_json TEXT NOT NULL DEFAULT '{}';");
        database.exec("UPDATE media_scene_runs SET execution_snapshot_json = provider_snapshot_json WHERE execution_snapshot_json = '{}';");
      }
      if (!context.hasColumn("media_job_execution_handles", "next_poll_at")) {
        database.exec("ALTER TABLE media_job_execution_handles ADD COLUMN next_poll_at TEXT;");
      }
      if (!context.hasColumn("media_job_execution_handles", "poll_attempts")) {
        database.exec("ALTER TABLE media_job_execution_handles ADD COLUMN poll_attempts INTEGER NOT NULL DEFAULT 0;");
      }
      if (!context.hasColumn("media_job_execution_handles", "work_unit_id")) {
        database.exec("ALTER TABLE media_job_execution_handles ADD COLUMN work_unit_id TEXT;");
      }
      if (!context.hasColumn("media_job_execution_handles", "attempt_id")) {
        database.exec("ALTER TABLE media_job_execution_handles ADD COLUMN attempt_id TEXT;");
      }

      if (!context.hasColumn("media_jobs", "source_kind")) {
        database.exec("PRAGMA foreign_keys = OFF;");
        database.exec(`
          CREATE TABLE media_jobs_workflow_migration (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            source_kind TEXT NOT NULL,
            provider_preset_id TEXT,
            workflow_version_id TEXT,
            operation TEXT NOT NULL,
            prompt TEXT NOT NULL,
            input_json TEXT NOT NULL,
            artifact_ids_json TEXT NOT NULL,
            status TEXT NOT NULL,
            error_message TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            CHECK(
              (source_kind = 'provider' AND provider_preset_id IS NOT NULL AND workflow_version_id IS NULL)
              OR (source_kind = 'workflow' AND provider_preset_id IS NULL AND workflow_version_id IS NOT NULL)
            ),
            FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
            FOREIGN KEY(workflow_version_id) REFERENCES media_workflow_versions(id) ON DELETE RESTRICT
          );

          INSERT INTO media_jobs_workflow_migration (
            id, workspace_id, source_kind, provider_preset_id, workflow_version_id, operation,
            prompt, input_json, artifact_ids_json, status, error_message, created_at, updated_at
          )
          SELECT id, workspace_id, 'provider', provider_preset_id, NULL, operation,
                 prompt, input_json, artifact_ids_json, status, error_message, created_at, updated_at
          FROM media_jobs;

          DROP TABLE media_jobs;
          ALTER TABLE media_jobs_workflow_migration RENAME TO media_jobs;

          CREATE INDEX IF NOT EXISTS idx_media_jobs_workspace ON media_jobs(workspace_id);
          CREATE INDEX IF NOT EXISTS idx_media_jobs_provider ON media_jobs(provider_preset_id);
          CREATE INDEX IF NOT EXISTS idx_media_jobs_workflow_version ON media_jobs(workflow_version_id);
          CREATE INDEX IF NOT EXISTS idx_media_jobs_status ON media_jobs(status);
          CREATE INDEX IF NOT EXISTS idx_media_jobs_created_at ON media_jobs(created_at);
        `);
        database.exec("PRAGMA foreign_keys = ON;");
      }

      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_media_job_execution_handles_next_poll
        ON media_job_execution_handles(next_poll_at, updated_at);
      `);
      if (!hasMediaExternalWorkflowsMigration) {
        context.recordMigration(MEDIA_EXTERNAL_WORKFLOWS_MIGRATION_VERSION, MEDIA_EXTERNAL_WORKFLOWS_MIGRATION_NAME);
      }
    }

    const hasCuaDriverActivationMigration = context.hasMigration(CUA_DRIVER_ACTIVATION_MIGRATION_VERSION);
    if (!hasCuaDriverActivationMigration || !context.hasTable("cua_driver_activation_state")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS cua_driver_activation_state (
          plugin_id TEXT PRIMARY KEY,
          requested_enabled INTEGER NOT NULL CHECK (requested_enabled IN (0, 1)),
          requested_revision INTEGER NOT NULL CHECK (requested_revision >= 0),
          activation_epoch INTEGER NOT NULL CHECK (activation_epoch >= 0),
          updated_at TEXT NOT NULL,
          FOREIGN KEY(plugin_id) REFERENCES managed_plugins(id) ON DELETE CASCADE
        );
      `);

      // Preserve legacy user intent when upgrading an existing installation.
      // External mode remains authoritative over its current effective flag; the
      // bundled gate is still off unless explicitly enabled by daemon config.
      database.exec(`
        INSERT INTO cua_driver_activation_state (
          plugin_id,
          requested_enabled,
          requested_revision,
          activation_epoch,
          updated_at
        )
        SELECT id, enabled, 0, 0, updated_at
        FROM managed_plugins
        WHERE id = 'trusted-local:cua-driver'
        ON CONFLICT(plugin_id) DO NOTHING;
      `);

      if (!hasCuaDriverActivationMigration) {
        context.recordMigration(CUA_DRIVER_ACTIVATION_MIGRATION_VERSION, CUA_DRIVER_ACTIVATION_MIGRATION_NAME);
      }
    }

    const hasMcpAuthorityRevisionsMigration = context.hasMigration(MCP_AUTHORITY_REVISIONS_MIGRATION_VERSION);
    if (!hasMcpAuthorityRevisionsMigration || !context.hasTable("mcp_authority_revisions")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS mcp_authority_revisions (
          server_id TEXT PRIMARY KEY,
          server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
          tools_revision INTEGER NOT NULL DEFAULT 0 CHECK (tools_revision >= 0)
        );
      `);
      if (!hasMcpAuthorityRevisionsMigration) {
        context.recordMigration(MCP_AUTHORITY_REVISIONS_MIGRATION_VERSION, MCP_AUTHORITY_REVISIONS_MIGRATION_NAME);
      }
    }

    database.exec(`
      INSERT INTO mcp_authority_revisions (server_id, server_revision, tools_revision)
      SELECT id, 0, 0 FROM mcp_servers
      WHERE true
      ON CONFLICT(server_id) DO NOTHING;

      CREATE TRIGGER IF NOT EXISTS trg_mcp_authority_server_insert
      AFTER INSERT ON mcp_servers
      BEGIN
        INSERT INTO mcp_authority_revisions (server_id, server_revision, tools_revision)
        VALUES (NEW.id, 1, 0)
        ON CONFLICT(server_id) DO UPDATE SET
          server_revision = server_revision + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_mcp_authority_server_update
      AFTER UPDATE OF transport_json, enabled, required, startup_timeout_sec,
        tool_timeout_sec, enabled_tools_json, disabled_tools_json ON mcp_servers
      WHEN OLD.transport_json IS NOT NEW.transport_json
        OR OLD.enabled IS NOT NEW.enabled
        OR OLD.required IS NOT NEW.required
        OR OLD.startup_timeout_sec IS NOT NEW.startup_timeout_sec
        OR OLD.tool_timeout_sec IS NOT NEW.tool_timeout_sec
        OR OLD.enabled_tools_json IS NOT NEW.enabled_tools_json
        OR OLD.disabled_tools_json IS NOT NEW.disabled_tools_json
      BEGIN
        UPDATE mcp_authority_revisions
        SET server_revision = server_revision + 1
        WHERE server_id = NEW.id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_mcp_authority_server_delete
      AFTER DELETE ON mcp_servers
      BEGIN
        INSERT INTO mcp_authority_revisions (server_id, server_revision, tools_revision)
        VALUES (OLD.id, 1, 1)
        ON CONFLICT(server_id) DO UPDATE SET
          server_revision = server_revision + 1,
          tools_revision = tools_revision + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_mcp_authority_tool_insert
      AFTER INSERT ON mcp_tools
      BEGIN
        INSERT INTO mcp_authority_revisions (server_id, server_revision, tools_revision)
        VALUES (NEW.server_id, 0, 1)
        ON CONFLICT(server_id) DO UPDATE SET
          tools_revision = tools_revision + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_mcp_authority_tool_update
      AFTER UPDATE ON mcp_tools
      BEGIN
        INSERT INTO mcp_authority_revisions (server_id, server_revision, tools_revision)
        VALUES (NEW.server_id, 0, 1)
        ON CONFLICT(server_id) DO UPDATE SET
          tools_revision = tools_revision + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_mcp_authority_tool_delete
      AFTER DELETE ON mcp_tools
      BEGIN
        INSERT INTO mcp_authority_revisions (server_id, server_revision, tools_revision)
        VALUES (OLD.server_id, 0, 1)
        ON CONFLICT(server_id) DO UPDATE SET
          tools_revision = tools_revision + 1;
      END;
  `);

    const hasRemoteConversationStateMigration = context.hasMigration(REMOTE_CONVERSATION_STATE_MIGRATION_VERSION);
    if (
      !hasRemoteConversationStateMigration ||
      !context.hasTable("remote_command_receipts") ||
      !context.hasTable("remote_dispatch_intents") ||
      !context.hasTable("remote_projection_outbox") ||
      !context.hasTable("conversation_read_states")
    ) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS remote_command_receipts (
          command_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          device_id TEXT NOT NULL,
          command_type TEXT NOT NULL,
          body_hash TEXT NOT NULL,
          receipt_state TEXT NOT NULL CHECK (receipt_state IN ('full', 'tombstone')),
          status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
          issued_at TEXT NOT NULL,
          retry_until TEXT NOT NULL,
          terminal_json TEXT,
          message_id TEXT,
          dispatch_intent_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          compacted_at TEXT,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_remote_command_receipts_workspace_created
        ON remote_command_receipts(workspace_id, created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_remote_command_receipts_retention
        ON remote_command_receipts(receipt_state, retry_until, compacted_at);

        CREATE TABLE IF NOT EXISTS remote_dispatch_intents (
          id TEXT PRIMARY KEY,
          command_id TEXT NOT NULL UNIQUE,
          workspace_id TEXT NOT NULL,
          conversation_kind TEXT NOT NULL CHECK (conversation_kind IN ('channel', 'conversation', 'teammate_direct')),
          conversation_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          source_surface TEXT NOT NULL CHECK (source_surface = 'mobile'),
          authority_ceiling TEXT NOT NULL CHECK (authority_ceiling = 'conversation_comment'),
          allow_ai_reply INTEGER NOT NULL CHECK (allow_ai_reply = 1),
          allow_tool_calls INTEGER NOT NULL CHECK (allow_tool_calls = 0),
          allow_workflow_auto_start INTEGER NOT NULL CHECK (allow_workflow_auto_start = 0),
          allow_execution_proposal INTEGER NOT NULL CHECK (allow_execution_proposal = 0),
          status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'dispatched', 'failed')),
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
          available_at TEXT NOT NULL,
          claimed_by TEXT,
          claim_expires_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          dispatched_at TEXT,
          FOREIGN KEY(command_id) REFERENCES remote_command_receipts(command_id) ON DELETE CASCADE,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_remote_dispatch_intents_claim
        ON remote_dispatch_intents(status, available_at, claim_expires_at, created_at);

        CREATE INDEX IF NOT EXISTS idx_remote_dispatch_intents_conversation
        ON remote_dispatch_intents(workspace_id, conversation_kind, conversation_id, created_at);

        CREATE TABLE IF NOT EXISTS remote_projection_outbox (
          activity_seq INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id TEXT NOT NULL,
          conversation_kind TEXT CHECK (conversation_kind IS NULL OR conversation_kind IN ('channel', 'conversation', 'teammate_direct')),
          conversation_id TEXT,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          operation TEXT NOT NULL CHECK (operation IN ('insert', 'update', 'delete')),
          affects_unread INTEGER NOT NULL DEFAULT 0 CHECK (affects_unread IN (0, 1)),
          occurred_at TEXT NOT NULL,
          processed_at TEXT,
          CHECK (
            (conversation_kind IS NULL AND conversation_id IS NULL)
            OR (conversation_kind IS NOT NULL AND conversation_id IS NOT NULL)
          ),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_remote_projection_outbox_pending
        ON remote_projection_outbox(processed_at, activity_seq);

        CREATE INDEX IF NOT EXISTS idx_remote_projection_outbox_conversation
        ON remote_projection_outbox(workspace_id, conversation_kind, conversation_id, activity_seq);

        CREATE TABLE IF NOT EXISTS conversation_read_states (
          workspace_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          conversation_kind TEXT NOT NULL CHECK (conversation_kind IN ('channel', 'conversation', 'teammate_direct')),
          conversation_id TEXT NOT NULL,
          read_through_activity_seq INTEGER NOT NULL DEFAULT 0 CHECK (read_through_activity_seq >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(workspace_id, user_id, conversation_kind, conversation_id),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_conversation_read_states_user
        ON conversation_read_states(workspace_id, user_id, updated_at DESC);
      `);

      if (!hasRemoteConversationStateMigration) {
        context.recordMigration(REMOTE_CONVERSATION_STATE_MIGRATION_VERSION, REMOTE_CONVERSATION_STATE_MIGRATION_NAME);
      }
    }

    database.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_remote_outbox_channel_insert
      AFTER INSERT ON channels
      BEGIN
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        ) VALUES (NEW.workspace_id, 'channel', NEW.id, 'channel', NEW.id, 'insert', 0, NEW.updated_at);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_remote_outbox_channel_update
      AFTER UPDATE ON channels
      BEGIN
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        ) VALUES (NEW.workspace_id, 'channel', NEW.id, 'channel', NEW.id, 'update', 0, NEW.updated_at);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_remote_outbox_channel_delete
      AFTER DELETE ON channels
      BEGIN
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        ) VALUES (OLD.workspace_id, 'channel', OLD.id, 'channel', OLD.id, 'delete', 0, OLD.updated_at);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_remote_outbox_direct_thread_insert
      AFTER INSERT ON teammate_direct_threads
      BEGIN
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        ) VALUES (NEW.workspace_id, 'teammate_direct', NEW.id, 'teammate_direct_thread', NEW.id, 'insert', 0, NEW.updated_at);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_remote_outbox_direct_thread_update
      AFTER UPDATE ON teammate_direct_threads
      BEGIN
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        ) VALUES (NEW.workspace_id, 'teammate_direct', NEW.id, 'teammate_direct_thread', NEW.id, 'update', 0, NEW.updated_at);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_remote_outbox_direct_thread_delete
      AFTER DELETE ON teammate_direct_threads
      BEGIN
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        ) VALUES (OLD.workspace_id, 'teammate_direct', OLD.id, 'teammate_direct_thread', OLD.id, 'delete', 0, OLD.updated_at);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_remote_outbox_direct_message_insert
      AFTER INSERT ON teammate_direct_messages
      BEGIN
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        ) VALUES (
          NEW.workspace_id, 'teammate_direct', NEW.thread_id, 'teammate_direct_message', NEW.id,
          'insert', CASE WHEN NEW.author_type = 'local-user' THEN 0 ELSE 1 END, NEW.updated_at
        );
      END;

      CREATE TRIGGER IF NOT EXISTS trg_remote_outbox_direct_message_update
      AFTER UPDATE ON teammate_direct_messages
      BEGIN
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        ) VALUES (
          NEW.workspace_id, 'teammate_direct', NEW.thread_id, 'teammate_direct_message', NEW.id,
          'update', CASE WHEN NEW.author_type = 'local-user' THEN 0 ELSE 1 END, NEW.updated_at
        );
      END;

      CREATE TRIGGER IF NOT EXISTS trg_remote_outbox_direct_message_delete
      AFTER DELETE ON teammate_direct_messages
      BEGIN
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        ) VALUES (
          OLD.workspace_id, 'teammate_direct', OLD.thread_id, 'teammate_direct_message', OLD.id,
          'delete', CASE WHEN OLD.author_type = 'local-user' THEN 0 ELSE 1 END, OLD.updated_at
        );
      END;

      CREATE TRIGGER IF NOT EXISTS trg_remote_outbox_ling_thread_insert
      AFTER INSERT ON ling_threads
      WHEN NEW.kind = 'conversation'
      BEGIN
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        ) VALUES (NEW.workspace_id, 'conversation', NEW.id, 'ling_thread', NEW.id, 'insert', 0, NEW.updated_at);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_remote_outbox_ling_thread_update
      AFTER UPDATE ON ling_threads
      WHEN NEW.kind = 'conversation'
      BEGIN
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        ) VALUES (NEW.workspace_id, 'conversation', NEW.id, 'ling_thread', NEW.id, 'update', 0, NEW.updated_at);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_remote_outbox_ling_thread_delete
      AFTER DELETE ON ling_threads
      WHEN OLD.kind = 'conversation'
      BEGIN
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        ) VALUES (OLD.workspace_id, 'conversation', OLD.id, 'ling_thread', OLD.id, 'delete', 0, OLD.updated_at);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_remote_outbox_ling_turn_insert
      AFTER INSERT ON ling_turns
      WHEN (SELECT kind FROM ling_threads WHERE id = NEW.thread_id) = 'conversation'
      BEGIN
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        ) VALUES (NEW.workspace_id, 'conversation', NEW.thread_id, 'ling_turn', NEW.id, 'insert', 0, NEW.updated_at);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_remote_outbox_ling_turn_update
      AFTER UPDATE ON ling_turns
      WHEN (SELECT kind FROM ling_threads WHERE id = NEW.thread_id) = 'conversation'
      BEGIN
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        ) VALUES (NEW.workspace_id, 'conversation', NEW.thread_id, 'ling_turn', NEW.id, 'update', 0, NEW.updated_at);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_remote_outbox_ling_turn_delete
      BEFORE DELETE ON ling_turns
      WHEN (SELECT kind FROM ling_threads WHERE id = OLD.thread_id) = 'conversation'
      BEGIN
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        ) VALUES (OLD.workspace_id, 'conversation', OLD.thread_id, 'ling_turn', OLD.id, 'delete', 0, OLD.updated_at);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_remote_outbox_run_session_insert
      AFTER INSERT ON run_sessions
      WHEN NEW.thread_id IS NOT NULL
        AND (SELECT kind FROM ling_threads WHERE id = NEW.thread_id) = 'conversation'
      BEGIN
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        ) VALUES ('workspace_default', 'conversation', NEW.thread_id, 'run_session', NEW.id, 'insert', 0, NEW.updated_at);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_remote_outbox_run_session_update
      AFTER UPDATE ON run_sessions
      WHEN NEW.thread_id IS NOT NULL
        AND (SELECT kind FROM ling_threads WHERE id = NEW.thread_id) = 'conversation'
      BEGIN
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        ) VALUES ('workspace_default', 'conversation', NEW.thread_id, 'run_session', NEW.id, 'update', 0, NEW.updated_at);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_remote_outbox_run_event_insert
      AFTER INSERT ON run_events
      BEGIN
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        )
        SELECT
          'workspace_default', 'conversation', runs.thread_id, 'run_session', NEW.run_id,
          'insert', CASE WHEN NEW.type IN ('message_end', 'result') THEN 1 ELSE 0 END, NEW.ts
        FROM run_sessions AS runs
        INNER JOIN ling_threads AS threads ON threads.id = runs.thread_id
        WHERE runs.id = NEW.run_id AND threads.kind = 'conversation';
      END;

      CREATE TRIGGER IF NOT EXISTS trg_remote_outbox_user_profile_insert
      AFTER INSERT ON user_profile
      BEGIN
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        ) VALUES ('workspace_default', NULL, NULL, 'user_profile', NEW.id, 'insert', 0, NEW.updated_at);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_remote_outbox_user_profile_update
      AFTER UPDATE ON user_profile
      BEGIN
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        ) VALUES ('workspace_default', NULL, NULL, 'user_profile', NEW.id, 'update', 0, NEW.updated_at);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_remote_outbox_read_state_insert
      AFTER INSERT ON conversation_read_states
      BEGIN
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        ) VALUES (
          NEW.workspace_id, NEW.conversation_kind, NEW.conversation_id, 'conversation_read_state',
          NEW.user_id || ':' || NEW.conversation_id, 'insert', 0, NEW.updated_at
        );
      END;

      CREATE TRIGGER IF NOT EXISTS trg_remote_outbox_read_state_update
      AFTER UPDATE ON conversation_read_states
      WHEN OLD.read_through_activity_seq IS NOT NEW.read_through_activity_seq
      BEGIN
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        ) VALUES (
          NEW.workspace_id, NEW.conversation_kind, NEW.conversation_id, 'conversation_read_state',
          NEW.user_id || ':' || NEW.conversation_id, 'update', 0, NEW.updated_at
        );
      END;
    `);
  if (!continuityV2Active) {
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_remote_outbox_channel_message_insert
      AFTER INSERT ON channel_messages
      BEGIN
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        ) VALUES (
          NEW.workspace_id, 'channel', NEW.channel_id, 'channel_message', NEW.id,
          'insert', CASE WHEN NEW.author_type = 'local-user' THEN 0 ELSE 1 END, NEW.updated_at
        );
      END;

      CREATE TRIGGER IF NOT EXISTS trg_remote_outbox_channel_message_update
      AFTER UPDATE ON channel_messages
      BEGIN
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        ) VALUES (
          NEW.workspace_id, 'channel', NEW.channel_id, 'channel_message', NEW.id,
          'update', CASE WHEN NEW.author_type = 'local-user' THEN 0 ELSE 1 END, NEW.updated_at
        );
      END;

      CREATE TRIGGER IF NOT EXISTS trg_remote_outbox_channel_message_delete
      AFTER DELETE ON channel_messages
      BEGIN
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        ) VALUES (
          OLD.workspace_id, 'channel', OLD.channel_id, 'channel_message', OLD.id,
          'delete', CASE WHEN OLD.author_type = 'local-user' THEN 0 ELSE 1 END, OLD.updated_at
        );
      END;
    `);
  }
  const hasTeammateModelBindingMigration = context.hasMigration(TEAMMATE_MODEL_BINDING_MIGRATION_VERSION);
  if (!hasTeammateModelBindingMigration || !context.hasColumn("ai_teammates", "model_binding_mode")) {
    if (!context.hasColumn("ai_teammates", "model_binding_mode")) {
      database.exec("ALTER TABLE ai_teammates ADD COLUMN model_binding_mode TEXT NOT NULL DEFAULT 'fixed';");
    }
    database.exec(`
      UPDATE ai_teammates
      SET model_binding_mode = 'workspace_default', provider_preset_id = NULL
      WHERE id = 'ling_agent';

      UPDATE ai_teammates
      SET model_binding_mode = 'workspace_default'
      WHERE id LIKE 'teammate_builtin_%'
        AND provider_preset_id IS NULL;
    `);
    if (!hasTeammateModelBindingMigration) {
      context.recordMigration(TEAMMATE_MODEL_BINDING_MIGRATION_VERSION, TEAMMATE_MODEL_BINDING_MIGRATION_NAME);
    }
  }

  if (!context.hasMigration(REMOTE_UNREAD_ENTITY_MIGRATION_VERSION)) {
    database.exec(`
      DROP TRIGGER IF EXISTS trg_remote_outbox_run_event_insert;

      UPDATE remote_projection_outbox
      SET
        entity_type = 'run_session',
        entity_id = (
          SELECT events.run_id
          FROM run_events AS events
          WHERE events.id = remote_projection_outbox.entity_id
        )
      WHERE entity_type = 'run_event'
        AND EXISTS (
          SELECT 1
          FROM run_events AS events
          WHERE events.id = remote_projection_outbox.entity_id
        );

      CREATE TRIGGER trg_remote_outbox_run_event_insert
      AFTER INSERT ON run_events
      BEGIN
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        )
        SELECT
          'workspace_default', 'conversation', runs.thread_id, 'run_session', NEW.run_id,
          'insert', CASE WHEN NEW.type IN ('message_end', 'result') THEN 1 ELSE 0 END, NEW.ts
        FROM run_sessions AS runs
        INNER JOIN ling_threads AS threads ON threads.id = runs.thread_id
        WHERE runs.id = NEW.run_id AND threads.kind = 'conversation';
      END;

      CREATE INDEX IF NOT EXISTS idx_remote_projection_outbox_entity
      ON remote_projection_outbox(
        workspace_id, conversation_kind, conversation_id, entity_type, entity_id, activity_seq
      );
    `);
    context.recordMigration(REMOTE_UNREAD_ENTITY_MIGRATION_VERSION, REMOTE_UNREAD_ENTITY_MIGRATION_NAME);
  }
}
