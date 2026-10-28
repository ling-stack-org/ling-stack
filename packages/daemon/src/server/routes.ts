import { normalizeRunnerId } from "@ling-stack/core";

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

export function parseRunnerReadinessRoute(pathname: string): { readonly runnerId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 3 && segments[0] === "runners" && segments[2] === "readiness") {
    return { runnerId: normalizeRunnerId(segments[1]) ?? segments[1] };
  }
  return undefined;
}

export function parseMemoryRoute(pathname: string): { readonly kind: "review"; readonly memoryId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 3 && segments[0] === "memory" && segments[2] === "review") {
    return { kind: "review", memoryId: segments[1] };
  }
  return undefined;
}

export function parseRunRoute(
  pathname: string,
):
  | { kind: "run"; runId: string }
  | { kind: "events"; runId: string }
  | { kind: "artifacts"; runId: string }
  | { kind: "shell-snapshots"; runId: string }
  | { kind: "shell-snapshot"; runId: string; snapshotId: string }
  | { kind: "workspace-changes"; runId: string }
  | { kind: "workspace-changes-undo"; runId: string }
  | { kind: "workspace-changes-reapply"; runId: string }
  | { kind: "cancel"; runId: string }
  | { kind: "interventions"; runId: string }
  | { kind: "tool-load-requests"; runId: string }
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
  if (segments.length === 3 && segments[0] === "runs" && segments[2] === "shell-snapshots") {
    return { kind: "shell-snapshots", runId: segments[1] };
  }
  if (segments.length === 4 && segments[0] === "runs" && segments[2] === "shell-snapshots") {
    return { kind: "shell-snapshot", runId: segments[1], snapshotId: segments[3] };
  }
  if (segments.length === 3 && segments[0] === "runs" && segments[2] === "workspace-changes") {
    return { kind: "workspace-changes", runId: segments[1] };
  }
  if (segments.length === 4 && segments[0] === "runs" && segments[2] === "workspace-changes" && segments[3] === "undo") {
    return { kind: "workspace-changes-undo", runId: segments[1] };
  }
  if (segments.length === 4 && segments[0] === "runs" && segments[2] === "workspace-changes" && segments[3] === "reapply") {
    return { kind: "workspace-changes-reapply", runId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "runs" && segments[2] === "cancel") {
    return { kind: "cancel", runId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "runs" && segments[2] === "interventions") {
    return { kind: "interventions", runId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "runs" && segments[2] === "tool-load-requests") {
    return { kind: "tool-load-requests", runId: segments[1] };
  }
  return undefined;
}

export function parseUserInputAnswerSubmissionRoute(
  pathname: string,
): { readonly threadId: string; readonly requestId: string } | undefined {
  const segments = decodeRouteSegments(pathname);
  if (!segments || segments.length !== 5 || segments[0] !== "threads"
    || segments[2] !== "user-input-requests" || segments[4] !== "answers") return undefined;
  return { threadId: segments[1], requestId: segments[3] };
}

export function parseTurnRoute(
  pathname: string,
):
  | { readonly kind: "workspace-changes"; readonly turnId: string }
  | { readonly kind: "workspace-changes-undo"; readonly turnId: string }
  | { readonly kind: "workspace-changes-reapply"; readonly turnId: string }
  | undefined {
  const segments = decodeRouteSegments(pathname);
  if (!segments) return undefined;
  if (segments.length === 3 && segments[0] === "turns" && segments[2] === "workspace-changes") {
    return { kind: "workspace-changes", turnId: segments[1] };
  }
  if (segments.length === 4 && segments[0] === "turns" && segments[2] === "workspace-changes" && segments[3] === "undo") {
    return { kind: "workspace-changes-undo", turnId: segments[1] };
  }
  if (segments.length === 4 && segments[0] === "turns" && segments[2] === "workspace-changes" && segments[3] === "reapply") {
    return { kind: "workspace-changes-reapply", turnId: segments[1] };
  }
  return undefined;
}

function decodeRouteSegments(pathname: string): string[] | undefined {
  try {
    return pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return undefined;
  }
}

export function parseRunInterventionRoute(
  pathname: string,
):
  | { readonly kind: "detail"; readonly interventionId: string }
  | { readonly kind: "cancel"; readonly interventionId: string }
  | { readonly kind: "promote"; readonly interventionId: string }
  | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "run-interventions") {
    return { kind: "detail", interventionId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "run-interventions" && segments[2] === "cancel") {
    return { kind: "cancel", interventionId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "run-interventions" && segments[2] === "promote") {
    return { kind: "promote", interventionId: segments[1] };
  }
  return undefined;
}

export function parseTraceRoute(pathname: string): { readonly kind: "detail"; readonly traceId: string } | { readonly kind: "spans"; readonly traceId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "traces") {
    return { kind: "detail", traceId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "traces" && segments[2] === "spans") {
    return { kind: "spans", traceId: segments[1] };
  }
  return undefined;
}

export function parseTeammateDirectInterventionRoute(
  pathname: string,
): { readonly kind: "cancel" | "promote"; readonly interventionId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 3 && segments[0] === "teammate-direct-interventions" && segments[2] === "cancel") {
    return { kind: "cancel", interventionId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "teammate-direct-interventions" && segments[2] === "promote") {
    return { kind: "promote", interventionId: segments[1] };
  }
  return undefined;
}

export function parseTeammateDirectReplyRoute(
  pathname: string,
): { readonly kind: "cancel"; readonly workUnitId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 3 && segments[0] === "teammate-direct-replies" && segments[2] === "cancel") {
    return { kind: "cancel", workUnitId: segments[1] };
  }
  return undefined;
}

export function parseLingThreadRoute(
  pathname: string,
):
  | { readonly kind: "detail"; readonly threadId: string }
  | { readonly kind: "turns"; readonly threadId: string }
  | { readonly kind: "evidence"; readonly threadId: string }
  | { readonly kind: "mode"; readonly threadId: string }
  | { readonly kind: "goal"; readonly threadId: string }
  | { readonly kind: "goal-complete"; readonly threadId: string }
  | {
      readonly kind: "proposed-plans";
      readonly threadId: string;
      readonly planId?: string;
      readonly action?: "accept" | "refine" | "save" | "convert-workflow" | "archive";
    }
  | { readonly kind: "resume"; readonly threadId: string }
  | { readonly kind: "resume-preview"; readonly threadId: string }
  | { readonly kind: "fork"; readonly threadId: string }
  | { readonly kind: "fork-run"; readonly threadId: string }
  | { readonly kind: "archive"; readonly threadId: string }
  | { readonly kind: "unarchive"; readonly threadId: string }
  | { readonly kind: "hard-delete"; readonly threadId: string }
  | { readonly kind: "pin"; readonly threadId: string }
  | { readonly kind: "unpin"; readonly threadId: string }
  | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "threads") {
    return { kind: "detail", threadId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "threads" && segments[2] === "evidence") {
    return { kind: "evidence", threadId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "threads" && segments[2] === "mode") {
    return { kind: "mode", threadId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "threads" && segments[2] === "goal") {
    return { kind: "goal", threadId: segments[1] };
  }
  if (segments.length === 4 && segments[0] === "threads" && segments[2] === "goal" && segments[3] === "complete") {
    return { kind: "goal-complete", threadId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "threads" && segments[2] === "proposed-plans") {
    return { kind: "proposed-plans", threadId: segments[1] };
  }
  if (segments.length === 4 && segments[0] === "threads" && segments[2] === "proposed-plans") {
    return { kind: "proposed-plans", threadId: segments[1], planId: segments[3] };
  }
  if (
    segments.length === 5 &&
    segments[0] === "threads" &&
    segments[2] === "proposed-plans" &&
    (
      segments[4] === "accept" ||
      segments[4] === "refine" ||
      segments[4] === "save" ||
      segments[4] === "convert-workflow" ||
      segments[4] === "archive"
    )
  ) {
    return { kind: "proposed-plans", threadId: segments[1], planId: segments[3], action: segments[4] };
  }
  if (segments.length === 3 && segments[0] === "threads" && segments[2] === "turns") {
    return { kind: "turns", threadId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "threads" && segments[2] === "resume") {
    return { kind: "resume", threadId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "threads" && segments[2] === "resume-preview") {
    return { kind: "resume-preview", threadId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "threads" && segments[2] === "fork") {
    return { kind: "fork", threadId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "threads" && segments[2] === "fork-run") {
    return { kind: "fork-run", threadId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "threads" && segments[2] === "archive") {
    return { kind: "archive", threadId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "threads" && segments[2] === "unarchive") {
    return { kind: "unarchive", threadId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "threads" && segments[2] === "hard-delete") {
    return { kind: "hard-delete", threadId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "threads" && segments[2] === "pin") {
    return { kind: "pin", threadId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "threads" && segments[2] === "unpin") {
    return { kind: "unpin", threadId: segments[1] };
  }
  return undefined;
}

export type SkillRoute =
  | { readonly kind: "draft"; readonly draftId: string; readonly action?: "publish" }
  | { readonly kind: "skill"; readonly skillId: string; readonly action?: "corrections" | "hard-delete" | "source" | "source-archive" | "source-rollback" | "source-artifacts" | "optimization-preview" | "compiled-views" | "compiled-view-archive" | "revision-preview" | "revisions"; readonly viewId?: string }
  | { readonly kind: "candidate"; readonly candidateId: string; readonly action?: "review" | "draft" };

export function parseSkillRoute(pathname: string): SkillRoute | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "skill-candidates" && segments[1] !== "observe") {
    return { kind: "candidate", candidateId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "skill-candidates" && segments[2] === "review") {
    return { kind: "candidate", candidateId: segments[1], action: "review" };
  }
  if (segments.length === 3 && segments[0] === "skill-candidates" && segments[2] === "draft") {
    return { kind: "candidate", candidateId: segments[1], action: "draft" };
  }
  if (segments.length === 3 && segments[0] === "skills" && segments[1] === "import-drafts") {
    return { kind: "draft", draftId: segments[2] };
  }
  if (segments.length === 4 && segments[0] === "skills" && segments[1] === "import-drafts" && segments[3] === "publish") {
    return { kind: "draft", draftId: segments[2], action: "publish" };
  }
  if (segments.length === 3 && segments[0] === "skills" && segments[2] === "corrections") {
    return { kind: "skill", skillId: segments[1], action: "corrections" };
  }
  if (segments.length === 3 && segments[0] === "skills" && segments[2] === "hard-delete") {
    return { kind: "skill", skillId: segments[1], action: "hard-delete" };
  }
  if (segments.length === 3 && segments[0] === "skills" && segments[2] === "source") {
    return { kind: "skill", skillId: segments[1], action: "source" };
  }
  if (segments.length === 4 && segments[0] === "skills" && segments[2] === "source" && segments[3] === "archive") {
    return { kind: "skill", skillId: segments[1], action: "source-archive" };
  }
  if (segments.length === 4 && segments[0] === "skills" && segments[2] === "source" && segments[3] === "rollback") {
    return { kind: "skill", skillId: segments[1], action: "source-rollback" };
  }
  if (segments.length === 4 && segments[0] === "skills" && segments[2] === "source" && segments[3] === "artifacts") {
    return { kind: "skill", skillId: segments[1], action: "source-artifacts" };
  }
  if (segments.length === 3 && segments[0] === "skills" && segments[2] === "optimization-preview") {
    return { kind: "skill", skillId: segments[1], action: "optimization-preview" };
  }
  if (segments.length === 3 && segments[0] === "skills" && segments[2] === "revision-preview") {
    return { kind: "skill", skillId: segments[1], action: "revision-preview" };
  }
  if (segments.length === 3 && segments[0] === "skills" && segments[2] === "revisions") {
    return { kind: "skill", skillId: segments[1], action: "revisions" };
  }
  if (segments.length === 3 && segments[0] === "skills" && segments[2] === "compiled-views") {
    return { kind: "skill", skillId: segments[1], action: "compiled-views" };
  }
  if (segments.length === 5 && segments[0] === "skills" && segments[2] === "compiled-views" && segments[4] === "archive") {
    return { kind: "skill", skillId: segments[1], action: "compiled-view-archive", viewId: segments[3] };
  }
  if (segments.length === 2 && segments[0] === "skills") {
    return { kind: "skill", skillId: segments[1] };
  }
  return undefined;
}

export type WorkUnitRoute =
  | { readonly kind: "detail"; readonly workUnitId: string }
  | { readonly kind: "events"; readonly workUnitId: string }
  | { readonly kind: "harness"; readonly workUnitId: string }
  | { readonly kind: "cancel"; readonly workUnitId: string }
  | { readonly kind: "retry"; readonly workUnitId: string }
  | { readonly kind: "reconcile"; readonly workUnitId: string };

export type WorkItemRoute =
  | { readonly workItemId: string }
  | { readonly workItemId: string; readonly action: "route" | "claim" | "heartbeat" | "release" | "complete" | "fail" };

export function parseWorkUnitRoute(pathname: string): WorkUnitRoute | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "work-units") {
    return { kind: "detail", workUnitId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "work-units") {
    if (segments[2] === "events" || segments[2] === "harness" || segments[2] === "cancel" || segments[2] === "retry" || segments[2] === "reconcile") {
      return { kind: segments[2], workUnitId: segments[1] };
    }
  }
  return undefined;
}

export function parseWorkItemRoute(pathname: string): WorkItemRoute | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "work-items") {
    return { workItemId: segments[1] };
  }
  if (
    segments.length === 3 &&
    segments[0] === "work-items" &&
    (
      segments[2] === "route" ||
      segments[2] === "claim" ||
      segments[2] === "heartbeat" ||
      segments[2] === "release" ||
      segments[2] === "complete" ||
      segments[2] === "fail"
    )
  ) {
    return { workItemId: segments[1], action: segments[2] };
  }
  return undefined;
}

export function parseArtifactRoute(pathname: string): { kind: "artifact"; artifactId: string } | { kind: "content"; artifactId: string } | { kind: "preview"; artifactId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "artifacts") {
    return { kind: "artifact", artifactId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "artifacts" && segments[2] === "content") {
    return { kind: "content", artifactId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "artifacts" && segments[2] === "preview") {
    return { kind: "preview", artifactId: segments[1] };
  }
  return undefined;
}

export function parseChannelRoute(
  pathname: string,
): {
  readonly channelId: string;
  readonly action?: "brief" | "items" | "turns" | "turns-stream" | "turn-context" | "turn-context-correction" | "message-route-decisions" | "intent-decisions" | "proposals" | "attachments" | "link-previews" | "decisions" | "handoffs" | "context-summaries" | "workflows" | "collaboration-cards" | "terminal-reports" | "team-experts" | "team-metrics" | "team-authority-ledger" | "team-patterns" | "team-snapshots" | "team-evaluations" | "workspace" | "protocol" | "playbooks" | "branches" | "council-policy" | "effective-council" | "proposed-plans";
  readonly branchId?: string;
  readonly turnId?: string;
  readonly protocolAction?: "revert" | "drafts" | "apply-draft" | "candidates" | "review-candidate" | "candidate-from-cluster" | "canvas";
  readonly protocolDraftId?: string;
  readonly protocolClusterId?: string;
  readonly playbookAction?: "candidates" | "candidate-from-cluster" | "review-candidate";
  readonly playbookCandidateId?: string;
  readonly playbookClusterId?: string;
  readonly workspaceAction?: "create-worktree" | "handoff" | "refresh" | "cleanup" | "git-status" | "open";
} | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "channels") {
    return { channelId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "channels" && segments[2] === "workspace") {
    return { channelId: segments[1], action: "workspace" };
  }
  if (segments.length === 3 && segments[0] === "channels" && segments[2] === "protocol") {
    return { channelId: segments[1], action: "protocol" };
  }
  if (segments.length === 3 && segments[0] === "channels" && segments[2] === "branches") {
    return { channelId: segments[1], action: "branches" };
  }
  if (segments.length === 3 && segments[0] === "channels" && segments[2] === "proposed-plans") {
    return { channelId: segments[1], action: "proposed-plans" };
  }
  if (segments.length === 3 && segments[0] === "channels" && segments[2] === "terminal-reports") {
    return { channelId: segments[1], action: "terminal-reports" };
  }
  if (segments.length === 4 && segments[0] === "channels" && segments[2] === "turns" && segments[3] === "stream") {
    return { channelId: segments[1], action: "turns-stream" };
  }
  if (segments.length === 5 && segments[0] === "channels" && segments[2] === "turns" && segments[4] === "context") {
    return { channelId: segments[1], action: "turn-context", turnId: segments[3] };
  }
  if (segments.length === 6 && segments[0] === "channels" && segments[2] === "turns" && segments[4] === "context" && segments[5] === "corrections") {
    return { channelId: segments[1], action: "turn-context-correction", turnId: segments[3] };
  }
  if (segments.length === 4 && segments[0] === "channels" && segments[2] === "branches") {
    return { channelId: segments[1], action: "branches", branchId: segments[3] };
  }
  if (segments.length === 4 && segments[0] === "channels" && segments[2] === "protocol" && segments[3] === "revert") {
    return { channelId: segments[1], action: "protocol", protocolAction: "revert" };
  }
  if (segments.length === 4 && segments[0] === "channels" && segments[2] === "protocol" && segments[3] === "drafts") {
    return { channelId: segments[1], action: "protocol", protocolAction: "drafts" };
  }
  if (segments.length === 4 && segments[0] === "channels" && segments[2] === "protocol" && segments[3] === "canvas") {
    return { channelId: segments[1], action: "protocol", protocolAction: "canvas" };
  }
  if (segments.length === 6 && segments[0] === "channels" && segments[2] === "protocol" && segments[3] === "drafts" && segments[5] === "apply") {
    return { channelId: segments[1], action: "protocol", protocolAction: "apply-draft", protocolDraftId: segments[4] };
  }
  if (segments.length === 3 && segments[0] === "channels" && segments[2] === "protocol-candidates") {
    return { channelId: segments[1], action: "protocol", protocolAction: "candidates" };
  }
  if (segments.length === 5 && segments[0] === "channels" && segments[2] === "protocol-candidates" && segments[3] === "from-cluster") {
    return { channelId: segments[1], action: "protocol", protocolAction: "candidate-from-cluster", protocolClusterId: segments[4] };
  }
  if (segments.length === 5 && segments[0] === "channels" && segments[2] === "protocol-candidates" && segments[4] === "review") {
    return { channelId: segments[1], action: "protocol", protocolAction: "review-candidate", protocolDraftId: segments[3] };
  }
  if (segments.length === 3 && segments[0] === "channels" && segments[2] === "playbook-candidates") {
    return { channelId: segments[1], action: "playbooks", playbookAction: "candidates" };
  }
  if (segments.length === 5 && segments[0] === "channels" && segments[2] === "playbook-candidates" && segments[3] === "from-cluster") {
    return { channelId: segments[1], action: "playbooks", playbookAction: "candidate-from-cluster", playbookClusterId: segments[4] };
  }
  if (segments.length === 5 && segments[0] === "channels" && segments[2] === "playbook-candidates" && segments[4] === "review") {
    return { channelId: segments[1], action: "playbooks", playbookAction: "review-candidate", playbookCandidateId: segments[3] };
  }
  if (
    segments.length === 4 &&
    segments[0] === "channels" &&
    segments[2] === "workspace" &&
    (segments[3] === "create-worktree" || segments[3] === "handoff" || segments[3] === "refresh" || segments[3] === "cleanup" || segments[3] === "git-status" || segments[3] === "open")
  ) {
    return { channelId: segments[1], action: "workspace", workspaceAction: segments[3] };
  }
  if (
    segments.length === 3 &&
    segments[0] === "channels" &&
    (
      segments[2] === "brief" ||
      segments[2] === "items" ||
      segments[2] === "turns" ||
      segments[2] === "message-route-decisions" ||
      segments[2] === "intent-decisions" ||
      segments[2] === "proposals" ||
      segments[2] === "attachments" ||
      segments[2] === "link-previews" ||
      segments[2] === "decisions" ||
      segments[2] === "handoffs" ||
      segments[2] === "context-summaries" ||
      segments[2] === "workflows" ||
      segments[2] === "collaboration-cards" ||
      segments[2] === "team-experts" ||
      segments[2] === "team-metrics" ||
      segments[2] === "team-authority-ledger" ||
      segments[2] === "team-patterns" ||
      segments[2] === "team-snapshots" ||
      segments[2] === "team-evaluations" ||
      segments[2] === "council-policy" ||
      segments[2] === "effective-council" ||
      segments[2] === "protocol"
    )
  ) {
    return { channelId: segments[1], action: segments[2] };
  }
  return undefined;
}

export function parseAiCouncilRoute(
  pathname: string,
): { readonly councilId: string; readonly action?: "members" | "clone" } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "ai-councils") {
    return { councilId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "ai-councils" && segments[2] === "members") {
    return { councilId: segments[1], action: "members" };
  }
  if (segments.length === 3 && segments[0] === "ai-councils" && segments[2] === "clone") {
    return { councilId: segments[1], action: "clone" };
  }
  return undefined;
}

export function parseChannelExecutionProposalRoute(pathname: string): { readonly proposalId: string; readonly action?: "confirm-workflow" } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "channel-proposals") {
    return { proposalId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "channel-proposals" && segments[2] === "confirm-workflow") {
    return { proposalId: segments[1], action: "confirm-workflow" };
  }
  return undefined;
}

export function parseTeammateRoute(
  pathname: string,
): {
  readonly teammateId: string;
  readonly action?: "channels" | "skills" | "memory-scopes" | "mcp" | "persona-draft" | "direct-thread" | "direct-messages" | "direct-messages-stream" | "direct-runtime" | "direct-interventions" | "direct-workspace" | "direct-link-previews" | "direct-attachments" | "avatar" | "hard-delete" | "tasks" | "activity";
  readonly workspaceAction?: "create-worktree" | "handoff" | "refresh" | "cleanup";
} | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "teammates") {
    return { teammateId: segments[1] };
  }
  if (
    segments.length === 4 &&
    segments[0] === "teammates" &&
    segments[2] === "direct-workspace" &&
    (segments[3] === "create-worktree" || segments[3] === "handoff" || segments[3] === "refresh" || segments[3] === "cleanup")
  ) {
    return { teammateId: segments[1], action: "direct-workspace", workspaceAction: segments[3] };
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
      segments[2] === "direct-runtime" ||
      segments[2] === "direct-interventions" ||
      segments[2] === "direct-workspace" ||
      segments[2] === "direct-link-previews" ||
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

export function parseManagedPluginRoute(
  pathname: string,
): {
  readonly pluginId: string;
  readonly action?: "enable" | "disable" | "check" | "connect" | "pairing" | "revoke" | "repair-browser-host" | "apply-preset" | "validate-package" | "install" | "uninstall" | "refresh-package" | "runtime-preview";
} | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "plugins") {
    return { pluginId: segments[1] };
  }
  if (
    segments.length === 3 &&
    segments[0] === "plugins" &&
    (
      segments[2] === "enable" ||
      segments[2] === "disable" ||
      segments[2] === "check" ||
      segments[2] === "connect" ||
      segments[2] === "pairing" ||
      segments[2] === "revoke" ||
      segments[2] === "repair-browser-host" ||
      segments[2] === "apply-preset" ||
      segments[2] === "validate-package" ||
      segments[2] === "install" ||
      segments[2] === "uninstall" ||
      segments[2] === "refresh-package" ||
      segments[2] === "runtime-preview"
    )
  ) {
    return { pluginId: segments[1], action: segments[2] };
  }
  return undefined;
}

export function parsePluginPackageRoute(pathname: string): { readonly pluginId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 3 && segments[0] === "plugins" && segments[1] === "packages") {
    return { pluginId: segments[2] };
  }
  return undefined;
}

export function parseChannelAttachmentRoute(
  pathname: string,
): { readonly attachmentId: string; readonly action?: "content" | "preview" } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "attachments") {
    return { attachmentId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "attachments" && segments[2] === "content") {
    return { attachmentId: segments[1], action: "content" };
  }
  if (segments.length === 3 && segments[0] === "attachments" && segments[2] === "preview") {
    return { attachmentId: segments[1], action: "preview" };
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

export function parseTerminalReportRoute(pathname: string): { readonly reportId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "terminal-reports") {
    return { reportId: segments[1] };
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
  | { readonly kind: "workflow"; readonly workflowId: string; readonly action?: "orchestrate" | "cancel" | "evidence" | "collaboration-card" | "workspace-changes" | "workspace-changes-undo" | "workspace-changes-reapply" }
  | { readonly kind: "steps"; readonly workflowId: string }
  | { readonly kind: "workflow-step"; readonly workflowStepId: string; readonly action?: "start" | "retry" | "evidence" }
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
  if (segments.length === 3 && segments[0] === "workflows" && segments[2] === "evidence") {
    return { kind: "workflow", workflowId: segments[1], action: "evidence" };
  }
  if (segments.length === 3 && segments[0] === "workflows" && segments[2] === "collaboration-card") {
    return { kind: "workflow", workflowId: segments[1], action: "collaboration-card" };
  }
  if (segments.length === 3 && segments[0] === "workflows" && segments[2] === "workspace-changes") {
    return { kind: "workflow", workflowId: segments[1], action: "workspace-changes" };
  }
  if (segments.length === 4 && segments[0] === "workflows" && segments[2] === "workspace-changes" && segments[3] === "undo") {
    return { kind: "workflow", workflowId: segments[1], action: "workspace-changes-undo" };
  }
  if (segments.length === 4 && segments[0] === "workflows" && segments[2] === "workspace-changes" && segments[3] === "reapply") {
    return { kind: "workflow", workflowId: segments[1], action: "workspace-changes-reapply" };
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
  if (segments.length === 3 && segments[0] === "workflow-steps" && segments[2] === "evidence") {
    return { kind: "workflow-step", workflowStepId: segments[1], action: "evidence" };
  }
  return undefined;
}

export function parseWorkflowHandoffIntentRoute(
  pathname: string,
):
  | { readonly kind: "collection" }
  | { readonly kind: "item"; readonly intentId: string; readonly action?: "accept" }
  | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 1 && segments[0] === "workflow-handoff-intents") {
    return { kind: "collection" };
  }
  if (segments.length === 2 && segments[0] === "workflow-handoff-intents") {
    return { kind: "item", intentId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "workflow-handoff-intents" && segments[2] === "accept") {
    return { kind: "item", intentId: segments[1], action: "accept" };
  }
  return undefined;
}

export function parseWorkflowSelectorDecisionRoute(
  pathname: string,
):
  | { readonly kind: "collection" }
  | { readonly kind: "item"; readonly decisionId: string }
  | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 1 && segments[0] === "workflow-selector-decisions") {
    return { kind: "collection" };
  }
  if (segments.length === 2 && segments[0] === "workflow-selector-decisions") {
    return { kind: "item", decisionId: segments[1] };
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

export function parseProviderRoute(pathname: string): {
  readonly providerId: string;
  readonly action?: "check" | "secret" | "configure-keychain-secret" | "delete-keychain-secret";
} | undefined {
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
  if (segments.length === 4 && segments[0] === "providers" && segments[2] === "secrets" && segments[3] === "configure") {
    return { providerId: segments[1], action: "configure-keychain-secret" };
  }
  if (segments.length === 4 && segments[0] === "providers" && segments[2] === "secrets" && segments[3] === "keychain") {
    return { providerId: segments[1], action: "delete-keychain-secret" };
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

export function parseApprovalCommandRuleRoute(pathname: string): { readonly ruleId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "approval-command-rules") {
    return { ruleId: segments[1] };
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

export function parseExternalWorkRoute(pathname: string): { readonly externalWorkId: string; readonly action?: "route" } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "external-work") {
    return { externalWorkId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "external-work" && segments[2] === "route") {
    return { externalWorkId: segments[1], action: "route" };
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
