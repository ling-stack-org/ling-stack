import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  conversationModeKinds,
  lingThreadKinds,
  permissionPresets,
  sessionPermissionModes,
  type ConversationModeKind,
  type GoalEvidenceRef,
  type GoalUsageSource,
  type ApprovalRequest,
  type CreateLingTurnInput,
  type CreateProposedPlanArtifactInput,
  type LingApprovalCheckpoint,
  type LingThread,
  type LingThreadArchivedFilter,
  type LingThreadGoalStatus,
  type LingThreadGoalCompletionActor,
  type LingThreadKind,
  type LingThreadStatus,
  type LingTurn,
  type LingTurnCreatedByActor,
  type LingTurnKind,
  type PermissionConfirmation,
  type PermissionPreset,
  type ProposedPlanArtifact,
  type ProposedPlanArtifactStatus,
  type RunEventEnvelope,
  type RunSession,
  type RunStore,
  type RunTool,
  type SessionPermissionMode,
  type SkillApprovalProfile,
  type UpdateLingThreadGoalInput,
  type UpdateProposedPlanArtifactInput,
} from "@ling-stack/core";
import type { PiRunnerProviderConfig } from "@ling-stack/runner-pi";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readOptionalIntegerQuery, readOptionalJsonBody } from "../../shared/request.js";
import { redactTextWithSecrets } from "../../shared/redaction.js";
import { writeJson } from "../../shared/response.js";
import { isRecord, readOptionalBoolean, readOptionalString, readString } from "../../shared/validation.js";
import { listExecutionActions } from "./execution-actions.js";
import type { RunRequest } from "./schemas.js";

export type LingThreadRoute =
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
  | { readonly kind: "pin"; readonly threadId: string }
  | { readonly kind: "unpin"; readonly threadId: string };

export type StartLingThreadResumeRun = (runRequest: RunRequest) => Promise<string | undefined>;
export type StartLingThreadForkRun = (runRequest: RunRequest) => Promise<string | undefined>;

export interface HandleLingThreadRouteOptions {
  readonly maxBodyBytes: number;
  readonly startResumeRun?: StartLingThreadResumeRun;
  readonly startForkRun?: StartLingThreadForkRun;
}

interface ResumeContextPreview {
  readonly title: string;
  readonly instruction: string;
  readonly sourceRunId: string;
  readonly sourceTurnId?: string;
  readonly priorRunIds: readonly string[];
  readonly priorTurnIds?: readonly string[];
  readonly includedTurnCount?: number;
  readonly includedEventCount: number;
  readonly includedApprovalCount: number;
  readonly includedArtifactIds: readonly string[];
  readonly pendingActionIds: readonly string[];
  readonly contextText: string;
  readonly redactionNotes: readonly string[];
  readonly warnings: readonly string[];
}

interface ThreadResumeAnchor {
  readonly sourceTurn?: LingTurn;
  readonly sourceRun: RunSession;
  readonly warnings: readonly string[];
}

interface ThreadForkAnchor {
  readonly sourceTurn?: LingTurn;
  readonly sourceRun?: RunSession;
}

export async function handleLingThreadsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  maxBodyBytes: number,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /threads` });
    return;
  }

  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method === "POST") {
      const body = await readOptionalJsonBody(request, maxBodyBytes);
      const input = parseCreateLingThreadBody(body);
      const channel = store.getChannel(input.channelId);
      if (!channel) {
        writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${input.channelId}` });
        return;
      }
      const existing = findActiveChannelDiscussionRootThread(store, input.channelId);
      if (existing) {
        writeJson(response, 200, { cwd, thread: existing });
        return;
      }
      const now = new Date().toISOString();
      const thread = store.createLingThread(
        {
          kind: "channel_discussion",
          channelId: input.channelId,
          title: input.title || "Main branch",
          objective: input.objective || `Main conversation branch for ${channel.name}.`,
          status: "open",
        },
        now,
      );
      writeJson(response, 201, { cwd, thread });
      return;
    }

    const searchQuery = readOptionalLingThreadSearchQuery(url);
    const listOptions = {
      kind: readOptionalLingThreadKindQuery(url),
      channelId: url.searchParams.get("channelId") ?? undefined,
      taskId: url.searchParams.get("taskId") ?? undefined,
      teammateId: url.searchParams.get("teammateId") ?? undefined,
      workflowStepId: url.searchParams.get("workflowStepId") ?? undefined,
      externalWorkId: url.searchParams.get("externalWorkId") ?? undefined,
      status: readOptionalLingThreadStatusQuery(url),
      archived: readOptionalLingThreadArchivedFilterQuery(url),
      includeArchived: url.searchParams.get("includeArchived") === "true",
      limit: readOptionalIntegerQuery(url, "limit", 1),
    };
    if (searchQuery) {
      const result = store.searchLingThreads({ ...listOptions, q: searchQuery });
      writeJson(response, 200, {
        cwd,
        threads: result.threads,
        matches: result.matches,
      });
      return;
    }
    writeJson(response, 200, {
      cwd,
      threads: store.listLingThreads(listOptions),
    });
  } catch (error) {
    writeLingThreadRouteError(response, error);
  }
}

export function handleLingThreadItem(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  route: LingThreadRoute,
  options?: HandleLingThreadRouteOptions,
): void | Promise<void> {
  if (route.kind === "resume") {
    return handleLingThreadResume(request, response, url, storeRegistry, route.threadId, options);
  }
  if (route.kind === "resume-preview") {
    return handleLingThreadResumePreview(request, response, url, storeRegistry, route.threadId, options);
  }
  if (route.kind === "fork") {
    return handleLingThreadFork(request, response, url, storeRegistry, route.threadId, options);
  }
  if (route.kind === "fork-run") {
    return handleLingThreadForkRun(request, response, url, storeRegistry, route.threadId, options);
  }
  if (route.kind === "archive" || route.kind === "unarchive" || route.kind === "pin" || route.kind === "unpin") {
    return handleLingThreadVisibilityMutation(request, response, url, storeRegistry, route);
  }
  if (route.kind === "mode") {
    return handleLingThreadMode(request, response, url, storeRegistry, route.threadId, options);
  }
  if (route.kind === "goal") {
    return handleLingThreadGoal(request, response, url, storeRegistry, route.threadId);
  }
  if (route.kind === "goal-complete") {
    return handleLingThreadGoalComplete(request, response, url, storeRegistry, route.threadId);
  }
  if (route.kind === "proposed-plans") {
    return handleLingThreadProposedPlans(request, response, url, storeRegistry, route.threadId, route.planId, route.action, options);
  }
  if (route.kind === "turns") {
    return handleLingThreadTurns(request, response, url, storeRegistry, route.threadId, options);
  }
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for thread items` });
    return;
  }

  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  const store = storeRegistry.getStore(cwd);
  const thread = store.getLingThread(route.threadId);
  if (!thread) {
    writeJson(response, 404, { error: "thread_not_found", message: `Ling thread not found: ${route.threadId}` });
    return;
  }

  if (route.kind === "evidence") {
    writeJson(response, 200, buildLingThreadEvidence(store, cwd, thread));
    return;
  }

  writeJson(response, 200, { cwd, thread });
}

async function handleLingThreadMode(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  threadId: string,
  options?: HandleLingThreadRouteOptions,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "PATCH") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for thread mode` });
    return;
  }
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    const thread = store.getLingThread(threadId);
    if (!thread) {
      writeJson(response, 404, { error: "thread_not_found", message: `Ling thread not found: ${threadId}` });
      return;
    }
    if (request.method === "PATCH") {
      const body = await readOptionalJsonBody(request, options?.maxBodyBytes ?? 1024 * 1024);
      const mode = store.updateLingThreadConversationMode(threadId, parseUpdateConversationModeBody(body), new Date().toISOString());
      if (!mode) {
        writeJson(response, 404, { error: "thread_not_found", message: `Ling thread not found: ${threadId}` });
        return;
      }
      writeJson(response, 200, { cwd, threadId, mode });
      return;
    }
    writeJson(response, 200, { cwd, threadId, mode: thread.conversationMode });
  } catch (error) {
    writeLingThreadRouteError(response, error);
  }
}

async function handleLingThreadGoal(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  threadId: string,
): Promise<void> {
  const supportedMethods = new Set(["GET", "PUT", "PATCH", "DELETE"]);
  if (!request.method || !supportedMethods.has(request.method)) {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for thread goal` });
    return;
  }
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    const thread = store.getLingThread(threadId);
    if (!thread) {
      writeJson(response, 404, { error: "thread_not_found", message: `Ling thread not found: ${threadId}` });
      return;
    }
    if (request.method === "GET") {
      writeJson(response, 200, { cwd, threadId, goal: store.getLingThreadGoal(threadId) ?? null });
      return;
    }
    if (request.method === "PUT") {
      const body = await readOptionalJsonBody(request, 1024 * 1024);
      const input = parsePutLingThreadGoalBody(body);
      const existing = store.getLingThreadGoal(threadId);
      if (existing && !input.replaceExisting) {
        writeJson(response, 409, {
          error: "goal_replace_required",
          message: "An unfinished goal already exists for this thread. Pass replaceExisting=true to replace it.",
          goal: existing,
        });
        return;
      }
      const now = new Date().toISOString();
      const goal = existing
        ? store.replaceLingThreadGoal({ threadId, objective: input.objective, tokenBudget: input.tokenBudget ?? undefined }, now)
        : store.createLingThreadGoal({ threadId, objective: input.objective, tokenBudget: input.tokenBudget ?? undefined }, now);
      writeJson(response, existing ? 200 : 201, { cwd, threadId, goal });
      return;
    }
    if (request.method === "PATCH") {
      const existing = store.getLingThreadGoal(threadId);
      if (!existing) {
        writeJson(response, 404, { error: "goal_not_found", message: `No active goal found for thread: ${threadId}` });
        return;
      }
      const body = await readOptionalJsonBody(request, 1024 * 1024);
      const patch = parsePatchLingThreadGoalBody(body);
      const goal = store.updateLingThreadGoal(existing.id, patch, new Date().toISOString());
      writeJson(response, 200, { cwd, threadId, goal: goal ?? null });
      return;
    }
    const goal = store.clearLingThreadGoal(threadId, new Date().toISOString());
    writeJson(response, 200, { cwd, threadId, goal: goal ?? null });
  } catch (error) {
    writeLingThreadRouteError(response, error);
  }
}

async function handleLingThreadGoalComplete(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  threadId: string,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for goal completion` });
    return;
  }
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    const thread = store.getLingThread(threadId);
    if (!thread) {
      writeJson(response, 404, { error: "thread_not_found", message: `Ling thread not found: ${threadId}` });
      return;
    }
    const existing = store.getLingThreadGoal(threadId);
    if (!existing) {
      writeJson(response, 404, { error: "goal_not_found", message: `No active goal found for thread: ${threadId}` });
      return;
    }
    const body = await readOptionalJsonBody(request, 1024 * 1024);
    const input = parseCompleteLingThreadGoalBody(body);
    const goal = store.updateLingThreadGoal(
      existing.id,
      {
        status: "complete",
        completedBy: input.actor,
        completedReason: input.reason,
        completionVerificationSummary: input.completionVerificationSummary,
        completionEvidenceRefs: mergeGoalEvidenceRefs(existing.completionEvidenceRefs, input.evidenceRefs),
        blockedReason: null,
        continuationChainId: null,
        continuationDepth: 0,
        noEvidenceContinuationCount: 0,
        lastBlockerFingerprint: null,
        sameBlockerCount: 0,
      },
      new Date().toISOString(),
    );
    writeJson(response, 200, { cwd, threadId, goal: goal ?? null });
  } catch (error) {
    writeLingThreadRouteError(response, error);
  }
}

async function handleLingThreadProposedPlans(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  threadId: string,
  planId: string | undefined,
  action: "accept" | "refine" | "save" | "convert-workflow" | "archive" | undefined,
  options?: HandleLingThreadRouteOptions,
): Promise<void> {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    const thread = store.getLingThread(threadId);
    if (!thread) {
      writeJson(response, 404, { error: "thread_not_found", message: `Ling thread not found: ${threadId}` });
      return;
    }
    const maxBodyBytes = options?.maxBodyBytes ?? 1024 * 1024;
    if (action) {
      if (!planId) {
        writeJson(response, 404, { error: "proposed_plan_not_found", message: "Proposed plan id is required." });
        return;
      }
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for proposed plan actions` });
        return;
      }
      const body = await readOptionalJsonBody(request, maxBodyBytes);
      const actionInput = parseProposedPlanActionBody(body);
      const plan = upsertProposedPlanForAction(store, threadId, planId, actionInput.plan, new Date().toISOString());
      const result = applyProposedPlanAction(store, thread, plan, action, actionInput, new Date().toISOString());
      writeJson(response, 200, {
        cwd,
        threadId,
        plan: result.plan,
        taskId: result.taskId,
        workflowId: result.workflowId,
        workflowStepId: result.workflowStepId,
        runId: result.runId,
      });
      return;
    }

    if (!planId) {
      if (request.method === "GET") {
        writeJson(response, 200, {
          cwd,
          threadId,
          plans: store.listProposedPlanArtifacts({
            threadId,
            limit: readOptionalIntegerQuery(url, "limit", 1),
          }),
        });
        return;
      }
      if (request.method === "POST") {
        const body = await readOptionalJsonBody(request, maxBodyBytes);
        const plan = store.upsertProposedPlanArtifact(parsePutProposedPlanArtifactBody(body, threadId), new Date().toISOString());
        writeJson(response, 201, { cwd, threadId, plan });
        return;
      }
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for proposed plans` });
      return;
    }

    if (request.method === "GET") {
      const plan = store.getProposedPlanArtifact(planId);
      if (!plan || plan.threadId !== threadId) {
        writeJson(response, 404, { error: "proposed_plan_not_found", message: `Proposed plan not found: ${planId}` });
        return;
      }
      writeJson(response, 200, { cwd, threadId, plan });
      return;
    }
    if (request.method === "PUT") {
      const body = await readOptionalJsonBody(request, maxBodyBytes);
      const existing = store.getProposedPlanArtifact(planId);
      if (existing && existing.threadId !== threadId) {
        writeJson(response, 404, { error: "proposed_plan_not_found", message: `Proposed plan not found: ${planId}` });
        return;
      }
      assertProposedPlanDirectMutationAllowed(existing);
      const plan = store.upsertProposedPlanArtifact({ ...parsePutProposedPlanArtifactBody(body, threadId), id: planId }, new Date().toISOString());
      writeJson(response, existing ? 200 : 201, { cwd, threadId, plan });
      return;
    }
    if (request.method === "PATCH") {
      const existing = store.getProposedPlanArtifact(planId);
      if (!existing || existing.threadId !== threadId) {
        writeJson(response, 404, { error: "proposed_plan_not_found", message: `Proposed plan not found: ${planId}` });
        return;
      }
      const body = await readOptionalJsonBody(request, maxBodyBytes);
      const patch = parsePatchProposedPlanArtifactBody(body);
      assertProposedPlanDirectMutationAllowed(existing, patch);
      const plan = store.updateProposedPlanArtifact(planId, patch, new Date().toISOString());
      writeJson(response, 200, { cwd, threadId, plan: plan ?? existing });
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for proposed plan items` });
  } catch (error) {
    writeLingThreadRouteError(response, error);
  }
}

async function handleLingThreadTurns(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  threadId: string,
  options?: HandleLingThreadRouteOptions,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for thread turns` });
    return;
  }
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    const thread = store.getLingThread(threadId);
    if (!thread) {
      writeJson(response, 404, { error: "thread_not_found", message: `Ling thread not found: ${threadId}` });
      return;
    }
    if (request.method === "POST") {
      const body = await readOptionalJsonBody(request, options?.maxBodyBytes ?? 1024 * 1024);
      const turn = store.createLingTurn(parseCreateLingTurnBody(body, thread), new Date().toISOString());
      writeJson(response, 201, {
        cwd,
        threadId,
        turn,
        runLinks: store.listLingTurnRuns(turn.id),
      });
      return;
    }

    const turns = store.listLingTurns({
      threadId,
      limit: readOptionalIntegerQuery(url, "limit", 1),
      beforeUpdatedAt: url.searchParams.get("beforeUpdatedAt") ?? undefined,
    });
    writeJson(response, 200, {
      cwd,
      threadId,
      turns,
      runLinks: turns.flatMap((turn) => store.listLingTurnRuns(turn.id)),
    });
  } catch (error) {
    writeLingThreadRouteError(response, error);
  }
}

async function handleLingThreadResumePreview(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  threadId: string,
  options?: HandleLingThreadRouteOptions,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for thread resume preview` });
    return;
  }
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    const thread = store.getLingThread(threadId);
    if (!thread) {
      writeJson(response, 404, { error: "thread_not_found", message: `Ling thread not found: ${threadId}` });
      return;
    }
    const body = await readOptionalJsonBody(request, options?.maxBodyBytes ?? 1024 * 1024);
    const resume = buildLingThreadResumeContext({ store, thread, body, mode: "preview" });
    writeJson(response, 200, {
      cwd,
      thread,
      sourceRun: resume.sourceRun,
      context: resume.context,
    });
  } catch (error) {
    writeLingThreadRouteError(response, error);
  }
}

function writeLingThreadRouteError(response: ServerResponse, error: unknown): void {
  writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
    error: error instanceof HttpError ? error.code : "bad_request",
    message: error instanceof Error ? error.message : String(error),
  });
}

async function handleLingThreadVisibilityMutation(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  route: Extract<LingThreadRoute, { readonly kind: "archive" | "unarchive" | "pin" | "unpin" }>,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for thread ${route.kind}` });
    return;
  }
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    const thread = store.getLingThread(route.threadId);
    if (!thread) {
      writeJson(response, 404, { error: "thread_not_found", message: `Ling thread not found: ${route.threadId}` });
      return;
    }
    const body = await readOptionalJsonBody(request, 1024 * 1024);
    const now = new Date().toISOString();
    const updated = mutateLingThreadVisibility({
      store,
      thread,
      body,
      kind: route.kind,
      now,
    });
    writeJson(response, 200, { cwd, thread: updated });
  } catch (error) {
    writeLingThreadRouteError(response, error);
  }
}

function mutateLingThreadVisibility(input: {
  readonly store: RunStore;
  readonly thread: LingThread;
  readonly body: unknown;
  readonly kind: "archive" | "unarchive" | "pin" | "unpin";
  readonly now: string;
}): LingThread {
  const { store, thread, body, kind, now } = input;
  const idempotencyKey = isRecord(body) ? readOptionalString(body, "idempotencyKey")?.trim() : undefined;

  if (kind === "archive") {
    if (thread.status === "archived" || thread.archivedAt) {
      if (idempotencyKey) {
        return thread;
      }
      throw new HttpError(409, "thread_already_archived", `Ling thread is already archived: ${thread.id}`);
    }
    assertLingThreadCanArchive(store, thread);
    const rawReason = isRecord(body) ? readOptionalString(body, "reason")?.trim() : undefined;
    const reason = rawReason ? truncateArchiveReason(redactTextWithSecrets(rawReason)) : undefined;
    const updated = store.updateLingThread(thread.id, { archivedAt: now, archivedReason: reason ?? null }, now);
    if (!updated) {
      throw new HttpError(404, "thread_not_found", `Ling thread not found: ${thread.id}`);
    }
    return updated;
  }

  if (kind === "unarchive") {
    if (thread.status !== "archived" && !thread.archivedAt) {
      if (idempotencyKey) {
        return thread;
      }
      throw new HttpError(409, "thread_not_archived", `Ling thread is not archived: ${thread.id}`);
    }
    const updated = store.updateLingThread(
      thread.id,
      {
        archivedAt: null,
        archivedReason: null,
        status: thread.status === "archived" ? "open" : thread.status,
      },
      now,
    );
    if (!updated) {
      throw new HttpError(404, "thread_not_found", `Ling thread not found: ${thread.id}`);
    }
    return updated;
  }

  if (kind === "pin") {
    if (thread.pinnedAt) {
      if (idempotencyKey) {
        return thread;
      }
      throw new HttpError(409, "thread_already_pinned", `Ling thread is already pinned: ${thread.id}`);
    }
    const updated = store.updateLingThread(thread.id, { pinnedAt: now }, now);
    if (!updated) {
      throw new HttpError(404, "thread_not_found", `Ling thread not found: ${thread.id}`);
    }
    return updated;
  }

  if (!thread.pinnedAt) {
    if (idempotencyKey) {
      return thread;
    }
    throw new HttpError(409, "thread_not_pinned", `Ling thread is not pinned: ${thread.id}`);
  }
  const updated = store.updateLingThread(thread.id, { pinnedAt: null }, now);
  if (!updated) {
    throw new HttpError(404, "thread_not_found", `Ling thread not found: ${thread.id}`);
  }
  return updated;
}

function assertLingThreadCanArchive(store: RunStore, thread: LingThread): void {
  if (thread.activeRunId) {
    const activeRun = store.getRun(thread.activeRunId);
    if (!activeRun || !isTerminalRunStatus(activeRun.status)) {
      throw new HttpError(409, "active_thread_archive_blocked", `Cannot archive thread with active work: ${thread.id}`);
    }
  }
  const activeTurn = store
    .listLingTurns({ threadId: thread.id, limit: 500 })
    .find((turn) => isLingTurnActiveForResume(turn, turn.activeRunId ? store.getRun(turn.activeRunId) : undefined));
  if (activeTurn) {
    throw new HttpError(409, "active_thread_archive_blocked", `Cannot archive thread with active turn: ${activeTurn.id}`);
  }
}

function truncateArchiveReason(reason: string): string {
  return reason.length > 500 ? reason.slice(0, 500) : reason;
}

async function handleLingThreadFork(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  threadId: string,
  options?: HandleLingThreadRouteOptions,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for thread fork` });
    return;
  }
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    const sourceThread = store.getLingThread(threadId);
    if (!sourceThread) {
      writeJson(response, 404, { error: "thread_not_found", message: `Ling thread not found: ${threadId}` });
      return;
    }
    const body = await readOptionalJsonBody(request, options?.maxBodyBytes ?? 1024 * 1024);
    const fork = createLingThreadFork({ store, sourceThread, body, now: new Date().toISOString() });
    writeJson(response, fork.created ? 201 : 200, {
      cwd,
      sourceThread: store.getLingThread(sourceThread.id) ?? sourceThread,
      sourceTurn: fork.sourceTurn,
      sourceRun: fork.sourceRun,
      childThread: fork.childThread,
      lineage: {
        parentThreadId: sourceThread.id,
        parentTurnId: fork.sourceTurn?.id,
        forkedFromRunId: fork.sourceRun?.id,
      },
    });
  } catch (error) {
    writeLingThreadRouteError(response, error);
  }
}

async function handleLingThreadForkRun(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  threadId: string,
  options?: HandleLingThreadRouteOptions,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for thread fork-run` });
    return;
  }
  const startForkRun = options?.startForkRun ?? options?.startResumeRun;
  if (!startForkRun) {
    writeJson(response, 501, { error: "fork_run_unavailable", message: "Thread fork-and-run execution is not configured." });
    return;
  }
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    const sourceThread = store.getLingThread(threadId);
    if (!sourceThread) {
      writeJson(response, 404, { error: "thread_not_found", message: `Ling thread not found: ${threadId}` });
      return;
    }
    const body = await readOptionalJsonBody(request, options?.maxBodyBytes ?? 1024 * 1024);
    const forkRun = createLingThreadForkRunRequest({ store, sourceThread, body, cwd, now: new Date().toISOString() });
    let runId: string | undefined;
    try {
      runId = await startForkRun(forkRun.runRequest);
    } catch (error) {
      const startError = serializeForkRunStartError(error);
      writeJson(response, 500, {
        cwd,
        sourceThread: store.getLingThread(sourceThread.id) ?? sourceThread,
        sourceTurn: forkRun.sourceTurn,
        sourceRun: forkRun.sourceRun,
        childThread: store.getLingThread(forkRun.childThread.id) ?? forkRun.childThread,
        childTurn: store.getLingTurn(forkRun.childTurn.id) ?? forkRun.childTurn,
        status: "run_failed",
        error: startError,
      });
      return;
    }
    if (!runId) {
      writeJson(response, 500, {
        cwd,
        sourceThread: store.getLingThread(sourceThread.id) ?? sourceThread,
        sourceTurn: forkRun.sourceTurn,
        sourceRun: forkRun.sourceRun,
        childThread: store.getLingThread(forkRun.childThread.id) ?? forkRun.childThread,
        childTurn: store.getLingTurn(forkRun.childTurn.id) ?? forkRun.childTurn,
        status: "run_failed",
        error: {
          code: "fork_run_start_failed",
          message: "Fork-and-run child run failed to start.",
        },
      });
      return;
    }
    writeJson(response, 202, {
      cwd,
      sourceThread: store.getLingThread(sourceThread.id) ?? sourceThread,
      sourceTurn: forkRun.sourceTurn,
      sourceRun: forkRun.sourceRun,
      childThread: store.getLingThread(forkRun.childThread.id) ?? forkRun.childThread,
      childTurn: store.getLingTurn(forkRun.childTurn.id) ?? forkRun.childTurn,
      childRun: store.getRun(runId),
      runId,
      status: "run_started",
    });
  } catch (error) {
    writeLingThreadRouteError(response, error);
  }
}

async function handleLingThreadResume(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  threadId: string,
  options?: HandleLingThreadRouteOptions,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for thread resume` });
    return;
  }
  if (!options?.startResumeRun) {
    writeJson(response, 501, { error: "resume_unavailable", message: "Thread resume execution is not configured." });
    return;
  }
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    const thread = store.getLingThread(threadId);
    if (!thread) {
      writeJson(response, 404, { error: "thread_not_found", message: `Ling thread not found: ${threadId}` });
      return;
    }
    const body = await readOptionalJsonBody(request, options.maxBodyBytes);
    const resume = buildLingThreadResumeContext({ store, thread, body, mode: "execute" });
    const runId = await options.startResumeRun(resume.runRequest);
    if (!runId) {
      writeJson(response, 500, { error: "resume_start_failed", message: "Thread resume run failed to start." });
      return;
    }
    writeJson(response, 202, {
      cwd,
      thread: store.getLingThread(thread.id) ?? thread,
      sourceRun: resume.sourceRun,
      runId,
      continuationReason: "manual_resume",
    });
  } catch (error) {
    writeLingThreadRouteError(response, error);
  }
}

function createLingThreadFork(input: {
  readonly store: RunStore;
  readonly sourceThread: LingThread;
  readonly body: unknown;
  readonly now: string;
}): {
  readonly sourceTurn?: LingTurn;
  readonly sourceRun?: RunSession;
  readonly childThread: LingThread;
  readonly created: boolean;
} {
  const { store, sourceThread, body, now } = input;
  if (sourceThread.status === "archived" || sourceThread.archivedAt) {
    throw new HttpError(409, "source_thread_archived", `Cannot fork archived thread: ${sourceThread.id}`);
  }
  const anchor = resolveThreadForkAnchor(store, sourceThread, body);
  const idempotencyKey = isRecord(body) ? readOptionalString(body, "idempotencyKey")?.trim() : undefined;
  const childThreadId = idempotencyKey
    ? deterministicForkThreadId({
        parentThreadId: sourceThread.id,
        parentTurnId: anchor.sourceTurn?.id,
        forkedFromRunId: anchor.sourceRun?.id,
        idempotencyKey,
      })
    : undefined;
  if (childThreadId) {
    const existing = store.getLingThread(childThreadId);
    if (existing) {
      if (
        existing.parentThreadId !== sourceThread.id ||
        existing.parentTurnId !== anchor.sourceTurn?.id ||
        existing.forkedFromRunId !== anchor.sourceRun?.id
      ) {
        throw new HttpError(409, "fork_idempotency_conflict", `Fork idempotency key conflicts with an existing child thread: ${childThreadId}`);
      }
      return {
        sourceTurn: anchor.sourceTurn,
        sourceRun: anchor.sourceRun,
        childThread: existing,
        created: false,
      };
    }
  }

  const requestedTitle = isRecord(body) ? readOptionalString(body, "title")?.trim() : undefined;
  const requestedObjective = isRecord(body) ? readOptionalString(body, "objective")?.trim() : undefined;
  const sourceLabel = anchor.sourceTurn?.title || sourceThread.title;
  const childThread = store.createLingThread(
    {
      id: childThreadId,
      kind: sourceThread.kind,
      channelId: sourceThread.channelId,
      taskId: sourceThread.taskId,
      teammateId: sourceThread.teammateId,
      workflowId: sourceThread.workflowId,
      workflowStepId: sourceThread.workflowStepId,
      externalWorkId: sourceThread.externalWorkId,
      title: requestedTitle || `Fork: ${sourceThread.title}`,
      objective: requestedObjective || `Forked from ${sourceLabel} (${sourceThread.id}) to explore a separate work branch.`,
      status: "open",
      parentThreadId: sourceThread.id,
      parentTurnId: anchor.sourceTurn?.id,
      forkedFromRunId: anchor.sourceRun?.id,
    },
    now,
  );
  return {
    sourceTurn: anchor.sourceTurn,
    sourceRun: anchor.sourceRun,
    childThread,
    created: true,
  };
}

function createLingThreadForkRunRequest(input: {
  readonly store: RunStore;
  readonly sourceThread: LingThread;
  readonly body: unknown;
  readonly cwd: string;
  readonly now: string;
}): {
  readonly sourceTurn?: LingTurn;
  readonly sourceRun?: RunSession;
  readonly childThread: LingThread;
  readonly childTurn: LingTurn;
  readonly runRequest: RunRequest;
} {
  const { store, sourceThread, body, cwd, now } = input;
  if (!isRecord(body)) {
    throw new HttpError(400, "bad_request", "Fork-and-run request must be a JSON object.");
  }
  const instruction = readOptionalString(body, "instruction")?.trim();
  if (!instruction) {
    throw new HttpError(400, "fork_run_instruction_required", "Fork-and-run requires a non-empty instruction.");
  }
  const userIdempotencyKey = readOptionalString(body, "idempotencyKey")?.trim();
  if (!userIdempotencyKey) {
    throw new HttpError(400, "fork_run_idempotency_required", "Fork-and-run requires an idempotency key.");
  }
  const anchor = resolveThreadForkAnchor(store, sourceThread, body);
  const operationKey = buildForkRunOperationKey({
    sourceThreadId: sourceThread.id,
    sourceTurnId: anchor.sourceTurn?.id,
    sourceRunId: anchor.sourceRun?.id,
    idempotencyKey: userIdempotencyKey,
  });
  const fork = createLingThreadFork({
    store,
    sourceThread,
    body: {
      ...body,
      idempotencyKey: operationKey,
    },
    now,
  });
  const childTurn = createOrReuseForkRunChildTurn({
    store,
    childThread: fork.childThread,
    sourceTurn: fork.sourceTurn,
    operationKey,
    instruction,
    now,
  });
  return {
    sourceTurn: fork.sourceTurn,
    sourceRun: fork.sourceRun,
    childThread: fork.childThread,
    childTurn,
    runRequest: buildForkRunRunRequest({
      cwd,
      sourceThread,
      sourceRun: fork.sourceRun,
      childThread: fork.childThread,
      childTurn,
      body,
      instruction,
      operationKey,
    }),
  };
}

function createOrReuseForkRunChildTurn(input: {
  readonly store: RunStore;
  readonly childThread: LingThread;
  readonly sourceTurn?: LingTurn;
  readonly operationKey: string;
  readonly instruction: string;
  readonly now: string;
}): LingTurn {
  const childTurnId = deterministicForkRunTurnId(input.operationKey);
  const existing = input.store.getLingTurn(childTurnId);
  if (existing) {
    if (
      existing.threadId !== input.childThread.id ||
      existing.userInstruction !== input.instruction
    ) {
      throw new HttpError(409, "fork_run_child_turn_conflict", `Fork-and-run child turn conflicts with an existing turn: ${childTurnId}`);
    }
    return existing;
  }
  return input.store.createLingTurn(
    {
      id: childTurnId,
      threadId: input.childThread.id,
      kind: "initial_request",
      status: "open",
      title: titleFromInstruction(input.instruction, "Fork and run"),
      userInstruction: input.instruction,
      channelId: input.childThread.channelId,
      taskId: input.childThread.taskId,
      teammateId: input.childThread.teammateId,
      workflowStepId: input.childThread.workflowStepId,
      externalWorkId: input.childThread.externalWorkId,
      createdByActor: "local-user",
    },
    input.now,
  );
}

function buildForkRunRunRequest(input: {
  readonly cwd: string;
  readonly sourceThread: LingThread;
  readonly sourceRun?: RunSession;
  readonly childThread: LingThread;
  readonly childTurn: LingTurn;
  readonly body: Record<string, unknown>;
  readonly instruction: string;
  readonly operationKey: string;
}): RunRequest {
  const sourceRun = input.sourceRun;
  const requestSnapshot = sourceRun && isRecord(sourceRun.requestSnapshot) ? sourceRun.requestSnapshot : {};
  const taskSnapshot = sourceRun && isRecord(sourceRun.taskSnapshot) ? sourceRun.taskSnapshot : {};
  const requestedProviderPresetId = readOptionalString(input.body, "providerPresetId")?.trim();
  const providerPresetId =
    requestedProviderPresetId ||
    readSnapshotString(requestSnapshot, "providerPresetId") ||
    sourceRun?.providerPresetId;
  const inlineProvider = providerPresetId || !isRecord(requestSnapshot.provider)
    ? undefined
    : requestSnapshot.provider as unknown as PiRunnerProviderConfig;
  if (!providerPresetId && !inlineProvider) {
    throw new HttpError(400, "fork_run_snapshot_unavailable", "Cannot fork and run because no reusable provider snapshot or providerPresetId is available.");
  }
  const requestedRunnerId = readOptionalString(input.body, "runnerId")?.trim();
  const taskId = deterministicForkRunTaskId(input.operationKey);
  return {
    workspaceCwd: readSnapshotString(requestSnapshot, "workspaceCwd") ?? sourceRun?.cwd ?? input.cwd,
    cwd: readSnapshotString(requestSnapshot, "cwd") ?? sourceRun?.cwd ?? input.cwd,
    providerPresetId,
    provider: inlineProvider,
    teammateId: input.childThread.teammateId ?? readSnapshotString(requestSnapshot, "teammateId") ?? sourceRun?.teammateId,
    workflowStepId: input.childThread.workflowStepId ?? sourceRun?.workflowStepId,
    threadId: input.childThread.id,
    turnId: input.childTurn.id,
    runnerId: requestedRunnerId || readSnapshotString(requestSnapshot, "runnerId"),
    requestedSkillId: readSnapshotString(requestSnapshot, "requestedSkillId") ?? sourceRun?.selectedSkillId,
    skipProviderPreflight: readSnapshotBoolean(requestSnapshot, "skipProviderPreflight") ?? false,
    idempotencyKey: input.operationKey,
    task: {
      id: taskId,
      title: input.childTurn.title,
      prompt: input.instruction,
      channelId:
        input.childThread.channelId ??
        readSnapshotString(taskSnapshot, "channelId") ??
        readSnapshotString(isRecord(requestSnapshot.task) ? requestSnapshot.task : {}, "channelId") ??
        sourceRun?.channelId,
    },
    tools: readSnapshotRunTools(requestSnapshot, "tools"),
    approvalProfile: isRecord(requestSnapshot.approvalProfile) ? requestSnapshot.approvalProfile as unknown as SkillApprovalProfile : undefined,
    permissionPreset: readSnapshotPermissionPreset(requestSnapshot, "permissionPreset"),
    permissionMode: readSnapshotSessionPermissionMode(requestSnapshot, "permissionMode"),
    permissionConfirmation: readSnapshotPermissionConfirmation(requestSnapshot, "permissionConfirmation"),
    thinkingLevel: readSnapshotThinkingLevel(requestSnapshot, "thinkingLevel"),
    systemPrompt: readSnapshotString(requestSnapshot, "systemPrompt"),
    appendSystemPrompt: readSnapshotStringArray(requestSnapshot, "appendSystemPrompt"),
    agentDir: readSnapshotString(requestSnapshot, "agentDir"),
  };
}

function buildForkRunOperationKey(input: {
  readonly sourceThreadId: string;
  readonly sourceTurnId?: string;
  readonly sourceRunId?: string;
  readonly idempotencyKey: string;
}): string {
  return `fork-run:${input.sourceThreadId}:${input.sourceTurnId ?? ""}:${input.sourceRunId ?? ""}:${input.idempotencyKey}`;
}

function deterministicForkRunTurnId(operationKey: string): string {
  const digest = createHash("sha256").update(operationKey).digest("hex").slice(0, 32);
  return `turn_fork_run_${digest}`;
}

function deterministicForkRunTaskId(operationKey: string): string {
  const digest = createHash("sha256").update(`task:${operationKey}`).digest("hex").slice(0, 32);
  return `task_fork_run_${digest}`;
}

function titleFromInstruction(instruction: string, fallback: string): string {
  const firstLine = instruction.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine) {
    return fallback;
  }
  return firstLine.length > 96 ? `${firstLine.slice(0, 93)}...` : firstLine;
}

function serializeForkRunStartError(error: unknown): { readonly code: string; readonly message: string } {
  return {
    code: error instanceof HttpError ? error.code : "fork_run_start_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

function resolveThreadForkAnchor(store: RunStore, sourceThread: LingThread, body: unknown): ThreadForkAnchor {
  const requestedTurnId = isRecord(body) ? readOptionalString(body, "turnId") : undefined;
  const requestedRunId = isRecord(body) ? readOptionalString(body, "sourceRunId") : undefined;

  if (requestedTurnId) {
    const sourceTurn = store.getLingTurn(requestedTurnId);
    if (!sourceTurn) {
      throw new HttpError(404, "turn_not_found", `Ling turn not found: ${requestedTurnId}`);
    }
    if (sourceTurn.threadId !== sourceThread.id) {
      throw new HttpError(400, "turn_not_in_thread", `Ling turn does not belong to thread: ${requestedTurnId}`);
    }
    if (!isLingTurnTerminalForFork(sourceTurn, sourceTurn.activeRunId ? store.getRun(sourceTurn.activeRunId) : undefined)) {
      throw new HttpError(409, "turn_active", `Selected turn is not terminal: ${sourceTurn.id}`);
    }
    const sourceRun = requestedRunId
      ? resolveThreadForkSourceRun(store, sourceThread, requestedRunId)
      : resolveOptionalForkSourceRunFromTurn(store, sourceThread, sourceTurn);
    if (sourceRun && !isRunLinkedToTurn(store, sourceTurn, sourceRun)) {
      throw new HttpError(400, "source_run_not_in_turn", `Source run does not belong to turn: ${sourceRun.id}`);
    }
    return { sourceTurn, sourceRun };
  }

  if (requestedRunId) {
    const sourceRun = resolveThreadForkSourceRun(store, sourceThread, requestedRunId);
    const sourceTurn = store.getLingTurnForRun(sourceRun.id);
    if (sourceTurn) {
      if (sourceTurn.threadId !== sourceThread.id) {
        throw new HttpError(400, "turn_not_in_thread", `Ling turn does not belong to thread: ${sourceTurn.id}`);
      }
      if (isLingTurnTerminalForFork(sourceTurn, sourceTurn.activeRunId ? store.getRun(sourceTurn.activeRunId) : undefined)) {
        return { sourceTurn, sourceRun };
      }
    }
    return { sourceRun };
  }

  const sourceTurn = resolveLatestTerminalForkTurn(store, sourceThread);
  return {
    sourceTurn,
    sourceRun: sourceTurn ? resolveOptionalForkSourceRunFromTurn(store, sourceThread, sourceTurn) : undefined,
  };
}

function resolveThreadForkSourceRun(store: RunStore, sourceThread: LingThread, sourceRunId: string): RunSession {
  const sourceRun = store.getRun(sourceRunId);
  if (!sourceRun) {
    throw new HttpError(404, "source_run_not_found", `Source run was not found: ${sourceRunId}`);
  }
  if (sourceRun.threadId !== sourceThread.id) {
    throw new HttpError(400, "source_run_not_in_thread", `Source run does not belong to thread: ${sourceRunId}`);
  }
  return sourceRun;
}

function resolveLatestTerminalForkTurn(store: RunStore, sourceThread: LingThread): LingTurn | undefined {
  return [...store.listLingTurns({ threadId: sourceThread.id, limit: 500 })]
    .filter((turn) => isLingTurnTerminalForFork(turn, turn.activeRunId ? store.getRun(turn.activeRunId) : undefined))
    .sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.completedAt?.localeCompare(left.completedAt ?? "") ||
      right.createdAt.localeCompare(left.createdAt) ||
      right.id.localeCompare(left.id))
    [0];
}

function resolveOptionalForkSourceRunFromTurn(store: RunStore, sourceThread: LingThread, sourceTurn: LingTurn): RunSession | undefined {
  try {
    return resolveThreadResumeSourceRunFromTurn(store, sourceThread, sourceTurn);
  } catch (error) {
    if (error instanceof HttpError && error.code === "source_run_not_found") {
      return undefined;
    }
    throw error;
  }
}

function deterministicForkThreadId(input: {
  readonly parentThreadId: string;
  readonly parentTurnId?: string;
  readonly forkedFromRunId?: string;
  readonly idempotencyKey: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 32);
  return `thread_fork_${digest}`;
}

function buildLingThreadEvidence(store: RunStore, cwd: string, thread: LingThread): {
  readonly cwd: string;
  readonly thread: LingThread;
  readonly generatedAt: string;
  readonly runs: readonly {
    readonly run: RunSession;
    readonly events: readonly RunEventEnvelope[];
    readonly approvals: readonly ApprovalRequest[];
    readonly artifacts: ReturnType<RunStore["listArtifacts"]>;
    readonly runtimeEvents: ReturnType<RunStore["listRuntimeEvents"]>;
  }[];
  readonly actions: ReturnType<typeof listExecutionActions>;
  readonly approvalCheckpoints: readonly LingApprovalCheckpoint[];
  readonly transitions: ReturnType<RunStore["listStateTransitionEvents"]>;
} {
  const runs = [...store.listRuns({ threadId: thread.id, limit: 100 })]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const runIds = new Set(runs.map((run) => run.id));
  const threadWorkflowStepApprovals = thread.workflowStepId
    ? store.listApprovalRequests({ workflowStepId: thread.workflowStepId, limit: 500 })
    : [];
  const threadActions = listExecutionActions(store, { threadId: thread.id, limit: 500 });
  const ownerActions = listExecutionActions(store, { limit: 500 })
    .filter((action) => isActionLinkedToThread(action, thread, runIds));
  const actions = uniqueById([...threadActions, ...ownerActions]);
  const approvalIds = new Set<string>();
  const evidenceRuns = runs.map((run) => {
    const approvals = uniqueById([
      ...store.listApprovalRequests({ runId: run.id, limit: 500 }),
      ...threadWorkflowStepApprovals,
    ]);
    for (const approval of approvals) {
      approvalIds.add(approval.id);
    }
    return {
      run,
      events: store.listEvents(run.id, { limit: 1000 }),
      approvals,
      artifacts: store.listArtifacts(run.id),
      runtimeEvents: run.workUnitId ? store.listRuntimeEvents(run.workUnitId, { limit: 1000 }) : [],
    };
  });
  const approvalCheckpoints = [...approvalIds]
    .map((approvalId) => store.getApprovalCheckpointForApproval(approvalId))
    .filter((checkpoint): checkpoint is LingApprovalCheckpoint => Boolean(checkpoint));
  const transitions = collectThreadStateTransitions(store, thread, runs, approvalIds);
  return {
    cwd,
    thread,
    generatedAt: new Date().toISOString(),
    runs: evidenceRuns,
    actions,
    approvalCheckpoints,
    transitions,
  };
}

const lingTurnKinds: readonly LingTurnKind[] = [
  "initial_request",
  "manual_followup",
  "queued_followup",
  "interrupt_redirect",
  "workflow_step",
  "external_work_update",
  "automation_tick",
  "review_queue_action",
];

const lingTurnActors: readonly LingTurnCreatedByActor[] = ["local-user", "system", "teammate", "automation"];

function parseCreateLingTurnBody(body: unknown, thread: LingThread): CreateLingTurnInput {
  if (!isRecord(body)) {
    throw new Error("Turn request must be a JSON object");
  }
  const kind = readLingTurnKind(body, "kind");
  return {
    id: readOptionalString(body, "id"),
    threadId: thread.id,
    kind,
    title: readRequiredString(body, "title"),
    userInstruction: readRequiredString(body, "userInstruction"),
    channelId: readOptionalString(body, "channelId") ?? thread.channelId,
    taskId: readOptionalString(body, "taskId") ?? thread.taskId,
    teammateId: readOptionalString(body, "teammateId") ?? thread.teammateId,
    workflowStepId: readOptionalString(body, "workflowStepId") ?? thread.workflowStepId,
    externalWorkId: readOptionalString(body, "externalWorkId") ?? thread.externalWorkId,
    automationId: readOptionalString(body, "automationId"),
    sourceMessageId: readOptionalString(body, "sourceMessageId"),
    sourceTurnId: readOptionalString(body, "sourceTurnId"),
    interventionId: readOptionalString(body, "interventionId"),
    createdByActor: readOptionalLingTurnActor(body, "createdByActor"),
  };
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = readOptionalString(record, key);
  if (!value?.trim()) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function readLingTurnKind(record: Record<string, unknown>, key: string): LingTurnKind {
  const value = readRequiredString(record, key);
  if (!lingTurnKinds.includes(value as LingTurnKind)) {
    throw new Error(`${key} is not a valid Ling turn kind`);
  }
  return value as LingTurnKind;
}

function readOptionalLingTurnActor(record: Record<string, unknown>, key: string): LingTurnCreatedByActor | undefined {
  const value = readOptionalString(record, key);
  if (!value) {
    return undefined;
  }
  if (!lingTurnActors.includes(value as LingTurnCreatedByActor)) {
    throw new Error(`${key} is not a valid Ling turn actor`);
  }
  return value as LingTurnCreatedByActor;
}

function buildLingThreadResumeContext(input: {
  readonly store: RunStore;
  readonly thread: LingThread;
  readonly body: unknown;
  readonly mode: "preview" | "execute";
}): { readonly sourceRun: RunSession; readonly context: ResumeContextPreview; readonly runRequest: RunRequest } {
  const { store, thread, body } = input;
  const anchor = resolveThreadResumeAnchor(store, thread, body);
  const warnings: string[] = [...anchor.warnings];
  const activeRun = thread.activeRunId ? store.getRun(thread.activeRunId) : undefined;
  if (activeRun && !isTerminalRunStatus(activeRun.status)) {
    const message = `Thread already has an active run: ${activeRun.id}`;
    if (input.mode === "execute") {
      throw new HttpError(409, "thread_active", message);
    }
    warnings.push(message);
  }
  const activeTurnRun = anchor.sourceTurn?.activeRunId ? store.getRun(anchor.sourceTurn.activeRunId) : undefined;
  if (anchor.sourceTurn && isLingTurnActiveForResume(anchor.sourceTurn, activeTurnRun)) {
    const message = `Selected turn is not terminal: ${anchor.sourceTurn.id}`;
    if (input.mode === "execute") {
      throw new HttpError(409, "turn_active", message);
    }
    warnings.push(message);
  }
  const sourceRun = anchor.sourceRun;
  const requestSnapshot = isRecord(sourceRun.requestSnapshot) ? sourceRun.requestSnapshot : {};
  const taskSnapshot = isRecord(sourceRun.taskSnapshot) ? sourceRun.taskSnapshot : {};
  const instruction = isRecord(body)
    ? readOptionalString(body, "instruction")?.trim() || "Resume this Ling thread from durable evidence."
    : "Resume this Ling thread from durable evidence.";
  const idempotencyKey = isRecord(body)
    ? readOptionalString(body, "idempotencyKey") ?? `thread_resume:${thread.id}:${randomUUID()}`
    : `thread_resume:${thread.id}:${randomUUID()}`;
  const originalTitle =
    readSnapshotString(taskSnapshot, "title") ??
    readSnapshotString(isRecord(requestSnapshot.task) ? requestSnapshot.task : {}, "title") ??
    sourceRun.taskId;
  const originalPrompt =
    readSnapshotString(taskSnapshot, "prompt") ??
    readSnapshotString(isRecord(requestSnapshot.task) ? requestSnapshot.task : {}, "prompt") ??
    "";
  const providerPresetId = readSnapshotString(requestSnapshot, "providerPresetId") ?? sourceRun.providerPresetId;
  const inlineProvider = providerPresetId
    ? undefined
    : isRecord(requestSnapshot.provider) ? requestSnapshot.provider as unknown as PiRunnerProviderConfig : undefined;
  if (!providerPresetId && !inlineProvider) {
    throw new HttpError(400, "resume_snapshot_unavailable", "Cannot resume thread because the source run has no reusable provider snapshot.");
  }
  const context = buildResumeContextPreview({
    store,
    thread,
    sourceTurn: anchor.sourceTurn,
    sourceRun,
    originalTitle,
    originalPrompt,
    instruction,
    includeArtifacts: isRecord(body) ? readOptionalBoolean(body, "includeArtifacts") ?? false : false,
    warnings,
  });
  return {
    sourceRun,
    context,
    runRequest: {
      workspaceCwd: readSnapshotString(requestSnapshot, "workspaceCwd") ?? sourceRun.cwd,
      cwd: readSnapshotString(requestSnapshot, "cwd") ?? sourceRun.cwd,
      providerPresetId,
      provider: inlineProvider,
      teammateId: readSnapshotString(requestSnapshot, "teammateId") ?? sourceRun.teammateId,
      runnerId: readSnapshotString(requestSnapshot, "runnerId"),
      requestedSkillId: readSnapshotString(requestSnapshot, "requestedSkillId") ?? sourceRun.selectedSkillId,
      skipProviderPreflight: readSnapshotBoolean(requestSnapshot, "skipProviderPreflight") ?? false,
      idempotencyKey,
      task: {
        id: `manual_resume_${randomUUID()}`,
        title: `Resume: ${thread.title}`,
        prompt: context.contextText,
        channelId:
          thread.channelId ??
          readSnapshotString(taskSnapshot, "channelId") ??
          readSnapshotString(isRecord(requestSnapshot.task) ? requestSnapshot.task : {}, "channelId") ??
          sourceRun.channelId,
      },
      tools: readSnapshotRunTools(requestSnapshot, "tools"),
      approvalProfile: isRecord(requestSnapshot.approvalProfile) ? requestSnapshot.approvalProfile as unknown as SkillApprovalProfile : undefined,
      permissionPreset: readSnapshotPermissionPreset(requestSnapshot, "permissionPreset"),
      permissionMode: readSnapshotSessionPermissionMode(requestSnapshot, "permissionMode"),
      permissionConfirmation: readSnapshotPermissionConfirmation(requestSnapshot, "permissionConfirmation"),
      thinkingLevel: readSnapshotThinkingLevel(requestSnapshot, "thinkingLevel"),
      systemPrompt: readSnapshotString(requestSnapshot, "systemPrompt"),
      appendSystemPrompt: readSnapshotStringArray(requestSnapshot, "appendSystemPrompt"),
      agentDir: readSnapshotString(requestSnapshot, "agentDir"),
      parentRunId: sourceRun.id,
      continuationReason: "manual_resume",
    },
  };
}

function resolveThreadResumeAnchor(store: RunStore, thread: LingThread, body: unknown): ThreadResumeAnchor {
  const requestedTurnId = isRecord(body) ? readOptionalString(body, "turnId") : undefined;
  const requestedRunId = isRecord(body) ? readOptionalString(body, "sourceRunId") : undefined;
  if (!requestedTurnId) {
    return {
      sourceRun: resolveThreadResumeSourceRun(store, thread, requestedRunId ?? thread.lastRunId),
      warnings: [],
    };
  }

  const sourceTurn = store.getLingTurn(requestedTurnId);
  if (!sourceTurn) {
    throw new HttpError(404, "turn_not_found", `Ling turn not found: ${requestedTurnId}`);
  }
  if (sourceTurn.threadId !== thread.id) {
    throw new HttpError(400, "turn_not_in_thread", `Ling turn does not belong to thread: ${requestedTurnId}`);
  }

  const sourceRun = requestedRunId
    ? resolveThreadResumeSourceRun(store, thread, requestedRunId)
    : resolveThreadResumeSourceRunFromTurn(store, thread, sourceTurn);
  if (!isRunLinkedToTurn(store, sourceTurn, sourceRun)) {
    throw new HttpError(400, "source_run_not_in_turn", `Source run does not belong to turn: ${sourceRun.id}`);
  }
  return {
    sourceTurn,
    sourceRun,
    warnings: [],
  };
}

function resolveThreadResumeSourceRun(store: RunStore, thread: LingThread, sourceRunId: string | undefined): RunSession {
  if (!sourceRunId) {
    throw new HttpError(404, "source_run_not_found", "Thread has no source run to resume.");
  }
  const sourceRun = store.getRun(sourceRunId);
  if (!sourceRun) {
    throw new HttpError(404, "source_run_not_found", `Thread source run was not found: ${sourceRunId}`);
  }
  if (sourceRun.threadId !== thread.id) {
    throw new HttpError(400, "source_run_not_in_thread", `Source run does not belong to thread: ${sourceRunId}`);
  }
  return sourceRun;
}

function resolveThreadResumeSourceRunFromTurn(store: RunStore, thread: LingThread, turn: LingTurn): RunSession {
  const linkedRunIds = new Set(store.listLingTurnRuns(turn.id).map((link) => link.runId));
  const candidateIds = [
    turn.lastRunId,
    ...[...store.listLingTurnRuns(turn.id)]
      .sort((left, right) => right.attemptNumber - left.attemptNumber || right.createdAt.localeCompare(left.createdAt))
      .map((link) => link.runId),
  ].filter((id): id is string => Boolean(id));
  for (const candidateId of candidateIds) {
    const run = store.getRun(candidateId);
    if (!run || run.threadId !== thread.id) {
      continue;
    }
    if (run.id === turn.lastRunId || run.id === turn.activeRunId || linkedRunIds.has(run.id)) {
      return run;
    }
  }
  throw new HttpError(404, "source_run_not_found", `Ling turn has no source run to resume: ${turn.id}`);
}

function isRunLinkedToTurn(store: RunStore, turn: LingTurn, run: RunSession): boolean {
  return run.id === turn.lastRunId ||
    run.id === turn.activeRunId ||
    store.listLingTurnRuns(turn.id).some((link) => link.runId === run.id);
}

function buildResumeContextPreview(input: {
  readonly store: RunStore;
  readonly thread: LingThread;
  readonly sourceTurn?: LingTurn;
  readonly sourceRun: RunSession;
  readonly originalTitle: string;
  readonly originalPrompt: string;
  readonly instruction: string;
  readonly includeArtifacts: boolean;
  readonly warnings: readonly string[];
}): ResumeContextPreview {
  const scope = resolveResumeContextScope(input.store, input.thread, input.sourceTurn, input.sourceRun);
  const runs = scope.runs;
  const events = runs.flatMap((run) => input.store.listEvents(run.id, { limit: 1000 }));
  const approvals = uniqueById(runs.flatMap((run) => input.store.listApprovalRequests({ runId: run.id, limit: 500 })));
  const artifacts = input.includeArtifacts ? runs.flatMap((run) => input.store.listArtifacts(run.id)) : [];
  const scopedRunIds = new Set(runs.map((run) => run.id));
  const actions = listExecutionActions(input.store, { threadId: input.thread.id, limit: 500 })
    .filter((action) => !input.sourceTurn || !action.runId || scopedRunIds.has(action.runId));
  const pendingActionIds = actions
    .filter((action) => action.status === "proposed" || action.status === "waiting_for_approval" || action.status === "executing")
    .map((action) => action.id);
  const redactionNotes = input.includeArtifacts && artifacts.length > 0
    ? ["Artifact contents are omitted; preview includes artifact ids only."]
    : [];
  const context: Omit<ResumeContextPreview, "contextText"> = {
    title: `Resume: ${input.thread.title}`,
    instruction: input.instruction,
    sourceRunId: input.sourceRun.id,
    sourceTurnId: input.sourceTurn?.id,
    priorRunIds: runs.map((run) => run.id),
    priorTurnIds: scope.priorTurns?.map((turn) => turn.id),
    includedTurnCount: scope.priorTurns?.length,
    includedEventCount: events.length,
    includedApprovalCount: approvals.length,
    includedArtifactIds: artifacts.map((artifact) => artifact.id),
    pendingActionIds,
    redactionNotes,
    warnings: input.warnings,
  };
  return {
    ...context,
    contextText: renderResumeContextText({
      ...context,
      thread: input.thread,
      sourceRun: input.sourceRun,
      originalTitle: input.originalTitle,
      originalPrompt: input.originalPrompt,
      runs,
      sourceTurn: input.sourceTurn,
      priorTurns: scope.priorTurns,
      approvals,
      actions,
    }),
  };
}

function resolveResumeContextScope(
  store: RunStore,
  thread: LingThread,
  sourceTurn: LingTurn | undefined,
  sourceRun: RunSession,
): { readonly runs: readonly RunSession[]; readonly priorTurns?: readonly LingTurn[] } {
  const allRuns = [...store.listRuns({ threadId: thread.id, limit: 100 })]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  if (!sourceTurn) {
    return { runs: allRuns };
  }
  const turns = [...store.listLingTurns({ threadId: thread.id, limit: 500 })]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const sourceTurnIndex = turns.findIndex((turn) => turn.id === sourceTurn.id);
  const priorTurns = sourceTurnIndex >= 0 ? turns.slice(0, sourceTurnIndex + 1) : [sourceTurn];
  const priorTurnIds = new Set(priorTurns.map((turn) => turn.id));
  const scopedRunIds = new Set<string>([sourceRun.id]);
  for (const turn of priorTurns) {
    if (turn.activeRunId) {
      scopedRunIds.add(turn.activeRunId);
    }
    if (turn.lastRunId) {
      scopedRunIds.add(turn.lastRunId);
    }
  }
  for (const turnId of priorTurnIds) {
    for (const link of store.listLingTurnRuns(turnId)) {
      scopedRunIds.add(link.runId);
    }
  }
  const runs = allRuns.filter((run) => scopedRunIds.has(run.id));
  return {
    runs: runs.length > 0 ? runs : [sourceRun],
    priorTurns,
  };
}

function renderResumeContextText(input: Omit<ResumeContextPreview, "contextText"> & {
  readonly thread: LingThread;
  readonly sourceTurn?: LingTurn;
  readonly sourceRun: RunSession;
  readonly originalTitle: string;
  readonly originalPrompt: string;
  readonly runs: readonly RunSession[];
  readonly priorTurns?: readonly LingTurn[];
  readonly approvals: readonly ApprovalRequest[];
  readonly actions: ReturnType<typeof listExecutionActions>;
}): string {
  return [
    "Resume a Ling Stack thread from durable Ling state.",
    "",
    "Thread:",
    `Thread id: ${input.thread.id}`,
    `Kind: ${input.thread.kind}`,
    `Status: ${input.thread.status}`,
    `Title: ${input.thread.title}`,
    `Objective: ${input.thread.objective}`,
    "",
    "Resume instruction:",
    input.instruction,
    "",
    "Prior runs:",
    ...input.runs.map((run) =>
      `- ${run.id}: ${run.status}, ${run.startedAt ?? run.createdAt} -> ${run.endedAt ?? "open"}, runner ${runnerAuditLine(run)}`),
    "",
    ...(input.priorTurns ? [
      "Prior turns:",
      ...input.priorTurns.map((turn) => `- ${turn.id}: ${turn.status}, ${turn.title}`),
      "",
    ] : []),
    ...(input.sourceTurn ? [
      "Source turn:",
      `Turn id: ${input.sourceTurn.id}`,
      `Status: ${input.sourceTurn.status}`,
      `Kind: ${input.sourceTurn.kind}`,
      `Title: ${input.sourceTurn.title}`,
      "",
    ] : []),
    "Source run:",
    `Run id: ${input.sourceRun.id}`,
    `Status: ${input.sourceRun.status}`,
    `Provider: ${input.sourceRun.providerName}/${input.sourceRun.providerModel}`,
    input.sourceRun.selectedSkillId ? `Selected skill: ${input.sourceRun.selectedSkillId}` : undefined,
    input.sourceRun.startedAt ? `Started at: ${input.sourceRun.startedAt}` : undefined,
    input.sourceRun.endedAt ? `Ended at: ${input.sourceRun.endedAt}` : undefined,
    "",
    "Original task:",
    `Title: ${input.originalTitle}`,
    input.originalPrompt,
    "",
    "Recent terminal evidence:",
    `Included events: ${input.includedEventCount}`,
    `Included approvals: ${input.includedApprovalCount}`,
    `Included artifact ids: ${input.includedArtifactIds.length > 0 ? input.includedArtifactIds.join(", ") : "none"}`,
    "",
    "Pending actions:",
    ...(input.pendingActionIds.length > 0 ? input.pendingActionIds.map((id) => `- ${id}`) : ["- none"]),
    "",
    "Warnings:",
    ...(input.warnings.length > 0 ? input.warnings.map((warning) => `- ${warning}`) : ["- none"]),
    "",
    "Redaction notes:",
    ...(input.redactionNotes.length > 0 ? input.redactionNotes.map((note) => `- ${note}`) : ["- none"]),
    "",
    "Constraints:",
    "- Treat this as a new Ling-supervised continuation, not a native runner session resume.",
    "- Use durable thread/run evidence as hints only; re-check files or external state before side effects.",
    "- The resume instruction does not grant extra tools, approvals, secrets, MCP access, or external-send rights.",
  ].filter((line): line is string => line !== undefined).join("\n");
}

function runnerAuditLine(run: RunSession): string {
  const requestSnapshot = isRecord(run.requestSnapshot) ? run.requestSnapshot : {};
  const resolution = isRecord(requestSnapshot.runnerResolution) ? requestSnapshot.runnerResolution : {};
  const requested = readSnapshotString(resolution, "requestedRunnerId") ?? "unknown";
  const effective = readSnapshotString(resolution, "effectiveRunnerId") ?? requested;
  const source = readSnapshotString(resolution, "requestSource") ?? "legacy";
  return requested === effective ? `${effective} (${source})` : `${requested} -> ${effective} (${source})`;
}

function collectThreadStateTransitions(
  store: RunStore,
  thread: LingThread,
  runs: readonly RunSession[],
  approvalIds: ReadonlySet<string>,
): ReturnType<RunStore["listStateTransitionEvents"]> {
  const refs = new Map<string, { readonly entityType: "task" | "run" | "approval" | "workflow" | "workflow_step" | "work_unit"; readonly entityId: string }>();
  const addRef = (entityType: "task" | "run" | "approval" | "workflow" | "workflow_step" | "work_unit", entityId: string | undefined): void => {
    if (entityId) {
      refs.set(`${entityType}:${entityId}`, { entityType, entityId });
    }
  };
  addRef("task", thread.taskId);
  addRef("workflow", thread.workflowId);
  addRef("workflow_step", thread.workflowStepId);
  for (const run of runs) {
    addRef("run", run.id);
    addRef("task", run.taskId);
    addRef("work_unit", run.workUnitId);
  }
  for (const approvalId of approvalIds) {
    addRef("approval", approvalId);
  }
  return uniqueById(
    [...refs.values()].flatMap((ref) =>
      store.listStateTransitionEvents({ entityType: ref.entityType, entityId: ref.entityId, limit: 200 })),
  ).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

function isActionLinkedToThread(
  action: ReturnType<typeof listExecutionActions>[number],
  thread: LingThread,
  runIds: ReadonlySet<string>,
): boolean {
  if (action.threadId === thread.id || (action.runId && runIds.has(action.runId))) {
    return true;
  }
  return action.targetRefs.some((ref) =>
    (ref.type === "task" && ref.id === thread.taskId) ||
    (ref.type === "channel" && ref.id === thread.channelId) ||
    (ref.type === "workflow" && ref.id === thread.workflowId) ||
    (ref.type === "workflow_step" && ref.id === thread.workflowStepId));
}

function uniqueById<T extends { readonly id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function isTerminalRunStatus(status: RunSession["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function isLingTurnActiveForResume(turn: LingTurn, activeRun: RunSession | undefined): boolean {
  if (activeRun && !isTerminalRunStatus(activeRun.status)) {
    return true;
  }
  return turn.status === "open" || turn.status === "running" || turn.status === "waiting_for_approval" || turn.status === "blocked";
}

function isLingTurnTerminalForFork(turn: LingTurn, activeRun: RunSession | undefined): boolean {
  if (activeRun && !isTerminalRunStatus(activeRun.status)) {
    return false;
  }
  return turn.status === "succeeded" || turn.status === "failed" || turn.status === "cancelled" || turn.status === "superseded";
}

function readSnapshotString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readSnapshotBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readSnapshotStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function readSnapshotRunTools(record: Record<string, unknown>, key: string): RunTool[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value.filter(isRunTool) : undefined;
}

function readSnapshotSessionPermissionMode(record: Record<string, unknown>, key: string): SessionPermissionMode | undefined {
  const value = record[key];
  return typeof value === "string" && sessionPermissionModes.includes(value as SessionPermissionMode)
    ? value as SessionPermissionMode
    : undefined;
}

function readSnapshotPermissionPreset(record: Record<string, unknown>, key: string): PermissionPreset | undefined {
  const value = record[key];
  return typeof value === "string" && permissionPresets.includes(value as PermissionPreset)
    ? value as PermissionPreset
    : undefined;
}

function readSnapshotPermissionConfirmation(record: Record<string, unknown>, key: string): PermissionConfirmation | undefined {
  const value = record[key];
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    value.mode === "full_access" &&
    value.confirmed === true &&
    typeof value.confirmedAt === "string" &&
    typeof value.reason === "string"
  ) {
    return value as unknown as PermissionConfirmation;
  }
  return undefined;
}

function readSnapshotThinkingLevel(record: Record<string, unknown>, key: string): RunRequest["thinkingLevel"] {
  const value = record[key];
  return typeof value === "string" && ["off", "minimal", "low", "medium", "high", "xhigh"].includes(value)
    ? value as RunRequest["thinkingLevel"]
    : undefined;
}

function isRunTool(value: unknown): value is RunTool {
  return typeof value === "string" && ["read", "grep", "find", "ls", "bash", "edit", "write"].includes(value);
}

function parseCreateLingThreadBody(value: unknown): {
  readonly channelId: string;
  readonly title?: string;
  readonly objective?: string;
} {
  if (!isRecord(value)) {
    throw new HttpError(400, "bad_request", "Thread create request must be a JSON object.");
  }
  const kind = readOptionalString(value, "kind");
  if (kind && kind !== "channel_discussion") {
    throw new HttpError(400, "thread_kind_not_supported", "Only channel discussion branches can be created from /threads.");
  }
  const channelId = readString(value, "channelId").trim();
  if (!channelId) {
    throw new HttpError(400, "channel_required", "channelId is required.");
  }
  return {
    channelId,
    title: readOptionalString(value, "title")?.trim(),
    objective: readOptionalString(value, "objective")?.trim(),
  };
}

function parseUpdateConversationModeBody(value: unknown): { readonly mode: ConversationModeKind } {
  if (!isRecord(value)) {
    throw new HttpError(400, "bad_request", "Thread mode request must be a JSON object.");
  }
  const mode = readString(value, "mode").trim();
  if (!conversationModeKinds.includes(mode as ConversationModeKind)) {
    throw new HttpError(400, "bad_conversation_mode", `mode must be one of: ${conversationModeKinds.join(", ")}`);
  }
  return { mode: mode as ConversationModeKind };
}

function parsePutLingThreadGoalBody(value: unknown): {
  readonly objective: string;
  readonly tokenBudget?: number | null;
  readonly replaceExisting: boolean;
} {
  if (!isRecord(value)) {
    throw new HttpError(400, "bad_request", "Thread goal request must be a JSON object.");
  }
  const objective = readString(value, "objective").trim();
  if (!objective) {
    throw new HttpError(400, "goal_objective_required", "Goal objective is required.");
  }
  return {
    objective,
    tokenBudget: readOptionalGoalNumber(value, "tokenBudget", true),
    replaceExisting: readOptionalBoolean(value, "replaceExisting") ?? false,
  };
}

function parsePatchLingThreadGoalBody(value: unknown): UpdateLingThreadGoalInput {
  if (!isRecord(value)) {
    throw new HttpError(400, "bad_request", "Thread goal patch request must be a JSON object.");
  }
  const objective = readOptionalString(value, "objective")?.trim();
  if (objective !== undefined && !objective) {
    throw new HttpError(400, "goal_objective_required", "Goal objective cannot be empty.");
  }
  const status = readOptionalString(value, "status")?.trim();
  if (status && !lingThreadGoalStatuses.includes(status as LingThreadGoalStatus)) {
    throw new HttpError(400, "bad_goal_status", `status must be one of: ${lingThreadGoalStatuses.join(", ")}`);
  }
  if (status === "complete") {
    throw new HttpError(400, "goal_complete_action_required", "Use POST /threads/:threadId/goal/complete to complete a goal with evidence.");
  }
  return {
    objective,
    status: status as LingThreadGoalStatus | undefined,
    tokenBudget: readOptionalGoalNumber(value, "tokenBudget", true),
    tokensUsed: readOptionalGoalNumber(value, "tokensUsed", false) ?? undefined,
    timeUsedSeconds: readOptionalGoalNumber(value, "timeUsedSeconds", false) ?? undefined,
    lastRunId: readNullableStringField(value, "lastRunId"),
    blockedReason: readNullableStringField(value, "blockedReason"),
    completionEvidenceRefs: readOptionalGoalEvidenceRefs(value, "completionEvidenceRefs"),
    usageSource: readOptionalGoalUsageSource(value, "usageSource"),
  };
}

function parseCompleteLingThreadGoalBody(value: unknown): {
  readonly actor: LingThreadGoalCompletionActor;
  readonly reason?: string;
  readonly evidenceRefs: readonly GoalEvidenceRef[];
  readonly completionVerificationSummary?: string;
} {
  if (value === undefined || value === null) {
    return {
      actor: "local-user",
      evidenceRefs: [],
    };
  }
  if (!isRecord(value)) {
    throw new HttpError(400, "bad_request", "Goal completion request must be a JSON object.");
  }
  const actor = readOptionalGoalCompletionActor(value, "actor") ?? "local-user";
  const reason = readOptionalString(value, "reason")?.trim() || undefined;
  const evidenceRefs = readOptionalGoalEvidenceRefs(value, "evidenceRefs") ?? [];
  const completionVerificationSummary = readOptionalString(value, "completionVerificationSummary")?.trim() || undefined;
  if (actor === "ling-agent" && evidenceRefs.length === 0) {
    throw new HttpError(400, "goal_completion_evidence_required", "Ling Agent completion requires evidence refs.");
  }
  if (actor === "ling-agent" && !completionVerificationSummary) {
    throw new HttpError(400, "goal_completion_summary_required", "Ling Agent completion requires a verification summary.");
  }
  return {
    actor,
    reason,
    evidenceRefs,
    completionVerificationSummary,
  };
}

const lingThreadGoalStatuses = [
  "active",
  "paused",
  "blocked",
  "usage_limited",
  "budget_limited",
  "complete",
  "cleared",
  "replaced",
] as const satisfies readonly LingThreadGoalStatus[];

const proposedPlanArtifactStatuses = [
  "draft",
  "accepted",
  "superseded",
  "archived",
] as const satisfies readonly ProposedPlanArtifactStatus[];

const lingThreadGoalCompletionActors = [
  "local-user",
  "ling-agent",
] as const satisfies readonly LingThreadGoalCompletionActor[];

const goalUsageSources = [
  "provider",
  "estimated",
  "mixed",
] as const satisfies readonly GoalUsageSource[];

interface ProposedPlanActionInput {
  readonly plan?: CreateProposedPlanArtifactInput;
  readonly createdBy?: string;
  readonly toParticipantId?: string;
  readonly toParticipantLabel?: string;
  readonly workflowTitle?: string;
  readonly workflowSteps?: readonly string[];
}

function parsePutProposedPlanArtifactBody(value: unknown, threadId: string): CreateProposedPlanArtifactInput {
  if (!isRecord(value)) {
    throw new HttpError(400, "bad_request", "Proposed plan request must be a JSON object.");
  }
  const title = readString(value, "title").trim();
  const bodyMarkdown = readString(value, "bodyMarkdown").trim();
  if (!title) {
    throw new HttpError(400, "proposed_plan_title_required", "Proposed plan title is required.");
  }
  if (!bodyMarkdown) {
    throw new HttpError(400, "proposed_plan_body_required", "Proposed plan bodyMarkdown is required.");
  }
  return {
    id: readOptionalString(value, "id")?.trim(),
    threadId,
    channelId: readNullableStringField(value, "channelId") ?? undefined,
    goalId: readNullableStringField(value, "goalId") ?? undefined,
    sourceAgentId: readNullableStringField(value, "sourceAgentId") ?? undefined,
    ownerAgentId: readNullableStringField(value, "ownerAgentId") ?? undefined,
    sourceTurnId: readNullableStringField(value, "sourceTurnId") ?? undefined,
    sourceMessageId: readNullableStringField(value, "sourceMessageId") ?? undefined,
    sourceRunId: readNullableStringField(value, "sourceRunId") ?? undefined,
    parentPlanId: readNullableStringField(value, "parentPlanId") ?? undefined,
    supersededByPlanId: readNullableStringField(value, "supersededByPlanId") ?? undefined,
    planGroupId: readNullableStringField(value, "planGroupId") ?? undefined,
    version: readOptionalPlanVersion(value, "version") ?? undefined,
    title,
    bodyMarkdown,
    status: readOptionalProposedPlanStatus(value),
    archivedAt: readNullableStringField(value, "archivedAt") ?? undefined,
    archivedReason: readNullableStringField(value, "archivedReason") ?? undefined,
  };
}

function parsePatchProposedPlanArtifactBody(value: unknown): UpdateProposedPlanArtifactInput {
  if (!isRecord(value)) {
    throw new HttpError(400, "bad_request", "Proposed plan patch request must be a JSON object.");
  }
  const title = readOptionalString(value, "title")?.trim();
  const bodyMarkdown = readOptionalString(value, "bodyMarkdown")?.trim();
  if (title !== undefined && !title) {
    throw new HttpError(400, "proposed_plan_title_required", "Proposed plan title cannot be empty.");
  }
  if (bodyMarkdown !== undefined && !bodyMarkdown) {
    throw new HttpError(400, "proposed_plan_body_required", "Proposed plan bodyMarkdown cannot be empty.");
  }
  return {
    channelId: readNullableStringField(value, "channelId"),
    goalId: readNullableStringField(value, "goalId"),
    sourceAgentId: readNullableStringField(value, "sourceAgentId"),
    ownerAgentId: readNullableStringField(value, "ownerAgentId"),
    sourceTurnId: readNullableStringField(value, "sourceTurnId"),
    sourceMessageId: readNullableStringField(value, "sourceMessageId"),
    sourceRunId: readNullableStringField(value, "sourceRunId"),
    parentPlanId: readNullableStringField(value, "parentPlanId"),
    supersededByPlanId: readNullableStringField(value, "supersededByPlanId"),
    planGroupId: readNullableStringField(value, "planGroupId"),
    version: readOptionalPlanVersion(value, "version"),
    title,
    bodyMarkdown,
    status: readOptionalProposedPlanStatus(value),
    savedAt: readNullableStringField(value, "savedAt"),
    acceptedAt: readNullableStringField(value, "acceptedAt"),
    convertedAt: readNullableStringField(value, "convertedAt"),
    archivedAt: readNullableStringField(value, "archivedAt"),
    archivedReason: readNullableStringField(value, "archivedReason"),
    acceptedTaskId: readNullableStringField(value, "acceptedTaskId"),
    acceptedWorkflowId: readNullableStringField(value, "acceptedWorkflowId"),
    acceptedWorkflowStepId: readNullableStringField(value, "acceptedWorkflowStepId"),
    acceptedRunId: readNullableStringField(value, "acceptedRunId"),
  };
}

function parseProposedPlanActionBody(value: unknown): ProposedPlanActionInput {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new HttpError(400, "bad_request", "Proposed plan action request must be a JSON object.");
  }
  const plan = isRecord(value.plan) ? parsePutProposedPlanArtifactBody(value.plan, readThreadIdForActionPlan(value.plan)) : undefined;
  return {
    plan,
    createdBy: readOptionalString(value, "createdBy")?.trim() || undefined,
    toParticipantId: readOptionalString(value, "toParticipantId")?.trim() || undefined,
    toParticipantLabel: readOptionalString(value, "toParticipantLabel")?.trim() || undefined,
    workflowTitle: readOptionalString(value, "workflowTitle")?.trim() || undefined,
    workflowSteps: readOptionalWorkflowSteps(value, "workflowSteps"),
  };
}

function readThreadIdForActionPlan(value: Record<string, unknown>): string {
  const threadId = readOptionalString(value, "threadId")?.trim();
  return threadId || "__route_thread__";
}

function readOptionalProposedPlanStatus(record: Record<string, unknown>): ProposedPlanArtifactStatus | undefined {
  const status = readOptionalString(record, "status")?.trim();
  if (!status) {
    return undefined;
  }
  if (!proposedPlanArtifactStatuses.includes(status as ProposedPlanArtifactStatus)) {
    throw new HttpError(400, "bad_proposed_plan_status", `status must be one of: ${proposedPlanArtifactStatuses.join(", ")}`);
  }
  return status as ProposedPlanArtifactStatus;
}

function upsertProposedPlanForAction(
  store: RunStore,
  threadId: string,
  planId: string,
  input: CreateProposedPlanArtifactInput | undefined,
  now: string,
): ProposedPlanArtifact {
  const existing = store.getProposedPlanArtifact(planId);
  if (existing && existing.threadId !== threadId) {
    throw new HttpError(404, "proposed_plan_not_found", `Proposed plan not found: ${planId}`);
  }
  if (input) {
    return store.upsertProposedPlanArtifact({ ...input, id: planId, threadId }, now);
  }
  if (!existing) {
    throw new HttpError(404, "proposed_plan_not_found", `Proposed plan not found: ${planId}`);
  }
  return existing;
}

function assertProposedPlanDirectMutationAllowed(
  existing: ProposedPlanArtifact | undefined,
  input?: UpdateProposedPlanArtifactInput,
): void {
  if (!existing || existing.status !== "accepted") {
    return;
  }
  const mutatesAcceptedContent = input === undefined ||
    input.title !== undefined ||
    input.bodyMarkdown !== undefined ||
    (input.status !== undefined && input.status !== "accepted");
  if (mutatesAcceptedContent) {
    throw new HttpError(
      409,
      "accepted_plan_immutable",
      "Accepted proposed plans are immutable. Create a refined plan version instead of overwriting the accepted record.",
    );
  }
}

function applyProposedPlanAction(
  store: RunStore,
  thread: LingThread,
  plan: ProposedPlanArtifact,
  action: "accept" | "refine" | "save" | "convert-workflow" | "archive",
  input: ProposedPlanActionInput,
  now: string,
): {
  readonly plan: ProposedPlanArtifact;
  readonly taskId?: string;
  readonly workflowId?: string;
  readonly workflowStepId?: string;
  readonly runId?: string;
} {
  if (action === "save") {
    return { plan: requireUpdatedProposedPlan(store, plan.id, { savedAt: now }, now) };
  }
  if (action === "archive") {
    return { plan: requireUpdatedProposedPlan(store, plan.id, { status: "archived", archivedAt: now }, now) };
  }
  if (action === "refine") {
    return { plan: requireUpdatedProposedPlan(store, plan.id, { status: "draft" }, now) };
  }
  if (action === "accept") {
    if (!thread.channelId) {
      throw new HttpError(409, "proposed_plan_channel_required", "Accepting a proposed plan requires a channel thread.");
    }
    if (plan.acceptedTaskId) {
      return { plan, taskId: plan.acceptedTaskId, runId: plan.acceptedRunId };
    }
    const task = store.createTask(
      {
        channelId: thread.channelId,
        title: `Implement accepted plan: ${plan.title}`,
        prompt: [
          `Implement accepted plan: ${plan.title}`,
          "",
          plan.bodyMarkdown,
          "",
          `Source proposed plan: ${plan.id}`,
          plan.sourceMessageId ? `Source message: ${plan.sourceMessageId}` : "",
        ].filter(Boolean).join("\n"),
        requestedSkillId: "plan-acceptance",
      },
      now,
    );
    return {
      plan: requireUpdatedProposedPlan(store, plan.id, {
        status: "accepted",
        acceptedAt: now,
        acceptedTaskId: task.id,
      }, now),
      taskId: task.id,
    };
  }
  if (!thread.channelId) {
    throw new HttpError(409, "proposed_plan_channel_required", "Converting a proposed plan requires a channel thread.");
  }
  if (plan.acceptedWorkflowId) {
    return {
      plan,
      workflowId: plan.acceptedWorkflowId,
      workflowStepId: plan.acceptedWorkflowStepId,
      runId: plan.acceptedRunId,
    };
  }
  const createdBy = input.createdBy || "local-user";
  const workflowTitle = input.workflowTitle || plan.title;
  const workflowSteps = input.workflowSteps && input.workflowSteps.length > 0 ? input.workflowSteps : [plan.bodyMarkdown];
  const workflow = store.createChannelWorkflow(
    {
      channelId: thread.channelId,
      title: workflowTitle,
      objective: workflowSteps.join("\n"),
      status: "draft",
      createdBy,
      metadata: {
        sourceMessageId: plan.sourceMessageId,
      },
    },
    now,
  );
  const workflowStep = store.createChannelWorkflowStep(
    {
      workflowId: workflow.id,
      title: workflowSteps.length > 1 ? workflowSteps[0] : `Implement ${workflowTitle}`,
      prompt: [
        workflowSteps.join("\n"),
        "",
        `Source proposed plan: ${plan.id}`,
        plan.sourceMessageId ? `Source message: ${plan.sourceMessageId}` : "",
      ].filter(Boolean).join("\n"),
      toParticipantId: input.toParticipantId || "local-user",
      toParticipantLabel: input.toParticipantLabel || "Local user",
      status: "queued",
      metadata: {
        sourceMessageId: plan.sourceMessageId,
      },
    },
    now,
  );
  return {
    plan: requireUpdatedProposedPlan(store, plan.id, {
      status: "accepted",
      acceptedAt: plan.acceptedAt ?? now,
      convertedAt: now,
      acceptedWorkflowId: workflow.id,
      acceptedWorkflowStepId: workflowStep.id,
    }, now),
    workflowId: workflow.id,
    workflowStepId: workflowStep.id,
  };
}

function requireUpdatedProposedPlan(
  store: RunStore,
  planId: string,
  input: UpdateProposedPlanArtifactInput,
  now: string,
): ProposedPlanArtifact {
  const plan = store.updateProposedPlanArtifact(planId, input, now);
  if (!plan) {
    throw new HttpError(404, "proposed_plan_not_found", `Proposed plan not found: ${planId}`);
  }
  return plan;
}

function readOptionalGoalNumber(
  record: Record<string, unknown>,
  key: string,
  nullable: boolean,
): number | null | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === null && nullable) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new HttpError(400, "bad_goal_number", `${key} must be a non-negative integer${nullable ? " or null" : ""}.`);
  }
  return value;
}

function readNullableStringField(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, "bad_goal_field", `${key} must be a string or null.`);
  }
  return value.trim() || null;
}

function readOptionalGoalEvidenceRefs(record: Record<string, unknown>, key: string): readonly GoalEvidenceRef[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new HttpError(400, "bad_goal_evidence", `${key} must be an array.`);
  }
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new HttpError(400, "bad_goal_evidence", "Goal evidence refs must be objects.");
    }
    const kind = readString(item, "kind").trim();
    const id = readString(item, "id").trim();
    if (!goalEvidenceKinds.includes(kind as GoalEvidenceRef["kind"]) || !id) {
      throw new HttpError(400, "bad_goal_evidence", "Goal evidence refs must include a supported kind and non-empty id.");
    }
    return { kind: kind as GoalEvidenceRef["kind"], id };
  });
}

function readOptionalWorkflowSteps(record: Record<string, unknown>, key: string): readonly string[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new HttpError(400, "bad_workflow_steps", `${key} must be an array.`);
  }
  const steps = value
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter(Boolean)
    .slice(0, 50);
  return steps.length > 0 ? steps : undefined;
}

function mergeGoalEvidenceRefs(
  existing: readonly GoalEvidenceRef[],
  next: readonly GoalEvidenceRef[],
): readonly GoalEvidenceRef[] {
  const seen = new Set(existing.map((ref) => `${ref.kind}:${ref.id}`));
  const merged = [...existing];
  for (const ref of next) {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(ref);
  }
  return merged;
}

function readOptionalGoalCompletionActor(record: Record<string, unknown>, key: string): LingThreadGoalCompletionActor | undefined {
  const value = readOptionalString(record, key)?.trim();
  if (!value) {
    return undefined;
  }
  if (!lingThreadGoalCompletionActors.includes(value as LingThreadGoalCompletionActor)) {
    throw new HttpError(400, "bad_goal_completion_actor", `${key} must be one of: ${lingThreadGoalCompletionActors.join(", ")}`);
  }
  return value as LingThreadGoalCompletionActor;
}

function readOptionalGoalUsageSource(record: Record<string, unknown>, key: string): GoalUsageSource | undefined {
  const value = readOptionalString(record, key)?.trim();
  if (!value) {
    return undefined;
  }
  if (!goalUsageSources.includes(value as GoalUsageSource)) {
    throw new HttpError(400, "bad_goal_usage_source", `${key} must be one of: ${goalUsageSources.join(", ")}`);
  }
  return value as GoalUsageSource;
}

function readOptionalPlanVersion(record: Record<string, unknown>, key: string): number | null | undefined {
  return readOptionalGoalNumber(record, key, true);
}

const goalEvidenceKinds = ["run", "turn", "artifact", "approval", "workflow"] as const;

function findActiveChannelDiscussionRootThread(store: RunStore, channelId: string): LingThread | undefined {
  return store
    .listLingThreads({ kind: "channel_discussion", channelId, archived: "exclude", limit: 100 })
    .find((thread) =>
      !thread.parentThreadId &&
      !thread.taskId &&
      !thread.teammateId &&
      !thread.workflowId &&
      !thread.workflowStepId &&
      !thread.externalWorkId
    );
}

function readOptionalLingThreadKindQuery(url: URL): LingThreadKind | undefined {
  const value = url.searchParams.get("kind");
  if (value === null) {
    return undefined;
  }
  if (!lingThreadKinds.includes(value as LingThreadKind)) {
    throw new Error(`kind must be one of: ${lingThreadKinds.join(", ")}`);
  }
  return value as LingThreadKind;
}

function readOptionalLingThreadStatusQuery(url: URL): LingThreadStatus | undefined {
  const value = url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (!["open", "running", "waiting_for_approval", "blocked", "succeeded", "failed", "cancelled", "archived"].includes(value)) {
    throw new Error("status must be one of: open, running, waiting_for_approval, blocked, succeeded, failed, cancelled, archived");
  }
  return value as LingThreadStatus;
}

function readOptionalLingThreadSearchQuery(url: URL): string | undefined {
  const value = url.searchParams.get("q");
  if (value === null) {
    return undefined;
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < 2) {
    throw new HttpError(400, "search_query_too_short", "q must include at least two visible characters");
  }
  if (normalized.length > 128) {
    throw new HttpError(400, "search_query_too_long", "q must be at most 128 characters");
  }
  return normalized;
}

function readOptionalLingThreadArchivedFilterQuery(url: URL): LingThreadArchivedFilter | undefined {
  const value = url.searchParams.get("archived");
  if (value === null) {
    return undefined;
  }
  if (value !== "exclude" && value !== "include" && value !== "only") {
    throw new HttpError(400, "bad_archived_filter", "archived must be one of: exclude, include, only");
  }
  return value;
}
