import type {
  ApprovalRequest,
  Channel,
  ChannelWorkflowStep,
  ExternalWorkActionView,
  ExternalWorkCiTriageView,
  RunArtifact,
  RunSession,
  Task,
  WorkItemClaimBlocker,
  WorkItemView as DurableWorkItemView,
} from "../../types.js";
import type { WorkBoardActionFailure, WorkBoardMutation, WorkBoardOpenIntent, WorkBoardScope } from "./work-board-types.js";

export type WorkBoardActionResult = boolean | void | Promise<boolean | void>;

export interface GlobalWorkBoardPageProps {
  readonly channels: readonly Channel[];
  readonly tasks: readonly Task[];
  readonly runs: readonly RunSession[];
  readonly approvals: readonly ApprovalRequest[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly externalActionDetails: Readonly<Record<string, ExternalWorkActionView>>;
  readonly externalWorkCiTriage: readonly ExternalWorkCiTriageView[];
  readonly artifactsByRun?: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly durableWorkItems?: readonly DurableWorkItemView[];
  readonly workspaceCwd?: string;
  readonly loading?: boolean;
  readonly onRefresh: () => WorkBoardActionResult;
  readonly onOpenTask: (taskId: string) => WorkBoardActionResult;
  readonly onOpenRun: (runId: string) => WorkBoardActionResult;
  readonly onOpenApproval: (approvalId: string) => WorkBoardActionResult;
  readonly onOpenChannel: (channelId: string) => WorkBoardActionResult;
  readonly onRouteExternalWork?: (externalWorkId: string, channelId: string) => WorkBoardActionResult;
  readonly onClaimWorkItem?: (workItemId: string) => WorkBoardActionResult;
  readonly onHeartbeatWorkItem?: (workItemId: string, claimToken: string) => WorkBoardActionResult;
  readonly onReleaseWorkItem?: (workItemId: string, claimToken: string) => WorkBoardActionResult;
  readonly onCompleteWorkItem?: (workItemId: string, claimToken: string) => WorkBoardActionResult;
  readonly onFailWorkItem?: (workItemId: string, claimToken: string, reason?: string) => WorkBoardActionResult;
  readonly busyByWorkItemId?: ReadonlyMap<string, WorkBoardMutation>;
  readonly failureByWorkItemId?: ReadonlyMap<string, WorkBoardActionFailure>;
  readonly blockerByWorkItemId?: ReadonlyMap<string, WorkItemClaimBlocker>;
  readonly routingByExternalWorkId?: ReadonlySet<string>;
  readonly routingExternalWorkId?: string;
  readonly busyWorkItemId?: string;
  readonly requestedScope?: WorkBoardScope;
  readonly requestedItemId?: string;
  readonly openIntent?: WorkBoardOpenIntent;
  readonly settingsToolMode?: boolean;
}
