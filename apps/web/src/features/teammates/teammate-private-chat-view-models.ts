import { projectConversationMessagePresentation } from "@ling-stack/conversation-ui-core";
import { artifactContentUrl } from "../../api.js";
import type { Translate } from "../../i18n.js";
import {
  buildConversationWorkCellViewModel,
  type ConversationWorkCellViewModel,
} from "../../lib/conversation-work-cell.js";
import { conversationRunHasVisibleWork } from "../../lib/conversation-runtime-visibility.js";
import { providerRunPreflightBlocker } from "../../lib/providers.js";
import type { LocalFileReference } from "../../shared/conversation/index.js";
import type {
  ApprovalRequest,
  AiTeammateModelBindingMode,
  ExecutionAction,
  ProviderPreset,
  RunSession,
  TeammateDirectLinkPreview,
  TeammateDirectMessage,
  TeammatePrivateAttachment,
  TerminalReportDto,
} from "../../types.js";
import type { WorkspaceRightDockFileTarget } from "../workspace/right-dock/index.js";
import type { TeammatePrivateModelNotice } from "./teammate-private-chat-types.js";
import { isHistoricalProviderPreflightMessage } from "./teammate-workspace-utils.js";

export function buildTeammatePrivateModelNotice({
  bindingMode,
  effectiveProviderId,
  provider,
  t,
}: {
  readonly bindingMode: AiTeammateModelBindingMode;
  readonly effectiveProviderId: string;
  readonly provider: ProviderPreset | undefined;
  readonly t: Translate;
}): TeammatePrivateModelNotice | undefined {
  const blocker = providerRunPreflightBlocker(provider, t);
  if (!blocker) return undefined;

  const description = !effectiveProviderId
    ? bindingMode === "workspace_default"
      ? t("Set a workspace default chat model in Model Workbench.")
      : t("Choose a configured chat model, or open Model Workbench to add one.")
    : !provider
      ? t("The previously selected model no longer exists. Choose another model or open Model Workbench.")
      : blocker;

  return {
    description,
    modelLabel: provider ? `${provider.displayName} / ${provider.model}` : t("No model selected"),
  };
}

export interface TeammatePrivateMessageProjection {
  readonly authorName: string;
  readonly authorType: TeammateDirectMessage["authorType"];
  readonly blocked: boolean;
  readonly body: string;
  readonly errorText: string;
  readonly copyBody: string;
  readonly userGuidance: boolean;
  readonly pendingAiReply: boolean;
  readonly recoveredHistoricalProviderFailure: boolean;
}

export function projectTeammatePrivateMessage({
  hasStructuredTerminalReport,
  localUserDisplayName,
  message,
  providerRecovered,
  teammateDisplayName,
  t,
}: {
  readonly hasStructuredTerminalReport: boolean;
  readonly localUserDisplayName: string;
  readonly message: TeammateDirectMessage;
  readonly providerRecovered: boolean;
  readonly teammateDisplayName: string;
  readonly t: Translate;
}): TeammatePrivateMessageProjection {
  const pendingAiReply = message.authorType === "ai-teammate" && message.status === "pending";
  const blocked = message.status === "blocked" || message.status === "failed" || message.status === "cancelled";
  const recoveredHistoricalProviderFailure = providerRecovered && isHistoricalProviderPreflightMessage(message);
  const guidanceBody = projectUserGuidanceBody(message);
  const authorType = guidanceBody === undefined ? message.authorType : "local-user";
  const authorName = authorType === "ai-teammate"
    ? teammateDisplayName
    : authorType === "system"
      ? t("System")
      : localUserDisplayName;
  const bodyContent = recoveredHistoricalProviderFailure
    ? t("Historical model check failed. The model is available now; resend or continue the chat.")
    : guidanceBody ?? message.body;
  const messagePresentation = projectConversationMessagePresentation({
    content: bodyContent,
    errorMessage: message.errorMessage,
    status: message.status,
    streaming: pendingAiReply,
    streamingPlaceholder: t("AI teammate is replying..."),
  });
  const body = hasStructuredTerminalReport && message.authorType === "ai-teammate"
    ? ""
    : message.status === "cancelled" && !bodyContent.trim()
    ? t("Reply stopped")
    : messagePresentation.body;

  return {
    authorName,
    authorType,
    blocked,
    body,
    errorText: recoveredHistoricalProviderFailure ? "" : messagePresentation.errorText,
    copyBody: guidanceBody ?? message.body,
    userGuidance: guidanceBody !== undefined,
    pendingAiReply,
    recoveredHistoricalProviderFailure,
  };
}

const directGuidancePrefixes = [
  "排队引导：",
  "已停止上一条回复，并按新引导继续：",
] as const;

function projectUserGuidanceBody(message: TeammateDirectMessage): string | undefined {
  if (message.authorType !== "system") {
    return undefined;
  }
  const source = message.body.trim();
  const prefix = directGuidancePrefixes.find((candidate) => source.startsWith(candidate));
  if (!prefix) {
    return undefined;
  }
  const detailLineCount = Number(message.attachmentIds.length > 0)
    + Number(message.linkPreviewIds.length > 0)
    + Number(message.fileRefs.length > 0);
  const lines = source.slice(prefix.length).trimStart().split("\n");
  return lines.slice(0, detailLineCount > 0 ? -detailLineCount : undefined).join("\n").trim();
}

export function buildTeammatePrivateWorkCellMap(input: {
  readonly messages: readonly TeammateDirectMessage[];
  readonly teammateId: string;
  readonly runs: readonly RunSession[];
  readonly executionActions: readonly ExecutionAction[];
  readonly approvals: readonly ApprovalRequest[];
  readonly terminalReports: readonly TerminalReportDto[];
  readonly t: Translate;
}): ReadonlyMap<string, { readonly model: ConversationWorkCellViewModel }> {
  const runById = new Map(input.runs.map((run) => [run.id, run]));
  const cells = new Map<string, { readonly model: ConversationWorkCellViewModel }>();
  for (const message of input.messages) {
    if (message.authorType !== "ai-teammate" || !message.linkedRunId) {
      continue;
    }
    const run = runById.get(message.linkedRunId);
    if (!run?.threadId || (run.teammateId && run.teammateId !== input.teammateId)) {
      continue;
    }
    const executionActions = input.executionActions.filter((action) => action.runId === run.id);
    const approvals = input.approvals.filter((approval) => approval.runId === run.id);
    const terminalReport = input.terminalReports.find((report) =>
      (report.source.kind === "run" && report.source.id === run.id) ||
      (Boolean(report.threadId) && report.threadId === run.threadId)
    );
    if (!conversationRunHasVisibleWork({ run, approvals, executionActions, terminalReport })) {
      continue;
    }
    const model = buildConversationWorkCellViewModel({
      threadId: run.threadId,
      runs: [run],
      allowRunThreadFallback: true,
      approvals,
      artifactsByRun: {},
      executionActions,
      t: input.t,
      artifactHref: (artifact) => artifactContentUrl(artifact.id, run.cwd),
      terminalReport,
    });
    if (model) {
      cells.set(message.id, { model });
    }
  }
  return cells;
}

export function teammateWorkspaceFileTarget(reference: LocalFileReference): WorkspaceRightDockFileTarget {
  const location = reference.location ?? "";
  const path = location && reference.displayPath.endsWith(location)
    ? reference.displayPath.slice(0, -location.length)
    : reference.displayPath;
  const lineMatch = /^(?::|#L)(\d+)/u.exec(location);
  return {
    path,
    line: lineMatch ? Number(lineMatch[1]) : undefined,
    label: teammateReferenceFileName(path),
  };
}

export function teammateReferenceFileName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

export function teammateWebReferenceHost(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./iu, "");
  } catch {
    return value;
  }
}

export function teammatePrivateMessageSearchText({
  message,
  attachmentById,
  linkPreviewById,
  runById,
}: {
  readonly message: TeammateDirectMessage;
  readonly attachmentById: ReadonlyMap<string, TeammatePrivateAttachment>;
  readonly linkPreviewById: ReadonlyMap<string, TeammateDirectLinkPreview>;
  readonly runById: ReadonlyMap<string, RunSession>;
}): string {
  const attachmentText = message.attachmentIds
    .map((id) => attachmentById.get(id)?.fileName ?? "")
    .join(" ");
  const fileReferenceText = (message.fileRefs ?? [])
    .flatMap((reference) => [reference.label ?? "", reference.path, reference.line?.toString() ?? ""])
    .join(" ");
  const linkText = (message.linkPreviewIds ?? [])
    .flatMap((id) => {
      const preview = linkPreviewById.get(id);
      return preview
        ? [preview.title ?? "", preview.description ?? "", preview.siteName ?? "", preview.normalizedUrl, preview.url]
        : [];
    })
    .join(" ");
  const run = message.linkedRunId ? runById.get(message.linkedRunId) : undefined;
  const taskTitle = run && isRecord(run.taskSnapshot) && typeof run.taskSnapshot.title === "string"
    ? run.taskSnapshot.title
    : "";
  const runText = run
    ? [taskTitle, run.providerName ?? "", run.providerModel ?? ""].join(" ")
    : "";
  const webEvidenceText = message.webEvidence ? JSON.stringify(message.webEvidence) : "";

  return [message.body, attachmentText, fileReferenceText, linkText, runText, webEvidenceText]
    .join(" ")
    .toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
