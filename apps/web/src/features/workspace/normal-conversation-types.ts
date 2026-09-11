import type { ComposerSlashCommandOption } from "@ling-stack/core/composer-slash-intents";
import type {
  AuthorizationMode,
  ApprovalRequest,
  ChannelMessageFileRef,
  ConversationActiveReplyTarget,
  ConversationAttachment,
  ConversationPendingReplacement,
  ConversationGeneratedMedia,
  ConversationItemV1,
  ConversationNarrationSegment,
  RunArtifact,
  ConversationTranscriptStatus,
  ExecutionAction,
  LingTurn,
  PermissionConfirmation,
  PermissionPreset,
  ProviderThinkingMode,
  RunSession,
  RunIntervention,
  SessionPermissionMode,
  TerminalReportDto,
  WorkspaceAccessMode,
} from "../../types.js";
import type { InlineApprovalView } from "../../lib/inline-approvals.js";
import type { ApprovalResolution } from "../approvals/types.js";
import type { CanonicalTranscriptProjection } from "@ling-stack/conversation-ui-core";

export interface ConversationHomeProjectSelection {
  readonly projectPath?: string;
  readonly projectLabel?: string;
}

export interface ConversationHomeModelOption {
  readonly id: string;
  readonly displayName: string;
  readonly label?: string;
  readonly model: string;
  readonly providerId?: string;
  readonly enabled?: boolean;
  readonly runnable?: boolean;
  readonly blocker?: string;
  readonly thinkingModes?: readonly ProviderThinkingMode[];
}

export interface ConversationHomeModelSelection {
  readonly providerPresetId?: string;
  readonly thinkingLevel?: ProviderThinkingMode;
}

export interface ConversationHomeMessage {
  readonly canonicalItemId?: string;
  readonly id: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly role: "user" | "assistant" | "system";
  readonly authorLabel?: string;
  readonly content: string;
  readonly narrationSegments?: readonly ConversationNarrationSegment[];
  readonly errorMessage?: string;
  readonly attachments?: readonly ConversationAttachment[];
  readonly fileRefs?: readonly ChannelMessageFileRef[];
  readonly status?: ConversationTranscriptStatus;
  readonly revision?: number;
  readonly editedAt?: string;
  readonly pendingReplacement?: ConversationPendingReplacement;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

export interface ConversationHomeDetailContext {
  readonly threadId?: string;
  /** Canonical Continuity snapshot; messages remain a compatibility view only. */
  readonly conversationItems: readonly ConversationItemV1[];
  readonly runLinks: readonly import("../../types.js").LingTurnRun[];
  readonly turns: readonly LingTurn[];
  readonly runs: readonly RunSession[];
  readonly executionActions: readonly ExecutionAction[];
  readonly approvals: readonly ApprovalRequest[];
  readonly interventions: readonly RunIntervention[];
  readonly terminalReports: readonly TerminalReportDto[];
  readonly artifacts: readonly RunArtifact[];
  readonly plans?: readonly import("../../types.js").ProposedPlanArtifact[];
  readonly compactionCheckpoints?: readonly import("../../types.js").CompactionCheckpoint[];
  readonly contextSnapshots?: readonly import("../../types.js").ConversationContextSnapshot[];
  readonly contextSummaries?: readonly import("../../types.js").ConversationContextSummary[];
  readonly generatedMedia: readonly ConversationGeneratedMedia[];
  /** One canonical typed projection shared by all normal conversation renderers. */
  readonly timelineProjection?: CanonicalTranscriptProjection;
}

export interface ConversationHomeSendInput {
  readonly message: string;
  readonly attachmentIds: readonly string[];
  readonly fileRefs: readonly ChannelMessageFileRef[];
  readonly project: ConversationHomeProjectSelection;
  readonly model: ConversationHomeModelSelection;
  readonly authorization: {
    readonly authorizationMode: AuthorizationMode;
    readonly workspaceAccessMode: WorkspaceAccessMode;
    readonly permissionMode: SessionPermissionMode;
    readonly permissionPreset: PermissionPreset;
    readonly permissionConfirmation?: PermissionConfirmation;
  };
  readonly replaceMessages: (messages: readonly ConversationHomeMessage[]) => void;
  readonly upsertMessage: (message: ConversationHomeMessage) => void;
  readonly failMessage: (message: string) => void;
  readonly onThreadBound: (threadId: string) => void;
  readonly shouldCommit: (threadId?: string) => boolean;
  readonly onMessageAccepted: () => void;
  readonly onReplyLinked: (target: ConversationActiveReplyTarget) => void;
}

export interface ConversationHomeProps {
  readonly conversationTitle?: string;
  readonly initialDraft?: string;
  readonly initialMessages?: readonly ConversationHomeMessage[];
  readonly initialProjectPath?: string;
  readonly initialProjectLabel?: string;
  readonly initialProviderPresetId?: string;
  readonly initialThinkingLevel?: ProviderThinkingMode;
  readonly initialAuthorizationMode?: AuthorizationMode;
  readonly initialWorkspaceAccessMode?: WorkspaceAccessMode;
  readonly initialPermissionMode?: SessionPermissionMode;
  readonly initialPermissionPreset?: PermissionPreset;
  readonly detailContext?: ConversationHomeDetailContext;
  readonly conversationIdentity: string;
  readonly defaultProviderLabel: string;
  readonly defaultProviderPresetId: string;
  readonly modelOptions: readonly ConversationHomeModelOption[];
  readonly slashCommands: readonly ComposerSlashCommandOption[];
  readonly workspaceCwd: string;
  readonly conversationErrorMessage?: string;
  readonly sending?: boolean;
  readonly activeRun?: RunSession;
  readonly inlineApprovalViews: readonly InlineApprovalView[];
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly approvalErrors: Readonly<Record<string, string>>;
  readonly stopping?: boolean;
  readonly fullAccessConfirmed?: boolean;
  readonly onOpenRun?: (runId: string) => void;
  readonly onResolveApproval: (
    approvalId: string,
    decision: ApprovalResolution,
    reason?: string,
    proposedRuleFingerprint?: string,
  ) => void;
  readonly onOpenModelWorkbench?: () => void;
  readonly onConfirmFullAccess?: () => Promise<PermissionConfirmation | undefined>;
  readonly onConfirmFullAccessSelection?: () => Promise<PermissionConfirmation | undefined>;
  readonly onFullAccessConversationBound?: (threadId: string) => void;
  readonly onRefreshConversation?: () => void | Promise<void>;
  readonly onStopConversation?: (target: ConversationActiveReplyTarget) => void | Promise<void>;
  readonly onSendConversation: (input: ConversationHomeSendInput) => Promise<void>;
}
