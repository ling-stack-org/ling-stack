import type { Translate } from "../../i18n.js";
import type { RunSession, TeammateDirectMessage, TeammatePrivateAttachment } from "../../types.js";
import {
  mergeDockFileItems,
  mergeEvidenceGroups,
  projectAttachmentsToFileItems,
  projectFileRefsToFileItems,
  projectFilesToEvidenceGroup,
  projectFilesToReviewItems,
  projectMessagesToReviewItems,
  projectRunsToEvidenceGroup,
  projectRunsToReviewItems,
  projectWebEvidenceToEvidenceGroup,
  type RightDockMessageProjectionInput,
  type WorkspaceRightDockProps,
} from "../workspace/right-dock/index.js";

export interface TeammatePrivateDockContent {
  readonly reviewItems: WorkspaceRightDockProps["reviewItems"];
  readonly evidenceGroups: WorkspaceRightDockProps["evidenceGroups"];
  readonly fileItems: WorkspaceRightDockProps["fileItems"];
}

export function buildTeammatePrivateDockContent({
  messages,
  attachments,
  runs,
  teammateDisplayName,
  t,
}: {
  readonly messages: readonly TeammateDirectMessage[];
  readonly attachments: readonly TeammatePrivateAttachment[];
  readonly runs: readonly RunSession[];
  readonly teammateDisplayName: string;
  readonly t: Translate;
}): TeammatePrivateDockContent {
  const dockMessages: readonly RightDockMessageProjectionInput[] = messages.map((message) => ({
    id: message.id,
    title: message.authorType === "ai-teammate" ? teammateDisplayName : message.authorType === "local-user" ? t("User message") : t("System message"),
    body: message.body,
    status: message.status,
    errorMessage: message.errorMessage,
    runId: message.linkedRunId,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    webEvidence: message.webEvidence,
    fileRefs: message.fileRefs ?? [],
  }));
  const fileItems = mergeDockFileItems(
    projectAttachmentsToFileItems(attachments, t),
    projectFileRefsToFileItems(messages.flatMap((message) => message.fileRefs ?? [])),
  );
  const evidenceGroups = mergeEvidenceGroups(
    projectRunsToEvidenceGroup(runs, t),
    projectWebEvidenceToEvidenceGroup(dockMessages, t),
    projectFilesToEvidenceGroup(fileItems, t),
  );
  const reviewItems = [
    ...projectRunsToReviewItems(runs, t),
    ...projectMessagesToReviewItems(dockMessages, t),
    ...projectFilesToReviewItems(fileItems, t),
  ];

  return {
    reviewItems,
    evidenceGroups,
    fileItems,
  };
}
