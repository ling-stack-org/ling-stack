export type {
  ConversationAction,
  ConversationActorKind,
  ConversationAttachmentRef,
  ConversationItem,
  ConversationItemKind,
  ConversationStatus,
  ConversationSurface,
} from "./conversation-types.js";
export type {
  ConversationAgentActivitySpan,
  ConversationAgentActivitySpanKind,
  ConversationActivitySummary,
  ConversationCommandBatch,
  ConversationCommandBatchItem,
  ConversationCommandExecutionView,
  ConversationArtifactStripChangeArtifact,
  ConversationArtifactStripItem,
  ConversationArtifactStripItemKind,
  ConversationOperationCellDraft,
  ConversationOperationCellMode,
  ConversationOperationCellSourceKind,
  ConversationOperationCellStatus,
  ConversationOperationCellViewModel,
  ConversationOperationKind,
  ConversationOperationExecutionView,
  ConversationOperationSourceRef,
  ConversationRuntimeDiagnostic,
  ConversationToolEvidence,
  ConversationTrustedSourceRef,
  ConversationExplorationBatch,
  ConversationTurnRunRole,
  ConversationWorkCellBranch,
  ConversationWorkCellChangePreview,
  ConversationWorkCellDetailsModel,
  ConversationWorkCellEvidenceLink,
  ConversationWorkCellGroup,
  ConversationWorkCellGroupKind,
  ConversationWorkCellItem,
  ConversationWorkCellRow,
  ConversationWorkCellRowDetailLine,
  ConversationWorkCellRowTone,
  ConversationWorkCellStat,
  ConversationWorkCellViewModel,
  ConversationWorkspaceRecoveryTarget,
} from "./work-cell-view-model.js";
export { normalizeConversationOperationCell } from "./work-cell-view-model.js";
export {
  isConversationTimelineItem,
  projectConversationSubAgentActivity,
  projectConversationTimelineItems,
} from "./transcript-item.js";
export type { ActiveRunSnapshot, TimelineSnapshot, TimelineRunLifecycle } from "./timeline-snapshot.js";
export { createTimelineSnapshot } from "./timeline-snapshot.js";
export { projectConversationRunNarration, mergeConversationRunNarration } from "./run-narration.js";
export type { ConversationRunNarrationSegment } from "./run-narration.js";
export {
  conversationTimelineRendererKey,
  fingerprintConversationTimeline,
} from "./timeline-fingerprint.js";
export type {
  ConversationTimelineFingerprint,
} from "./timeline-fingerprint.js";
export {
  createConversationTimelineMessageItem,
  conversationMessageSourceRefs,
} from "./message-item.js";
export type {
  ConversationTimelineMessageInput,
  ConversationTimelineFileRefInput,
} from "./message-item.js";
export {
  mergeConversationTimelineItems,
  normalizeConversationTimelineItems,
} from "./transcript-projector.js";
export {
  mergeCanonicalTranscriptInputs,
  projectCanonicalConversationTimeline,
} from "./canonical-transcript-projector.js";
export type {
  CanonicalCommandEvidence,
  CanonicalApprovalRecord,
  CanonicalArtifactRecord,
  CanonicalPlanRecord,
  CanonicalCompactionRecord,
  CanonicalReasoningSummaryRecord,
  CanonicalTerminalReportProjection,
  CanonicalParticipantSpan,
  CanonicalTurnRunLink,
  CanonicalConversationItem,
  CanonicalExecutionAction,
  CanonicalProjectionSourceRef,
  CanonicalSourceRef,
  CanonicalTerminalEvidenceRef,
  CanonicalTranscriptDiagnostic,
  CanonicalTranscriptDiagnosticCode,
  CanonicalTranscriptProjection,
  CanonicalTranscriptProjectionInput,
  CanonicalTranscriptScope,
} from "./canonical-transcript-projector.js";
export type {
  ConversationTimelineItem,
  ConversationTimelineItemBase,
  ConversationTimelineOperationItemBase,
  ConversationTimelineOperationPayload,
  ConversationTimelineItemKind,
  ConversationTimelineItemStatus,
  ConversationProtocolAction,
  ConversationTimelineActivityPayload,
  ConversationTimelineApprovalItem,
  ConversationTimelineCommandExecutionItem,
  ConversationTimelineContextCompactionItem,
  ConversationTimelineTerminalReportItem,
  ConversationTimelineTerminalReportArtifact,
  ConversationTimelineTerminalReportChange,
  ConversationTimelineTerminalReportCorrection,
  ConversationTimelineTerminalReportParticipant,
  ConversationTimelineTerminalReportRisk,
  ConversationTimelineTerminalReportVerification,
  ConversationTimelineProtocolEventItem,
  ConversationTimelineExplorationItem,
  ConversationTimelineFileChangeItem,
  ConversationTimelineDiagnosticItem,
  ConversationTimelineRuntimeDiagnostic,
  ConversationTimelineImageViewItem,
  ConversationTimelineMessageItem,
  ConversationTimelineUserInputItem,
  ConversationTimelineUserInputRequestItem,
  ConversationTimelineUserInputAnswerItem,
  ConversationTimelinePlanItem,
  ConversationTimelineReasoningItem,
  ConversationTimelineInput,
  ConversationTimelineProjectionOptions,
  ConversationTimelineRowItem,
  ConversationTimelineToolCallItem,
  ConversationTimelineBatchItem,
  ConversationTimelineCommandBatchItem,
  ConversationTimelineCommandBatchPayload,
  ConversationTimelineExplorationBatchItem,
  ConversationTimelineExplorationBatchPayload,
  ConversationTimelineSubAgentItem,
} from "./transcript-item.js";
export { projectCanonicalUserInputTimeline } from "./user-input-timeline.js";
export {
  isCommandBatchEligible,
  projectConversationCommandBatches,
} from "./command-batching.js";
export {
  batchCanonicalTranscriptItems,
  expandDisplayBatch,
  projectDisplayBatches,
} from "./typed-transcript-batching.js";
export type {
  BatchSplitBoundary,
  BatchSplitReason,
  DisplayBatchProjection,
  DisplayProjectionContext,
} from "./typed-transcript-batching.js";
export {
  isExplorationBatchEligible,
  projectConversationActivity,
  projectConversationExplorationBatches,
  summarizeConversationActivity,
} from "./activity-projection.js";
export type {
  TerminalReportViewInput,
  TerminalReportViewModel,
} from "./terminal-report-view-model.js";
export { terminalReportToViewModel } from "./terminal-report-view-model.js";
export { isUserVisibleTerminalReportArtifact, isUserVisibleTerminalReportSourceRef } from "./terminal-report-visibility.js";
export { terminalReportSourceRefs, projectVisibleTerminalReportContent, visibleTerminalReportTimelineItem } from "./terminal-report-presentation.js";
export type {
  ConversationInteractionPolicy,
  ConversationInteractionSurfaceKind,
  ConversationTimelineScope,
  ConversationTimelineScopeKind,
  MessageActionKind,
  SourceIconKind,
} from "./surface-policy.js";
export {
  conversationActionAllowedByPolicy,
  getConversationInteractionPolicy,
  mergeConversationInteractionPolicy,
  resolveTimelineScope,
} from "./surface-policy.js";
export {
  findLatestEditableConversationMessage,
} from "./message-edit-policy.js";
export type {
  ConversationMessageEditAuthor,
  ConversationMessageEditCandidate,
  ConversationMessageEditScope,
} from "./message-edit-policy.js";
export { projectConversationMessagePresentation } from "./message-presentation.js";
export type {
  ConversationMessagePresentation,
  ConversationMessagePresentationInput,
} from "./message-presentation.js";
export {
  getTerminalReportProjectionPolicy,
} from "./terminal-report-projection-policy.js";
export type {
  TerminalReportArtifactMode,
  TerminalReportProjectionPolicy,
} from "./terminal-report-projection-policy.js";
export {
  composerSlashCommandParts,
  composerUrlReferenceParts,
  composerWorkspaceFileParts,
  parseComposerInputParts,
  removeComposerInputRawToken,
  serializeComposerInputParts,
} from "./composer-input-parts.js";
export type {
  ComposerInputAttachmentOption,
  ComposerInputLinkPreviewOption,
  ComposerInputMentionOption,
  ComposerInputPart,
  ComposerInputSkillOption,
  ComposerInputSlashCommandOption,
  ParseComposerInputPartsOptions,
} from "./composer-input-parts.js";
export {
  filterSlashCommandPickerOptions,
  findActiveSlashCommand,
  insertSlashCommandToken,
} from "./slash-command-picker.js";
export type { ActiveSlashCommandPicker } from "./slash-command-picker.js";
export {
  collectLocalFileReferences,
  parseLocalFileReference,
  parseMessageBody,
  splitInlineTokens,
} from "./message-body.js";
export type {
  LocalFileReference,
  MessageBodyBlock,
  MessageBodyParseOptions,
  MessageInlineToken,
  MessageListItem,
} from "./message-body.js";
export {
  conversationPermissionPresetRequiresConfirmation,
  defaultConversationAuthorizationModeOptions,
  defaultConversationPermissionPresetOptions,
} from "./permission-policy.js";
export type {
  ConversationAuthorizationMode,
  ConversationAuthorizationModeOption,
  ConversationPermissionPreset,
  ConversationPermissionPresetOption,
} from "./permission-policy.js";
export {
  activeDockPage,
  createDockPageEntry,
  popDockPage,
  pushDockPage,
  resetDockStack,
} from "./dock-page-stack.js";
export type {
  DockEvidenceGroupView,
  DockEvidenceItem,
  DockEvidenceKind,
  DockFileItem,
  DockLauncherItem,
  DockPageKind,
  DockPageStackEntry,
  DockReviewArtifactRef,
  DockReviewChangeStats,
  DockReviewCodeLine,
  DockReviewCodeLineKind,
  DockReviewCodePreview,
  DockReviewFact,
  DockReviewGroup,
  DockReviewInlineNote,
  DockReviewInlineNoteSeverity,
  DockReviewItem,
  DockReviewKind,
  DockReviewStatus,
  DockSeverity,
  DockSurfaceKind,
} from "./dock-types.js";
export { reconcileCanonicalUserInputs, isUserInputAnchor, userInputTranscriptRevisionSignature } from "./user-input-transcript-snapshot.js";
export type { CanonicalUserInput, CanonicalUserInputRequest, CanonicalUserInputAnswer, CanonicalUserInputUnavailable, CanonicalUserInputSource, CanonicalUserInputAnswerAuthority, CanonicalUserInputSnapshot } from "./user-input-transcript-snapshot.js";
export { interleaveUserInputRunTimeline } from "./user-input-event-order.js";
export { interleaveConversationUserInputRows } from "./conversation-user-input-order.js";
