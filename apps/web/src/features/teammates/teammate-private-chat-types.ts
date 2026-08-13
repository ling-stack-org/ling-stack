import type { ReactVirtualizer, VirtualItem } from "@tanstack/react-virtual";
import type {
  DragEvent,
  KeyboardEvent,
  ReactNode,
  RefObject,
  UIEvent,
} from "react";
import type { ComposerInputPart, PendingAttachmentItem } from "../../shared/components/index.js";
import type {
  AiTeammate,
  ApprovalRequest,
  Channel,
  ConversationGeneratedMedia,
  ExecutionAction,
  MemoryObject,
  PermissionConfirmation,
  PermissionPreset,
  RunSession,
  TeammateDirectLinkPreview,
  TeammateDirectMessage,
  TeammateDirectReplyIntervention,
  TeammatePrivateAttachment,
  TerminalReportDto,
  UsedMemoryEvent,
  UserProfile,
  WorkspaceAccessMode,
} from "../../types.js";
import type {
  WorkspaceRightDockFileTarget,
  WorkspaceRightDockPageRequest,
  WorkspaceRightDockReviewTarget,
} from "../workspace/right-dock/index.js";
import type { WorkspaceRightDockController } from "../workspace/useWorkspaceRightDockController.js";

export type TeammatePrivateComposerFileReferencePart = Extract<
  ComposerInputPart,
  { readonly type: "workspace_file" }
>;

export interface TeammatePrivateModelNotice {
  readonly description: string;
  readonly modelLabel: string;
}

export interface TeammatePrivateChatSurfaceProps {
  readonly cwd: string;
  readonly teammate: AiTeammate;
  readonly userProfile?: UserProfile;
  readonly loading: boolean;
  readonly visibleMessages: readonly TeammateDirectMessage[];
  readonly generatedMedia: readonly ConversationGeneratedMedia[];
  readonly normalizedMessageSearchQuery: string;
  readonly privateFeedRef: RefObject<HTMLDivElement | null>;
  readonly privateMessageFeedVirtualizer: ReactVirtualizer<HTMLDivElement, Element>;
  readonly privateMessageFeedVirtualRows: readonly VirtualItem[];
  readonly usedMemoryEvents: readonly UsedMemoryEvent[];
  readonly memoryById: ReadonlyMap<string, MemoryObject>;
  readonly runs: readonly RunSession[];
  readonly executionActions: readonly ExecutionAction[];
  readonly approvals: readonly ApprovalRequest[];
  readonly terminalReports: readonly TerminalReportDto[];
  readonly providerRecovered: boolean;
  readonly modelNotice?: TeammatePrivateModelNotice;
  readonly privateAttachmentById: ReadonlyMap<string, TeammatePrivateAttachment>;
  readonly taskCreateBusyKeys: ReadonlySet<string>;
  readonly taskCreateErrors: Readonly<Record<string, string>>;
  readonly taskChannelOptions: readonly Channel[];
  readonly latestButtonVisible: boolean;
  readonly hasDirectRuntimeActivity: boolean;
  readonly directReplyActive: boolean;
  readonly directGuidanceSubmitting: "queue_followup" | "interrupt_redirect" | "stop" | "";
  readonly directGuidanceCancelingId: string;
  readonly directGuidancePromotingId: string;
  readonly openDirectInterventions: readonly TeammateDirectReplyIntervention[];
  readonly directLinkPreviewById: ReadonlyMap<string, TeammateDirectLinkPreview>;
  readonly messageDraft: string;
  readonly fullAccessConfirmed: boolean;
  readonly privateComposerSending: boolean;
  readonly privateComposerSendDisabled: boolean;
  readonly privateComposerSendLabel: string;
  readonly privateComposerSendingLabel: string;
  readonly privateComposerHasGuidancePayload: boolean;
  readonly privateComposerPlaceholder: string;
  readonly uploadingAttachments: boolean;
  readonly pendingAttachments: readonly PendingAttachmentItem<TeammatePrivateAttachment>[];
  readonly pendingDirectLinkPreviews: readonly TeammateDirectLinkPreview[];
  readonly slashCommands: readonly { readonly id: string; readonly label: string }[];
  readonly composerInputParts: readonly ComposerInputPart[];
  readonly composerFileReferenceParts: readonly TeammatePrivateComposerFileReferencePart[];
  readonly composerFileReferenceTokens: readonly {
    readonly part: TeammatePrivateComposerFileReferencePart;
    readonly occurrenceIndex: number;
  }[];
  readonly composerDragActive: boolean;
  readonly onPrivateFeedScroll: (event: UIEvent<HTMLDivElement>) => void;
  readonly onCancelPrivateFeedAutoFollow: () => void;
  readonly onScrollToLatest: () => void;
  readonly onCopyMessageText: (text: string) => void;
  readonly onOpenRun?: (runId: string) => void;
  readonly onOpenFiles: (target?: WorkspaceRightDockFileTarget) => void;
  readonly onOpenReview: (target: WorkspaceRightDockReviewTarget) => void;
  readonly onCreateTaskFromMessage: (message: TeammateDirectMessage) => void | Promise<void>;
  readonly onPromoteDirectGuidance: (interventionId: string) => void | Promise<void>;
  readonly onCancelDirectGuidance: (interventionId: string) => void | Promise<void>;
  readonly onEditDirectGuidance: (intervention: TeammateDirectReplyIntervention) => void | Promise<void>;
  readonly onRefreshMessages: () => void | Promise<void>;
  readonly onOpenModelSettings: () => void;
  readonly onMessageDraftChange: (value: string) => void;
  readonly onComposerSubmit: (authorization: {
    readonly permissionPreset: PermissionPreset;
    readonly permissionConfirmation?: PermissionConfirmation;
  }) => void;
  readonly onComposerKeyDown: (
    event: KeyboardEvent<HTMLDivElement>,
    authorization: {
      readonly permissionPreset: PermissionPreset;
      readonly permissionConfirmation?: PermissionConfirmation;
    },
  ) => void;
  readonly onComposerPasteFiles: (files: readonly File[]) => void;
  readonly onComposerDragOver: (event: DragEvent<HTMLDivElement>) => void;
  readonly onComposerDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  readonly onComposerDrop: (event: DragEvent<HTMLDivElement>) => void;
  readonly onUploadPrivateFiles: (files: readonly File[]) => void | Promise<void>;
  readonly onRemoveComposerFileReference: (raw: string, occurrenceIndex: number) => void;
  readonly onRemovePendingLinkPreview: (previewId: string) => void;
  readonly onRemovePendingAttachment: (localId: string) => void | Promise<void>;
  readonly workspaceAccessMode: WorkspaceAccessMode;
  readonly onWorkspaceAccessModeChange: (mode: WorkspaceAccessMode) => void;
  readonly onFullAccessPresetSelected?: () => void;
  readonly dockOpen: boolean;
  readonly dockController: WorkspaceRightDockController;
  readonly dockPageRequest?: WorkspaceRightDockPageRequest;
  readonly dockActions?: ReactNode;
  readonly terminalOpen: boolean;
  readonly summaryOpen: boolean;
  readonly dockViewModel: import("./teammate-private-dock.js").TeammatePrivateDockViewModel;
  readonly onDockPageRequestConsumed: (nonce: number) => void;
  readonly onDockClose: () => void;
  readonly onTerminalClose: () => void;
}
