import type { ComposerSlashCommandOption } from "@ling-stack/core/composer-slash-intents";
import type {
  AuthorizationMode,
  ConversationAttachment,
  ConversationPendingReplacement,
  ConversationTranscriptStatus,
  ExecutionAction,
  LingTurn,
  PermissionConfirmation,
  PermissionPreset,
  ProviderThinkingMode,
  RunSession,
  SessionPermissionMode,
  TerminalReportDto,
  WorkspaceAccessMode,
} from "../../types.js";

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
  readonly thinkingModes?: readonly ProviderThinkingMode[];
}

export interface ConversationHomeModelSelection {
  readonly providerPresetId?: string;
  readonly thinkingLevel?: ProviderThinkingMode;
}

export interface ConversationHomeMessage {
  readonly id: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly role: "user" | "assistant" | "system";
  readonly authorLabel?: string;
  readonly content: string;
  readonly attachments?: readonly ConversationAttachment[];
  readonly status?: ConversationTranscriptStatus;
  readonly revision?: number;
  readonly editedAt?: string;
  readonly pendingReplacement?: ConversationPendingReplacement;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

export interface ConversationHomeDetailContext {
  readonly threadId?: string;
  readonly turns: readonly LingTurn[];
  readonly runs: readonly RunSession[];
  readonly executionActions: readonly ExecutionAction[];
  readonly terminalReports: readonly TerminalReportDto[];
}

export interface ConversationHomeSendInput {
  readonly message: string;
  readonly attachmentIds: readonly string[];
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
  readonly defaultProviderLabel: string;
  readonly defaultProviderPresetId: string;
  readonly modelOptions: readonly ConversationHomeModelOption[];
  readonly slashCommands: readonly ComposerSlashCommandOption[];
  readonly workspaceCwd: string;
  readonly sending?: boolean;
  readonly activeRun?: RunSession;
  readonly stopping?: boolean;
  readonly onOpenRun?: (runId: string) => void;
  readonly onConfirmFullAccess?: () => Promise<PermissionConfirmation | undefined>;
  readonly onRefreshConversation?: () => void | Promise<void>;
  readonly onStopConversation?: () => void | Promise<void>;
  readonly onSendConversation: (input: ConversationHomeSendInput) => Promise<void>;
}
