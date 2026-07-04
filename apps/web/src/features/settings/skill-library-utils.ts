import type {
  AiTeammate,
  ChannelPlaybookCandidate,
  ChannelPlaybookCandidateReviewAction,
  ProcedureObservationCluster,
  SkillCandidate,
  SkillCandidateReviewAction,
  SkillHealthFinding,
  SkillHealthSeverity,
  SkillPackSource,
  SkillRegistryEntry,
  SkillSourceHealthReport,
  SkillSourceSemanticDiffItem,
  SkillSourceSnapshot,
  SkillSourceSyncDiffItem,
  SkillSourceSyncPreviewRecord,
  SkillSourceSyncRecordState,
  TeammateSkillBinding,
} from "../../types.js";

export type SkillLibraryFilter = "all" | "builtin" | "custom" | "draft" | "archived";

export interface TeammateSkillBindingSummary {
  readonly teammate: AiTeammate;
  readonly bindings: readonly TeammateSkillBinding[];
}

export type SettingsTranslator = (key: string, values?: Readonly<Record<string, string | number>>) => string;

export function skillRegistryState(entry: SkillRegistryEntry, t: (key: string, values?: Readonly<Record<string, string | number>>) => string): { readonly label: string; readonly tone: "bindable" | "draft" | "blocked" | "archived" } {
  if (entry.reviewStatus === "archived") {
    return { label: t("Archived"), tone: "archived" };
  }
  if (entry.reviewStatus === "draft") {
    return { label: t("Draft"), tone: "draft" };
  }
  if (entry.reviewStatus === "disabled") {
    return { label: t("Blocked"), tone: "blocked" };
  }
  return { label: t("Bindable"), tone: "bindable" };
}

export function skillLibraryFilterLabel(filter: SkillLibraryFilter, t: (key: string) => string): string {
  if (filter === "builtin") {
    return t("Built-in");
  }
  if (filter === "custom") {
    return t("Custom");
  }
  if (filter === "draft") {
    return t("Draft");
  }
  if (filter === "archived") {
    return t("Archived");
  }
  return t("All");
}

export function skillSourceLabel(source: SkillPackSource, t: (key: string) => string): string {
  if (source === "builtin") {
    return t("Built-in");
  }
  if (source === "agents-md") {
    return "AGENTS.md";
  }
  if (source === "skill-directory") {
    return t("skill-directory");
  }
  if (source === "workspace") {
    return t("Workspace");
  }
  if (source === "gstack") {
    return "gstack";
  }
  return t("Custom");
}

export function skillSourceSnapshotState(
  snapshot: SkillSourceSnapshot | undefined,
  t: SettingsTranslator,
): { readonly label: string; readonly tone: "backed" | "warning" | "missing" } {
  if (!snapshot) {
    return { label: t("Metadata only"), tone: "missing" };
  }
  const warningCodes = new Set(snapshot.warnings.map((warning) => warning.code));
  if (warningCodes.has("drifted_upstream")) {
    return { label: t("Drifted source"), tone: "warning" };
  }
  if (warningCodes.has("missing_upstream")) {
    return { label: t("Missing upstream"), tone: "warning" };
  }
  if (warningCodes.has("orphaned_snapshot")) {
    return { label: t("Orphaned source"), tone: "warning" };
  }
  if (snapshot.warnings.length > 0) {
    return { label: t("{count} warnings", { count: snapshot.warnings.length }), tone: "warning" };
  }
  return { label: t("Source-backed"), tone: "backed" };
}

export function defaultSelectedSyncSkillIds(records: readonly SkillSourceSyncPreviewRecord[], allowNewSkills: boolean): readonly string[] {
  return records
    .filter((record) => record.state === "attachable" || record.state === "drifted" || (allowNewSkills && record.state === "new"))
    .filter((record) => isSelectableSyncRecord(record, allowNewSkills))
    .map((record) => record.skillId);
}

export function isSelectableSyncRecord(record: SkillSourceSyncPreviewRecord, allowNewSkills: boolean): boolean {
  if (record.semanticDiff.some((item) => item.severity === "error")) {
    return false;
  }
  if (record.state === "new") {
    return allowNewSkills && !record.warnings.some((warning) => warning.severity === "error");
  }
  if (record.state === "attachable" || record.state === "drifted" || record.state === "unchanged") {
    return !record.warnings.some((warning) => warning.severity === "error");
  }
  return false;
}

export function syncRecordTitle(record: SkillSourceSyncPreviewRecord): string {
  return record.definitionPreview?.name ?? record.frontMatter?.name ?? record.agentMetadata?.displayName ?? record.skillId;
}

export function skillSourceSyncStateLabel(state: SkillSourceSyncRecordState, t: (key: string) => string): string {
  switch (state) {
    case "attachable":
      return t("Attachable");
    case "unchanged":
      return t("Unchanged");
    case "drifted":
      return t("Drifted");
    case "new":
      return t("New");
    case "missing":
      return t("Missing");
    case "blocked":
      return t("Blocked");
    case "orphaned":
      return t("Orphaned");
  }
}

export function skillSourceSyncDiffLabel(item: SkillSourceSyncDiffItem, t: (key: string) => string): string {
  switch (item.field) {
    case "sourceChecksum":
      return t("Checksum");
    case "upstreamVersion":
      return t("Upstream version");
    case "upstreamSkillPath":
      return t("Skill path");
    case "sourceLengthChars":
      return t("Source length");
    case "referencedFiles":
      return t("Referenced files");
    case "warnings":
      return t("Warnings");
    case "frontMatterName":
      return t("Front matter name");
    case "frontMatterDescription":
      return t("Front matter description");
    case "agentDisplayName":
      return t("Agent display name");
    case "agentShortDescription":
      return t("Agent short description");
    case "agentAllowImplicitInvocation":
      return t("Implicit invocation");
  }
}

export function skillSourceSemanticDiffLabel(item: SkillSourceSemanticDiffItem, t: (key: string) => string): string {
  switch (item.kind) {
    case "copy_change":
      return t("Copy");
    case "workflow_change":
      return t("Workflow");
    case "gate_change":
      return t("Gate");
    case "tool_claim_change":
      return t("Tool claim");
    case "host_claim_change":
      return t("Host claim");
    case "external_action_change":
      return t("External action");
    case "destructive_claim_change":
      return t("Destructive claim");
    case "secret_claim_change":
      return t("Secret claim");
    case "referenced_file_change":
      return t("Referenced files");
  }
}

export function sourceHealthKindLabel(kind: string, t: (key: string) => string): string {
  if (kind === "missing_source_snapshot") {
    return t("Missing source snapshot");
  }
  if (kind === "source_warning") {
    return t("Source warning");
  }
  if (kind === "orphaned_source_snapshot") {
    return t("Orphaned source snapshot");
  }
  if (kind === "token_bloat") {
    return t("Token bloat");
  }
  if (kind === "missing_or_weak_routing_description") {
    return t("Weak routing description");
  }
  if (kind === "reference_duplication") {
    return t("Reference duplication");
  }
  if (kind === "body_taxonomy_risk") {
    return t("Mixed skill body");
  }
  if (kind === "source_snapshot_gap") {
    return t("Source snapshot gap");
  }
  if (kind === "optimization_unsafe") {
    return t("Manual optimization review");
  }
  return kind;
}

export function sourceHealthTitle(finding: SkillSourceHealthReport["findings"][number], t: SettingsTranslator): string {
  if (finding.kind === "missing_source_snapshot") {
    return t("Skill source snapshot missing");
  }
  if (finding.kind === "source_warning") {
    return t("Skill source warning");
  }
  if (finding.kind === "orphaned_source_snapshot") {
    return t("Orphaned skill source snapshot");
  }
  return t(finding.title);
}

export function sourceHealthMessage(finding: SkillSourceHealthReport["findings"][number], t: SettingsTranslator): string {
  if (finding.kind === "missing_source_snapshot" && finding.skillId) {
    return t("{skill} has registry metadata but no published source snapshot.", { skill: finding.skillId });
  }
  if (finding.kind === "source_warning" && finding.snapshotId) {
    return t("{snapshot} has source warnings.", { snapshot: finding.snapshotId });
  }
  if (finding.kind === "orphaned_source_snapshot" && finding.snapshotId) {
    return t("{snapshot} points at a missing or archived skill.", { snapshot: finding.snapshotId });
  }
  return t(finding.message);
}

export function skillHealthSeverityLabel(severity: SkillHealthSeverity, t: (key: string) => string): string {
  if (severity === "critical") {
    return t("Critical");
  }
  if (severity === "warning") {
    return t("Warning");
  }
  return t("Info");
}

export function skillHealthKindLabel(kind: SkillHealthFinding["kind"], t: (key: string) => string): string {
  switch (kind) {
    case "duplicate_clusters":
      return t("Duplicate skill cluster");
    case "conflicting_triggers":
      return t("Conflicting triggers");
    case "shadowed_skill":
      return t("Shadowed skill");
    case "never_used_skill":
      return t("Never used skill");
    case "stale_candidate":
      return t("Stale candidate");
    case "high_failure_rate_skill":
      return t("High failure rate");
    case "high_user_correction_skill":
      return t("High correction rate");
    case "external_overlap_generated_skill":
      return t("External overlap");
    case "superseded_but_active":
      return t("Superseded but active");
    case "missing_validation_steps":
      return t("Missing validation");
    case "missing_negative_triggers":
      return t("Missing negative triggers");
  }
}

export function skillHealthActionLabel(action: SkillHealthFinding["recommendedAction"], t: (key: string) => string): string {
  switch (action) {
    case "review":
      return t("Review");
    case "merge":
      return t("Merge");
    case "supersede":
      return t("Supersede");
    case "disable":
      return t("Disable");
    case "archive":
      return t("Archive");
    case "add_validation":
      return t("Add validation");
    case "add_negative_triggers":
      return t("Add negative triggers");
    case "reject_candidate":
      return t("Reject candidate");
  }
}

export function isOpenSkillCandidateStatus(status: SkillCandidate["status"]): boolean {
  return status === "pending" || status === "needs_edit" || status === "approved_for_draft";
}

export function isTerminalSkillCandidateStatus(status: SkillCandidate["status"]): boolean {
  return status === "published" || status === "rejected" || status === "quarantined" || status === "superseded" || status === "expired";
}

export function skillCandidateGate(candidate: SkillCandidate, t: SettingsTranslator): {
  readonly labels: readonly string[];
  readonly approvalBlocked: boolean;
  readonly draftBlocked: boolean;
} {
  const labels: string[] = [];
  if (candidate.definition.negativeTriggers.length === 0) {
    labels.push(t("Missing negative triggers"));
  }
  if (candidate.definition.validationSteps.length === 0) {
    labels.push(t("Missing validation"));
  }
  if (candidate.safetyFindings.some((finding) => finding.severity === "critical")) {
    labels.push(t("Critical safety finding"));
  }
  const duplicateBlocking = candidate.duplicateAnalysis.decision === "update_existing" ||
    candidate.duplicateAnalysis.decision === "conflict_review" ||
    candidate.duplicateAnalysis.decision === "reject_duplicate";
  if (duplicateBlocking) {
    labels.push(t("Duplicate review required"));
  }
  return {
    labels: labels.length > 0 ? labels : [t("Draft gates clear")],
    approvalBlocked: candidate.definition.negativeTriggers.length === 0 ||
      candidate.definition.validationSteps.length === 0 ||
      candidate.safetyFindings.some((finding) => finding.severity === "critical"),
    draftBlocked: duplicateBlocking,
  };
}

export function skillCandidateStatusLabel(status: SkillCandidate["status"], t: (key: string) => string): string {
  switch (status) {
    case "pending":
      return t("Pending");
    case "needs_edit":
      return t("Needs edit");
    case "approved_for_draft":
      return t("Approved for draft");
    case "published":
      return t("Published");
    case "rejected":
      return t("Rejected");
    case "quarantined":
      return t("Quarantined");
    case "superseded":
      return t("Superseded");
    case "expired":
      return t("Expired");
  }
}

export function playbookCandidateStatusLabel(status: ChannelPlaybookCandidate["status"], t: (key: string) => string): string {
  switch (status) {
    case "draft":
      return t("Draft");
    case "active":
      return t("Active");
    case "cancelled":
      return t("Cancelled");
    case "stale":
      return t("Stale");
  }
}

export function procedureObservationClusterStatusLabel(status: ProcedureObservationCluster["status"], t: (key: string) => string): string {
  switch (status) {
    case "collecting":
      return t("Collecting");
    case "ready_for_review":
      return t("Ready for review");
    case "blocked":
      return t("Blocked");
    case "routed_elsewhere":
      return t("Routed elsewhere");
  }
}

export function procedureObservationClusterActionLabel(action: ProcedureObservationCluster["recommendedAction"], t: (key: string) => string): string {
  switch (action) {
    case "append_evidence":
      return t("Append evidence");
    case "create_skill_candidate":
      return t("Create skill candidate");
    case "create_channel_protocol_candidate":
      return t("Create channel protocol candidate");
    case "create_playbook_candidate":
      return t("Create playbook candidate");
    case "create_memory_candidate":
      return t("Create memory candidate");
    case "create_automation_candidate":
      return t("Create automation candidate");
    case "policy_review":
      return t("Policy review");
    case "dismiss":
      return t("Dismiss");
  }
}

export function candidateRouteKindLabel(routeKind: ProcedureObservationCluster["routeKind"], t: (key: string) => string): string {
  switch (routeKind) {
    case "memory":
      return t("Memory");
    case "channel_protocol":
      return t("Channel protocol");
    case "playbook":
      return t("Playbook");
    case "automation":
      return t("Automation");
    case "skill":
      return t("Skill");
    case "approval_policy_review":
      return t("Approval policy review");
    case "reject":
      return t("Reject");
  }
}

export function candidateRouteBlockerLabel(blocker: ProcedureObservationCluster["routeBlockers"][number], t: (key: string) => string): string {
  switch (blocker) {
    case "insufficient_evidence":
      return t("Insufficient evidence");
    case "one_off_preference":
      return t("One-off preference");
    case "missing_validation":
      return t("Missing validation");
    case "missing_negative_trigger":
      return t("Missing negative trigger");
    case "duplicate_existing_skill":
      return t("Duplicate existing skill");
    case "conflicts_with_pending_candidate":
      return t("Conflicts with pending candidate");
    case "permission_expansion":
      return t("Permission expansion");
    case "unsafe_or_secret_adjacent":
      return t("Secret-adjacent");
  }
}

export function skillCandidateOriginLabel(origin: SkillCandidate["origin"], t: (key: string) => string): string {
  switch (origin) {
    case "ling-generated":
      return t("Ling generated");
    case "recording":
      return t("Recording");
    case "manual-draft":
      return t("Manual draft");
    case "import-overlay":
      return t("Import overlay");
  }
}

export function skillDuplicateDecisionLabel(decision: SkillCandidate["duplicateAnalysis"]["decision"], t: (key: string) => string): string {
  switch (decision) {
    case "no_overlap":
      return t("No overlap");
    case "append_evidence":
      return t("Append evidence");
    case "update_existing":
      return t("Update existing");
    case "conflict_review":
      return t("Conflict review");
    case "reject_duplicate":
      return t("Reject duplicate");
  }
}

export function skillCandidateReviewReason(action: SkillCandidateReviewAction, t: (key: string) => string): string {
  if (action === "approve_for_draft") {
    return t("Approved from Skill Candidate Review panel.");
  }
  if (action === "reject") {
    return t("Rejected from Skill Candidate Review panel.");
  }
  if (action === "request_changes") {
    return t("Changes requested from Skill Candidate Review panel.");
  }
  return t("Reviewed from Skill Candidate Review panel.");
}

export function skillCandidateReviewMessage(action: SkillCandidateReviewAction, t: (key: string) => string): string {
  if (action === "approve_for_draft") {
    return t("Candidate approved for draft");
  }
  if (action === "reject") {
    return t("Candidate rejected");
  }
  if (action === "request_changes") {
    return t("Candidate marked needs edit");
  }
  return t("Candidate reviewed");
}

export function playbookCandidateReviewReason(action: ChannelPlaybookCandidateReviewAction, t: (key: string) => string): string {
  return action === "approve"
    ? t("Approved from Playbook Candidate Review panel.")
    : t("Rejected from Playbook Candidate Review panel.");
}

export function playbookCandidateReviewMessage(action: ChannelPlaybookCandidateReviewAction, t: (key: string) => string): string {
  return action === "approve" ? t("Playbook activated") : t("Playbook candidate rejected");
}

export function boundTeammateNames(skillId: string, summaries: readonly TeammateSkillBindingSummary[]): readonly string[] {
  return summaries
    .filter((summary) => summary.bindings.some((binding) => binding.skillId === skillId && binding.enabled))
    .map((summary) => summary.teammate.displayName);
}
