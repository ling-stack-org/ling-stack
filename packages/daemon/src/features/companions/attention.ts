import type {
  CompanionAttentionActor,
  CompanionAttentionItem,
  CompanionAttentionProjection,
  CompanionAttentionSource,
} from "@ling-stack/contracts";
import { orderCompanionAttentionItems } from "@ling-stack/contracts";
import type { RunStore, WorkUnit } from "@ling-stack/core";
import { projectTerminalReportDto } from "../channels/terminal-report-routes.js";
import { terminalReportIsEligibleForDisplay } from "../channels/terminal-report-eligibility.js";
import { expireStalePendingApprovals } from "../runs/approvals.js";

const DEFAULT_LIMIT = 120;
const THREAD_PAGE_LIMIT = 100;

export function buildCompanionAttentionProjection(input: {
  readonly store: RunStore;
  readonly cwd: string;
  readonly limit?: number;
  readonly now?: string;
}): CompanionAttentionProjection {
  const now = input.now ?? new Date().toISOString();
  const items: CompanionAttentionItem[] = [];
  const channels = input.store.listChannels({ archived: false, limit: 500 });
  const workspaceId = channels[0]?.workspaceId ?? input.store.listWorkspaceIds()[0] ?? "workspace";
  const channelNames = new Map(channels.map((channel) => [channel.id, channel.name]));
  const teammates = new Map(input.store.listAiTeammates({ includeHidden: true, includeDisabled: true, limit: 500 })
    .map((teammate) => [teammate.id, teammate.displayName]));

  for (const channel of channels) {
    collectUserInputItems(input.store, input.cwd, workspaceId, channel.id, channelNames, teammates, items);
    for (const handoff of input.store.listChannelHandoffs({ channelId: channel.id, limit: 100 })) {
      if (handoff.status !== "proposed" && handoff.status !== "accepted") continue;
      const source = sourceFor(input.cwd, "handoff", handoff.id, channel.id, {
        workspaceId,
        revision: revisionFromTimestamp(handoff.updatedAt),
      });
      items.push({
        schemaVersion: 1,
        id: `handoff:${handoff.id}`,
        priority: "handoff",
        status: handoff.status === "accepted" ? "active" : "pending",
        source,
        actor: actorFor(handoff.toParticipantId, handoff.toParticipantLabel, teammates),
        title: `Handoff to ${handoff.toParticipantLabel}`,
        summary: truncate(handoff.expectedOutput || handoff.reason || "Work has been handed to another teammate.", 180),
        revision: source.revision ?? 1,
        createdAt: handoff.createdAt,
        updatedAt: handoff.updatedAt,
        payload: {
          kind: "handoff",
          handoffId: handoff.id,
          fromParticipant: handoff.fromParticipantLabel,
          toParticipant: handoff.toParticipantLabel,
          requestedOutput: handoff.expectedOutput,
        },
        action: { kind: "open_source", enabled: true, source },
      });
    }
  }

  expireStalePendingApprovals(input.store, { cwd: input.cwd, now });
  const pendingApprovals = input.store.listApprovalRequests({ status: "pending", limit: 500 });
  const approvalRunIds = new Set<string>();
  for (const approval of pendingApprovals) {
    const step = approval.workflowStepId ? input.store.getChannelWorkflowStep(approval.workflowStepId) : undefined;
    const run = approval.runId ? input.store.getRun(approval.runId) : undefined;
    if (run?.id) approvalRunIds.add(run.id);
    const channelId = step?.channelId ?? run?.channelId;
    const teammateId = step?.toParticipantId ?? run?.teammateId;
    const actor = actorFor(teammateId, step?.toParticipantLabel ?? teammates.get(teammateId ?? "") ?? "Ling", teammates);
    const source = sourceFor(input.cwd, "approval", approval.id, channelId, {
      workspaceId,
      runId: approval.runId,
      workflowStepId: approval.workflowStepId,
      approvalId: approval.id,
      revision: revisionFromTimestamp(approval.createdAt),
    });
    items.push({
      schemaVersion: 1,
      id: `approval:${approval.id}`,
      priority: "approval",
      status: "pending",
      source,
      actor,
      title: approval.title,
      summary: truncate(approval.description || "Approval is required before work can continue.", 180),
      revision: source.revision ?? 1,
      createdAt: approval.createdAt,
      updatedAt: approval.createdAt,
      payload: {
        kind: "approval",
        approvalId: approval.id,
        status: approval.status,
        risk: approval.risk,
        ...(approval.expiresAt ? { expiresAt: approval.expiresAt } : {}),
      },
      action: { kind: "approve", enabled: true, source },
    });
  }

  for (const channel of channels) {
    for (const workflow of input.store.listChannelWorkflows({ channelId: channel.id, limit: 100 })) {
      for (const step of input.store.listChannelWorkflowSteps({ workflowId: workflow.id, limit: 200 })) {
        if (!["blocked", "waiting_for_input", "waiting_for_approval", "running", "claimed", "queued"].includes(step.status)) continue;
        if (step.status === "waiting_for_approval" && step.runId && approvalRunIds.has(step.runId)) continue;
        const blocker = step.status === "blocked" || step.status === "waiting_for_input";
        const source = sourceFor(input.cwd, blocker ? "blocker" : "progress", step.id, channel.id, {
          workspaceId,
          runId: step.runId,
          workflowStepId: step.id,
          revision: revisionFromTimestamp(step.updatedAt),
        });
        items.push({
          schemaVersion: 1,
          id: (blocker ? "blocker:" : "progress:") + step.id,
          priority: blocker ? "blocker" : "progress",
          status: blocker ? "pending" : "active",
          source,
          actor: actorFor(step.toParticipantId, step.toParticipantLabel, teammates),
          title: blocker ? "Workflow needs attention" : step.title,
          summary: truncate(step.blocker || step.resultSummary || step.title, 180),
          revision: source.revision ?? 1,
          createdAt: step.createdAt,
          updatedAt: step.updatedAt,
          payload: blocker ? {
            kind: "blocker",
            nextAction: step.status === "waiting_for_input" ? "Answer the pending question." : "Open the blocked workflow step.",
          } : {
            kind: "progress",
            runId: step.runId,
            workflowStepId: step.id,
            phase: step.status,
          },
          action: { kind: "open_source", enabled: true, source },
        });
      }
    }
  }

  for (const workUnit of input.store.listWorkUnits({ limit: 500 })) {
    if (!["waiting_for_input", "waiting_for_approval", "running", "claimed", "queued"].includes(workUnit.status)) continue;
    if (workUnit.status === "waiting_for_approval" && workUnit.linkedRunId && approvalRunIds.has(workUnit.linkedRunId)) continue;
    const channelId = workUnit.channelId;
    const teammateId = workUnit.teammateId;
    const actor = actorFor(teammateId, teammates.get(teammateId ?? "") ?? "Ling", teammates);
    const kind = workUnit.status === "waiting_for_input" ? "blocker" : "progress";
    const priority = kind === "blocker" ? "blocker" : "progress";
    const source = sourceFor(input.cwd, kind, workUnit.id, channelId, {
      workspaceId,
      runId: workUnit.linkedRunId,
      revision: revisionFromTimestamp(workUnit.updatedAt),
    });
    const summary = workUnit.errorMessage || workUnitTitle(workUnit);
    items.push({
      schemaVersion: 1,
      id: `${kind}:${workUnit.id}`,
      priority,
      status: kind === "progress" ? "active" : "pending",
      source,
      actor,
      title: kind === "progress" ? "Work in progress" : "Work needs attention",
      summary: truncate(summary, 180),
      revision: source.revision ?? 1,
      createdAt: workUnit.createdAt,
      updatedAt: workUnit.updatedAt,
      payload: {
        kind,
        ...(workUnit.errorCode ? { blockerCode: workUnit.errorCode } : {}),
        ...(kind === "blocker" ? { nextAction: workUnit.status === "waiting_for_input" ? "Answer the pending question." : "Open the owning work item." } : {}),
        ...(kind === "progress" ? { runId: workUnit.linkedRunId, phase: workUnit.status } : {}),
      },
      action: { kind: "open_source", enabled: true, source },
    });
  }

  for (const record of input.store.listTerminalReports({
    effectiveOnly: true,
    publishedOnly: true,
    limit: 100,
  })) {
    if (!record.report || !terminalReportIsEligibleForDisplay(input.store, record)
      || (record.status !== "committed" && record.status !== "fallback")) continue;
    const report = projectTerminalReportDto(record.report, record.evidenceSnapshot);
    const source = sourceFor(input.cwd, "terminal_report", report.id, report.channelId, {
      workspaceId,
      threadId: report.threadId,
      turnId: report.turnId,
      reportId: report.id,
      revision: record.generation,
    });
    items.push({
      schemaVersion: 1,
      id: `terminal_report:${report.id}`,
      priority: "result",
      status: "resolved",
      source,
      actor: actorFor(report.participants[0]?.agentId, report.participants[0]?.displayName ?? "Ling", teammates),
      title: report.outcome.title,
      summary: truncate(report.outcome.summary || report.outcome.status, 220),
      revision: record.generation,
      createdAt: report.createdAt,
      updatedAt: report.committedAt,
      payload: {
        kind: "terminal_report",
        reportId: report.id,
        outcomeStatus: report.outcome.status,
        ...(report.verification[0]?.summary ? { verificationSummary: report.verification[0].summary } : {}),
        ...(report.artifacts[0]?.id ? { artifactId: report.artifacts[0].id } : {}),
      },
      action: { kind: "open_source", enabled: true, source },
    });
  }

  return {
    schemaVersion: 1,
    cwd: input.cwd,
    generatedAt: now,
    items: orderCompanionAttentionItems(items).slice(0, Math.max(1, Math.min(input.limit ?? DEFAULT_LIMIT, 500))),
  };
}

function collectUserInputItems(
  store: RunStore,
  cwd: string,
  workspaceId: string,
  channelId: string,
  channelNames: ReadonlyMap<string, string>,
  teammates: ReadonlyMap<string, string>,
  target: CompanionAttentionItem[],
): void {
  const threads = store.listLingThreads({ channelId, includeArchived: false, limit: 100 });
  for (const thread of threads) {
    const anchorIds = new Set<string>();
    let beforeSequence: number | undefined;
    try {
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        const page = store.listConversationItemsPage({
          threadId: thread.id,
          effectiveOnly: true,
          limit: THREAD_PAGE_LIMIT,
          ...(beforeSequence === undefined ? {} : { beforeSequence }),
        });
        for (const item of page.items) {
          if (item.kind === "user_input_request" || item.kind === "user_input_answer") anchorIds.add(item.id);
        }
        if (page.nextBeforeSequence === undefined || page.nextBeforeSequence === beforeSequence) break;
        beforeSequence = page.nextBeforeSequence;
      }
    } catch {
      continue;
    }
    if (anchorIds.size === 0) continue;
    const transcripts = store.readUserInputTranscript({ threadId: thread.id, itemIds: [...anchorIds] });
    for (const request of transcripts) {
      if (request.availability !== "available" || request.kind !== "user_input_request" || request.status !== "pending") continue;
      const source = sourceFor(cwd, "user_input", request.requestId, channelId, {
        workspaceId,
        threadId: request.source.threadId,
        turnId: request.source.turnId,
        runId: request.source.runId,
        sourceItemId: request.source.sourceItemId,
        workflowStepId: request.source.workflowStepId,
        requestId: request.requestId,
        revision: request.statusRevision,
      });
      const firstQuestion = request.questions[0]?.prompt ?? "Ling needs a response.";
      const options = request.questions[0]?.options.map((option) => option.label).filter(Boolean).slice(0, 3) ?? [];
      target.push({
        schemaVersion: 1,
        id: `user_input:${request.requestId}`,
        priority: request.waitMode === "required" ? "required_input" : "optional_input",
        status: "pending",
        source,
        actor: actorFor(request.source.participantId, teammates.get(request.source.participantId) ?? channelNames.get(channelId) ?? "Ling", teammates),
        title: request.waitMode === "required" ? "Answer needed" : "Question from Ling",
        summary: truncate(options.length > 0 ? `${firstQuestion} · ${options.join(" / ")}` : firstQuestion, 220),
        revision: request.statusRevision,
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
        payload: {
          kind: "user_input",
          requestId: request.requestId,
          requestVersion: request.requestVersion,
          statusRevision: request.statusRevision,
          status: request.status,
          waitMode: request.waitMode,
          questions: request.questions,
          ...(request.answerAuthority ? { answerAuthority: request.answerAuthority } : {}),
        },
        action: { kind: "answer", enabled: Boolean(request.answerAuthority), source },
      });
    }
  }
}

function sourceFor(
  cwd: string,
  kind: CompanionAttentionSource["kind"],
  id: string,
  channelId?: string,
  extra: Partial<CompanionAttentionSource> = {},
): CompanionAttentionSource {
  return {
    workspaceId: extra.workspaceId ?? "workspace",
    cwd,
    kind,
    id,
    ...(channelId ? { channelId } : {}),
    ...extra,
  };
}

function actorFor(
  teammateId: string | undefined,
  label: string,
  teammates: ReadonlyMap<string, string>,
): CompanionAttentionActor {
  return {
    kind: teammateId && teammates.has(teammateId) ? "teammate" : "system",
    ...(teammateId ? { teammateId } : {}),
    label,
  };
}

function revisionFromTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 1;
}

function workUnitTitle(workUnit: WorkUnit): string {
  if (isRecord(workUnit.request)) {
    for (const key of ["title", "prompt", "summary", "objective"]) {
      const value = workUnit.request[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return workUnit.kind.replaceAll("_", " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function truncate(value: string, max: number): string {
  const compact = value.replace(/\\s+/gu, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}
