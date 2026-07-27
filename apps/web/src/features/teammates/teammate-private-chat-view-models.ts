import { artifactContentUrl } from "../../api.js";
import type { Translate } from "../../i18n.js";
import {
  buildConversationWorkCellViewModel,
  type ConversationWorkCellViewModel,
} from "../../lib/conversation-work-cell.js";
import type { LocalFileReference } from "../../shared/conversation/index.js";
import type {
  ExecutionAction,
  RunSession,
  TeammateDirectLinkPreview,
  TeammateDirectMessage,
  TeammatePrivateAttachment,
  TerminalReportDto,
} from "../../types.js";
import type { WorkspaceRightDockFileTarget } from "../workspace/right-dock/index.js";
import { isHistoricalProviderPreflightMessage } from "./teammate-workspace-utils.js";

export interface TeammatePrivateMessageProjection {
  readonly authorName: string;
  readonly blocked: boolean;
  readonly body: string;
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
  const errorOwnsBody = Boolean(
    message.errorMessage?.trim() &&
    message.errorMessage.trim() === message.body.trim() &&
    (message.status === "blocked" || message.status === "failed"),
  );
  const authorName = message.authorType === "ai-teammate"
    ? teammateDisplayName
    : message.authorType === "system"
      ? t("System")
      : localUserDisplayName;
  const body = hasStructuredTerminalReport || errorOwnsBody
    ? ""
    : pendingAiReply && !message.body.trim()
      ? t("AI teammate is replying...")
      : message.status === "cancelled" && !message.body.trim()
        ? t("Reply stopped")
        : recoveredHistoricalProviderFailure
          ? t("Historical model check failed. The model is available now; resend or continue the chat.")
          : message.body;

  return {
    authorName,
    blocked,
    body,
    pendingAiReply,
    recoveredHistoricalProviderFailure,
  };
}

export function buildTeammatePrivateWorkCellMap(input: {
  readonly messages: readonly TeammateDirectMessage[];
  readonly teammateId: string;
  readonly runs: readonly RunSession[];
  readonly executionActions: readonly ExecutionAction[];
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
    const model = buildConversationWorkCellViewModel({
      threadId: run.threadId,
      runs: [run],
      allowRunThreadFallback: true,
      approvals: [],
      artifactsByRun: {},
      executionActions: input.executionActions.filter((action) => action.runId === run.id),
      t: input.t,
      artifactHref: (artifact) => artifactContentUrl(artifact.id, run.cwd),
      terminalReport: input.terminalReports.find((report) =>
        (report.source.kind === "run" && report.source.id === run.id) ||
        (Boolean(report.threadId) && report.threadId === run.threadId)
      ),
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
