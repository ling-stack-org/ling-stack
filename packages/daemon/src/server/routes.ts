export function matchSingleSegmentRoute(pathname: string, prefix: string): string | undefined {
  const routePrefix = `${prefix}/`;
  if (!pathname.startsWith(routePrefix)) {
    return undefined;
  }
  const segment = pathname.slice(routePrefix.length);
  if (!segment || segment.includes("/")) {
    return undefined;
  }
  return decodeURIComponent(segment);
}

export function parseRunRoute(
  pathname: string,
):
  | { kind: "run"; runId: string }
  | { kind: "events"; runId: string }
  | { kind: "artifacts"; runId: string }
  | { kind: "cancel"; runId: string }
  | { kind: "interventions"; runId: string }
  | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "runs") {
    return { kind: "run", runId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "runs" && segments[2] === "events") {
    return { kind: "events", runId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "runs" && segments[2] === "artifacts") {
    return { kind: "artifacts", runId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "runs" && segments[2] === "cancel") {
    return { kind: "cancel", runId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "runs" && segments[2] === "interventions") {
    return { kind: "interventions", runId: segments[1] };
  }
  return undefined;
}

export function parseRunInterventionRoute(
  pathname: string,
): { readonly kind: "detail"; readonly interventionId: string } | { readonly kind: "cancel"; readonly interventionId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "run-interventions") {
    return { kind: "detail", interventionId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "run-interventions" && segments[2] === "cancel") {
    return { kind: "cancel", interventionId: segments[1] };
  }
  return undefined;
}

export function parseLingThreadRoute(
  pathname: string,
):
  | { readonly kind: "detail"; readonly threadId: string }
  | { readonly kind: "evidence"; readonly threadId: string }
  | { readonly kind: "resume"; readonly threadId: string }
  | { readonly kind: "resume-preview"; readonly threadId: string }
  | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "threads") {
    return { kind: "detail", threadId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "threads" && segments[2] === "evidence") {
    return { kind: "evidence", threadId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "threads" && segments[2] === "resume") {
    return { kind: "resume", threadId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "threads" && segments[2] === "resume-preview") {
    return { kind: "resume-preview", threadId: segments[1] };
  }
  return undefined;
}

export type SkillRoute =
  | { readonly kind: "draft"; readonly draftId: string; readonly action?: "publish" }
  | { readonly kind: "skill"; readonly skillId: string };

export function parseSkillRoute(pathname: string): SkillRoute | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 3 && segments[0] === "skills" && segments[1] === "import-drafts") {
    return { kind: "draft", draftId: segments[2] };
  }
  if (segments.length === 4 && segments[0] === "skills" && segments[1] === "import-drafts" && segments[3] === "publish") {
    return { kind: "draft", draftId: segments[2], action: "publish" };
  }
  if (segments.length === 2 && segments[0] === "skills") {
    return { kind: "skill", skillId: segments[1] };
  }
  return undefined;
}

export type WorkUnitRoute =
  | { readonly kind: "detail"; readonly workUnitId: string }
  | { readonly kind: "events"; readonly workUnitId: string }
  | { readonly kind: "cancel"; readonly workUnitId: string }
  | { readonly kind: "retry"; readonly workUnitId: string }
  | { readonly kind: "reconcile"; readonly workUnitId: string };

export function parseWorkUnitRoute(pathname: string): WorkUnitRoute | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "work-units") {
    return { kind: "detail", workUnitId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "work-units") {
    if (segments[2] === "events" || segments[2] === "cancel" || segments[2] === "retry" || segments[2] === "reconcile") {
      return { kind: segments[2], workUnitId: segments[1] };
    }
  }
  return undefined;
}

export function parseArtifactRoute(pathname: string): { kind: "artifact"; artifactId: string } | { kind: "content"; artifactId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "artifacts") {
    return { kind: "artifact", artifactId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "artifacts" && segments[2] === "content") {
    return { kind: "content", artifactId: segments[1] };
  }
  return undefined;
}

export function parseChannelRoute(
  pathname: string,
): {
  readonly channelId: string;
  readonly action?: "brief" | "messages" | "proposals" | "attachments" | "link-previews" | "decisions" | "handoffs" | "context-summaries" | "workflows";
} | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "channels") {
    return { channelId: segments[1] };
  }
  if (
    segments.length === 3 &&
    segments[0] === "channels" &&
    (
      segments[2] === "brief" ||
      segments[2] === "messages" ||
      segments[2] === "proposals" ||
      segments[2] === "attachments" ||
      segments[2] === "link-previews" ||
      segments[2] === "decisions" ||
      segments[2] === "handoffs" ||
      segments[2] === "context-summaries" ||
      segments[2] === "workflows"
    )
  ) {
    return { channelId: segments[1], action: segments[2] };
  }
  return undefined;
}

export function parseChannelExecutionProposalRoute(pathname: string): { readonly proposalId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "channel-proposals") {
    return { proposalId: segments[1] };
  }
  return undefined;
}

export function parseTeammateRoute(
  pathname: string,
): {
  readonly teammateId: string;
  readonly action?: "channels" | "skills" | "memory-scopes" | "mcp" | "persona-draft" | "direct-thread" | "direct-messages" | "direct-messages-stream" | "direct-attachments" | "avatar" | "hard-delete" | "tasks" | "activity";
} | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "teammates") {
    return { teammateId: segments[1] };
  }
  if (
    segments.length === 3 &&
    segments[0] === "teammates" &&
    (
      segments[2] === "channels" ||
      segments[2] === "skills" ||
      segments[2] === "memory-scopes" ||
      segments[2] === "mcp" ||
      segments[2] === "persona-draft" ||
      segments[2] === "direct-thread" ||
      segments[2] === "direct-messages" ||
      segments[2] === "direct-attachments" ||
      segments[2] === "avatar" ||
      segments[2] === "hard-delete" ||
      segments[2] === "tasks" ||
      segments[2] === "activity"
    )
  ) {
    return { teammateId: segments[1], action: segments[2] };
  }
  if (
    segments.length === 4 &&
    segments[0] === "teammates" &&
    segments[2] === "direct-messages" &&
    segments[3] === "stream"
  ) {
    return { teammateId: segments[1], action: "direct-messages-stream" };
  }
  return undefined;
}

export function parseMcpServerRoute(
  pathname: string,
): { readonly serverId: string; readonly action?: "check" | "sync-tools" | "secret" | "status" } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 3 && segments[0] === "mcp" && segments[1] === "servers") {
    return { serverId: segments[2] };
  }
  if (
    segments.length === 4 &&
    segments[0] === "mcp" &&
    segments[1] === "servers" &&
    (segments[3] === "check" || segments[3] === "sync-tools" || segments[3] === "secret" || segments[3] === "status")
  ) {
    return { serverId: segments[2], action: segments[3] };
  }
  return undefined;
}

export function parseChannelAttachmentRoute(
  pathname: string,
): { readonly attachmentId: string; readonly action?: "content" } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "attachments") {
    return { attachmentId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "attachments" && segments[2] === "content") {
    return { attachmentId: segments[1], action: "content" };
  }
  return undefined;
}

export function parseChannelLinkPreviewRoute(
  pathname: string,
): { readonly linkPreviewId: string; readonly action: "refresh" } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 3 && segments[0] === "link-previews" && segments[2] === "refresh") {
    return { linkPreviewId: segments[1], action: "refresh" };
  }
  return undefined;
}

export function parseChannelDecisionRoute(pathname: string): { readonly decisionId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "decisions") {
    return { decisionId: segments[1] };
  }
  return undefined;
}

export function parseChannelHandoffRoute(pathname: string): { readonly handoffId: string; readonly action?: "workflow" } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "handoffs") {
    return { handoffId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "handoffs" && segments[2] === "workflow") {
    return { handoffId: segments[1], action: "workflow" };
  }
  return undefined;
}

export function parseChannelWorkflowRoute(
  pathname: string,
):
  | { readonly kind: "workflow"; readonly workflowId: string; readonly action?: "orchestrate" | "cancel" }
  | { readonly kind: "steps"; readonly workflowId: string }
  | { readonly kind: "workflow-step"; readonly workflowStepId: string; readonly action?: "start" | "retry" }
  | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "workflows") {
    return { kind: "workflow", workflowId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "workflows" && segments[2] === "orchestrate") {
    return { kind: "workflow", workflowId: segments[1], action: "orchestrate" };
  }
  if (segments.length === 3 && segments[0] === "workflows" && segments[2] === "cancel") {
    return { kind: "workflow", workflowId: segments[1], action: "cancel" };
  }
  if (segments.length === 3 && segments[0] === "workflows" && segments[2] === "steps") {
    return { kind: "steps", workflowId: segments[1] };
  }
  if (segments.length === 2 && segments[0] === "workflow-steps") {
    return { kind: "workflow-step", workflowStepId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "workflow-steps" && segments[2] === "start") {
    return { kind: "workflow-step", workflowStepId: segments[1], action: "start" };
  }
  if (segments.length === 3 && segments[0] === "workflow-steps" && segments[2] === "retry") {
    return { kind: "workflow-step", workflowStepId: segments[1], action: "retry" };
  }
  return undefined;
}

export function parseChannelContextSummaryRoute(pathname: string): { readonly contextSummaryId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "context-summaries") {
    return { contextSummaryId: segments[1] };
  }
  return undefined;
}

export function parseTaskRoute(pathname: string): { readonly taskId: string; readonly action?: "run" } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "tasks") {
    return { taskId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "tasks" && segments[2] === "run") {
    return { taskId: segments[1], action: "run" };
  }
  return undefined;
}

export function parseProviderRoute(pathname: string): { readonly providerId: string; readonly action?: "check" | "secret" } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "providers") {
    return { providerId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "providers" && segments[2] === "check") {
    return { providerId: segments[1], action: "check" };
  }
  if (segments.length === 3 && segments[0] === "providers" && segments[2] === "secret") {
    return { providerId: segments[1], action: "secret" };
  }
  return undefined;
}

export function parseMediaJobRoute(pathname: string): { readonly mediaJobId: string; readonly action?: "run" | "artifacts" } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "media-jobs") {
    return { mediaJobId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "media-jobs" && (segments[2] === "run" || segments[2] === "artifacts")) {
    return { mediaJobId: segments[1], action: segments[2] };
  }
  return undefined;
}

export function parseApprovalRoute(pathname: string): { readonly approvalId: string; readonly action?: "approve" | "deny" } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "approvals") {
    return { approvalId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "approvals" && (segments[2] === "approve" || segments[2] === "deny")) {
    return { approvalId: segments[1], action: segments[2] };
  }
  return undefined;
}

export function parseExternalWorkActionRoute(pathname: string): { readonly actionId: string; readonly action?: "cancel" | "execute" } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 3 && segments[0] === "external-work" && segments[1] === "actions") {
    return { actionId: segments[2] };
  }
  if (
    segments.length === 4 &&
    segments[0] === "external-work" &&
    segments[1] === "actions" &&
    (segments[3] === "cancel" || segments[3] === "execute")
  ) {
    return { actionId: segments[2], action: segments[3] };
  }
  return undefined;
}

export function parseExternalWorkCiTriageItemRoute(pathname: string): { readonly triageId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (
    segments.length === 5 &&
    segments[0] === "external-work" &&
    segments[1] === "github" &&
    segments[2] === "ci" &&
    segments[3] === "triage"
  ) {
    return { triageId: segments[4] };
  }
  return undefined;
}

export function parseExternalWorkBackgroundStopRoute(pathname: string): { readonly schedulerId: string } | undefined {
  const prefix = "/external-work/background/";
  if (!pathname.startsWith(prefix) || !pathname.endsWith("/stop")) {
    return undefined;
  }
  const schedulerId = decodeURIComponent(pathname.slice(prefix.length, -"/stop".length));
  return schedulerId ? { schedulerId } : undefined;
}

export function parseExternalWorkCiTriageRunRoute(pathname: string): { readonly triageId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (
    segments.length === 6 &&
    segments[0] === "external-work" &&
    segments[1] === "github" &&
    segments[2] === "ci" &&
    segments[3] === "triage" &&
    segments[5] === "run"
  ) {
    return { triageId: segments[4] };
  }
  return undefined;
}
