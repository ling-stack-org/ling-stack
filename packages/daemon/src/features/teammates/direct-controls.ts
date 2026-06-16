import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AiTeammate,
  ChannelMessageFileRef,
  RunStore,
  SecretResolver,
  TeammateDirectMessage,
  TeammateDirectReplyIntervention,
  TeammateDirectReplyInterventionMessagePayload,
  TeammateDirectReplyInterventionMode,
  TeammateDirectThread,
  WorkUnit,
  WorkUnitStatus,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunControlService } from "../../run-control.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import type { RuntimeSupervisor } from "../../runtime/supervisor.js";
import type { ProviderStartupRefreshService } from "../providers/startup-refresh.js";
import { readJsonBody, readOptionalJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { isRecord, readOptionalStringArray } from "../../shared/validation.js";
import { readOptionalChannelMessageFileRefs } from "../channels/schemas.js";
import { createAiTeammateDirectReply } from "./direct-replies.js";
import type { ActiveDirectReplyRegistry } from "./direct-reply-active-registry.js";
import { assertDirectFileRefsWithinWorkspace, ensureDirectWorkspaceReady } from "./direct-workspace.js";

export interface TeammateDirectRuntimeSnapshot {
  readonly teammateId: string;
  readonly thread: TeammateDirectThread;
  readonly activeReply?: {
    readonly status: "running" | "cancelling";
    readonly workUnitId: string;
    readonly messageId: string;
    readonly sourceMessageId: string;
    readonly workUnit: WorkUnit;
    readonly message?: TeammateDirectMessage;
  };
  readonly interventions: readonly TeammateDirectReplyIntervention[];
}

export class DirectReplyControlService {
  constructor(
    private readonly dependencies: {
      readonly runnerRegistry: RunnerRegistry;
      readonly runtimeSupervisor: RuntimeSupervisor;
      readonly secretResolver: SecretResolver;
      readonly activeDirectReplies: ActiveDirectReplyRegistry;
      readonly runControl: RunControlService;
      readonly providerStartupRefresh: ProviderStartupRefreshService;
    },
  ) {}

  getRuntime(input: { readonly store: RunStore; readonly teammateId: string }): TeammateDirectRuntimeSnapshot {
    const teammate = this.requireTeammate(input.store, input.teammateId);
    const thread = input.store.getOrCreateTeammateDirectThread(teammate.id, new Date().toISOString());
    return {
      teammateId: teammate.id,
      thread,
      activeReply: this.findActiveReply(input.store, teammate.id, thread.id),
      interventions: this.listOpenInterventions(input.store, teammate.id, thread.id),
    };
  }

  cancelReply(input: { readonly store: RunStore; readonly workUnitId: string; readonly reason?: string }): {
    readonly workUnit: WorkUnit;
    readonly message?: TeammateDirectMessage;
  } {
    const workUnit = input.store.getWorkUnit(input.workUnitId);
    if (!workUnit || workUnit.kind !== "teammate_direct_reply") {
      throw new Error(`Direct reply work unit not found: ${input.workUnitId}`);
    }
    const active = this.dependencies.activeDirectReplies.get(workUnit.id);
    const cancellation = this.dependencies.runControl.cancelWorkUnit({
      store: input.store,
      workUnit,
      reason: input.reason ?? "direct_reply_cancelled",
      activeRun: active ? { abortController: active.abortController, streamEnvelope: () => undefined } : undefined,
    });
    this.dependencies.activeDirectReplies.delete(workUnit.id);
    const message = this.markLinkedMessageCancelled(input.store, cancellation.workUnit, "回复已停止");
    return { workUnit: cancellation.workUnit, message };
  }

  createIntervention(input: {
    readonly store: RunStore;
    readonly teammateId: string;
    readonly mode: TeammateDirectReplyInterventionMode;
    readonly instruction: string;
    readonly messagePayload?: TeammateDirectReplyInterventionMessagePayload;
    readonly idempotencyKey?: string;
  }): TeammateDirectReplyIntervention {
    const teammate = this.requireTeammate(input.store, input.teammateId);
    const thread = input.store.getOrCreateTeammateDirectThread(teammate.id, new Date().toISOString());
    const active = this.findActiveReply(input.store, teammate.id, thread.id);
    if (!active) {
      throw new Error("当前没有正在回复的私聊消息。");
    }
    if (input.messagePayload?.fileRefs?.length) {
      assertDirectFileRefsWithinWorkspace({
        thread,
        workspaceCwd: input.store.paths.cwd,
        fileRefs: input.messagePayload.fileRefs,
      });
    }
    const now = new Date().toISOString();
    const intervention = input.store.createTeammateDirectReplyIntervention(
      {
        teammateId: teammate.id,
        threadId: thread.id,
        sourceMessageId: active.sourceMessageId,
        sourceWorkUnitId: active.workUnitId,
        mode: input.mode,
        instruction: input.instruction,
        messagePayload: input.messagePayload,
        idempotencyKey: input.idempotencyKey ?? `direct-intervention:${active.workUnitId}:${input.mode}:${input.instruction}`,
        requestedBy: "local-user",
      },
      now,
    );
    if (input.mode === "interrupt_redirect") {
      const cancelling = input.store.updateTeammateDirectReplyInterventionStatus({
        interventionId: intervention.id,
        status: "cancelling_source",
        startedAt: now,
        now,
      }) ?? intervention;
      this.cancelReply({ store: input.store, workUnitId: active.workUnitId, reason: "interrupt_redirect" });
      void this.startContinuation({
        store: input.store,
        teammate,
        thread,
        intervention: cancelling,
      });
      return input.store.getTeammateDirectReplyIntervention(intervention.id) ?? cancelling;
    }
    return intervention;
  }

  cancelIntervention(input: { readonly store: RunStore; readonly interventionId: string; readonly reason?: string }): TeammateDirectReplyIntervention {
    const cancelled = input.store.cancelTeammateDirectReplyIntervention(
      input.interventionId,
      new Date().toISOString(),
      input.reason ?? "cancelled_by_user",
    );
    if (!cancelled) {
      throw new Error(`Direct reply intervention not found: ${input.interventionId}`);
    }
    return cancelled;
  }

  promoteIntervention(input: {
    readonly store: RunStore;
    readonly interventionId: string;
    readonly reason?: string;
  }): { readonly intervention: TeammateDirectReplyIntervention; readonly message?: string } {
    const intervention = input.store.getTeammateDirectReplyIntervention(input.interventionId);
    if (!intervention) {
      throw new HttpError(404, "direct_intervention_not_found", `Direct reply intervention not found: ${input.interventionId}`);
    }
    if (intervention.status !== "queued") {
      throw new HttpError(409, "direct_intervention_not_queued", "只有已排队的引导可以立即执行。");
    }
    const teammate = this.requireTeammate(input.store, intervention.teammateId);
    const thread = input.store.getOrCreateTeammateDirectThread(teammate.id, new Date().toISOString());
    const active = this.findActiveReply(input.store, teammate.id, intervention.threadId);
    if (!active) {
      const now = new Date().toISOString();
      const starting = input.store.updateTeammateDirectReplyInterventionStatus({
        interventionId: intervention.id,
        status: "starting_continuation",
        startedAt: intervention.startedAt ?? now,
        now,
      }) ?? intervention;
      queueMicrotask(() => {
        void this.startContinuation({
          store: input.store,
          teammate,
          thread,
          intervention: starting,
        });
      });
      return {
        intervention: input.store.getTeammateDirectReplyIntervention(intervention.id) ?? starting,
        message: "当前回复已结束，已开始执行这条引导。",
      };
    }
    const now = new Date().toISOString();
    const cancelling = input.store.updateTeammateDirectReplyInterventionStatus({
      interventionId: intervention.id,
      status: "cancelling_source",
      startedAt: now,
      now,
    }) ?? intervention;
    this.cancelReply({
      store: input.store,
      workUnitId: active.workUnitId,
      reason: input.reason ?? "promote_queued_guidance",
    });
    queueMicrotask(() => {
      void this.startContinuation({
        store: input.store,
        teammate,
        thread,
        intervention: cancelling,
      });
    });
    return {
      intervention: input.store.getTeammateDirectReplyIntervention(intervention.id) ?? cancelling,
    };
  }

  async maybeStartNextQueuedContinuation(input: { readonly store: RunStore; readonly teammateId: string; readonly threadId: string; readonly sourceWorkUnitId?: string }): Promise<void> {
    if (this.findActiveReply(input.store, input.teammateId, input.threadId)) {
      return;
    }
    const candidates = input.store
      .listTeammateDirectReplyInterventions({
        teammateId: input.teammateId,
        threadId: input.threadId,
        status: "queued",
        limit: 100,
      })
      .filter((intervention) => intervention.mode === "queue_followup");
    const next = candidates[0];
    if (!next) {
      return;
    }
    const teammate = this.requireTeammate(input.store, input.teammateId);
    const thread = input.store.getOrCreateTeammateDirectThread(teammate.id, new Date().toISOString());
    await this.startContinuation({ store: input.store, teammate, thread, intervention: next });
  }

  private async startContinuation(input: {
    readonly store: RunStore;
    readonly teammate: AiTeammate;
    readonly thread: TeammateDirectThread;
    readonly intervention: TeammateDirectReplyIntervention;
  }): Promise<void> {
    const now = new Date().toISOString();
    const starting = input.store.updateTeammateDirectReplyInterventionStatus({
      interventionId: input.intervention.id,
      status: "starting_continuation",
      startedAt: input.intervention.startedAt ?? now,
      now,
    });
    if (!starting || starting.status === "cancelled" || starting.status === "failed" || starting.status === "started") {
      return;
    }
    try {
      const workspace = await ensureDirectWorkspaceReady({
        store: input.store,
        thread: input.thread,
        workspaceCwd: input.store.paths.cwd,
      });
      if (!workspace.ok) {
        throw new Error(workspace.message);
      }
      const guidance = input.store.createTeammateDirectMessage(
        {
          threadId: workspace.workspace.thread.id,
          teammateId: input.teammate.id,
          authorType: "system",
          authorId: "system",
          body: renderDirectGuidanceMessage(starting),
          attachmentIds: starting.messagePayload?.attachmentIds ?? [],
          linkPreviewIds: starting.messagePayload?.linkPreviewIds ?? [],
          fileRefs: starting.messagePayload?.fileRefs ?? [],
          status: "ready",
        },
        now,
      );
      const abortController = new AbortController();
      let continuationWorkUnitId: string | undefined;
      await this.dependencies.providerStartupRefresh.refreshBeforeRun({
        cwd: input.store.paths.cwd,
        store: input.store,
        providerPresetId: input.teammate.providerPresetId,
      });
      const reply = await createAiTeammateDirectReply({
        runnerRegistry: this.dependencies.runnerRegistry,
        store: input.store,
        teammate: input.teammate,
        thread: workspace.workspace.thread,
        sourceMessage: guidance,
        providerPresetId: input.teammate.providerPresetId,
        workspace: workspace.workspace,
        runtimeSupervisor: this.dependencies.runtimeSupervisor,
        secretResolver: this.dependencies.secretResolver,
        signal: abortController.signal,
        onWorkUnitStarted: (handle) => {
          continuationWorkUnitId = handle.workUnitId;
          this.dependencies.activeDirectReplies.register({ ...handle, abortController });
        },
      });
      const workUnit = continuationWorkUnitId
        ? input.store.getWorkUnit(continuationWorkUnitId)
        : input.store.listWorkUnits({ kind: "teammate_direct_reply", linkedMessageId: reply.id, limit: 1 })[0];
      input.store.updateTeammateDirectReplyInterventionStatus({
        interventionId: starting.id,
        status: "started",
        continuationMessageId: reply.id,
        continuationWorkUnitId: workUnit?.id ?? starting.continuationWorkUnitId,
        completedAt: new Date().toISOString(),
        now: new Date().toISOString(),
      });
      if (workUnit) {
        this.dependencies.activeDirectReplies.delete(workUnit.id);
      }
      await this.maybeStartNextQueuedContinuation({
        store: input.store,
        teammateId: input.teammate.id,
        threadId: workspace.workspace.thread.id,
      });
    } catch (error) {
      input.store.updateTeammateDirectReplyInterventionStatus({
        interventionId: starting.id,
        status: "failed",
        completedAt: new Date().toISOString(),
        failureReason: error instanceof Error ? error.message : String(error),
        now: new Date().toISOString(),
      });
    }
  }

  private findActiveReply(store: RunStore, teammateId: string, threadId: string): TeammateDirectRuntimeSnapshot["activeReply"] {
    const activeUnits = store
      .listWorkUnits({ kind: "teammate_direct_reply", teammateId, limit: 500 })
      .filter((workUnit) => isActiveDirectReplyStatus(workUnit.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const workUnit of activeUnits) {
      if (!workUnit.linkedMessageId) {
        continue;
      }
      const message = store.getTeammateDirectMessage(workUnit.linkedMessageId);
      if (!message || message.threadId !== threadId || message.teammateId !== teammateId) {
        continue;
      }
      return {
        status: workUnit.status === "cancelling" ? "cancelling" : "running",
        workUnitId: workUnit.id,
        messageId: message.id,
        sourceMessageId: workUnit.ownerId,
        workUnit,
        message,
      };
    }
    return undefined;
  }

  private listOpenInterventions(store: RunStore, teammateId: string, threadId: string): readonly TeammateDirectReplyIntervention[] {
    return store
      .listTeammateDirectReplyInterventions({ teammateId, threadId, limit: 100 })
      .filter((intervention) => intervention.status !== "started" && intervention.status !== "cancelled" && intervention.status !== "failed");
  }

  private markLinkedMessageCancelled(store: RunStore, workUnit: WorkUnit, fallbackBody: string): TeammateDirectMessage | undefined {
    if (!workUnit.linkedMessageId) {
      return undefined;
    }
    const current = store.getTeammateDirectMessage(workUnit.linkedMessageId);
    if (!current) {
      return undefined;
    }
    return store.updateTeammateDirectMessageRuntime(
      current.id,
      {
        body: current.body.trim() || fallbackBody,
        status: "cancelled",
        errorMessage: fallbackBody,
      },
      new Date().toISOString(),
    );
  }

  private requireTeammate(store: RunStore, teammateId: string): AiTeammate {
    const teammate = store.getAiTeammate(teammateId);
    if (!teammate) {
      throw new Error(`AI teammate not found: ${teammateId}`);
    }
    return teammate;
  }
}

function isActiveDirectReplyStatus(status: WorkUnitStatus): boolean {
  return status === "claimed" || status === "running" || status === "waiting_for_approval" || status === "cancelling";
}

function renderDirectGuidanceMessage(intervention: TeammateDirectReplyIntervention): string {
  const payload = intervention.messagePayload;
  const body = payload?.body.trim() || intervention.instruction;
  const details = [
    payload?.attachmentIds.length ? `附件：${payload.attachmentIds.join(", ")}` : undefined,
    payload?.linkPreviewIds.length ? `链接：${payload.linkPreviewIds.join(", ")}` : undefined,
    payload?.fileRefs?.length ? `文件：${payload.fileRefs.map(renderDirectGuidanceFileRef).join(", ")}` : undefined,
  ].filter((line): line is string => Boolean(line));
  const detailSummary = details.length > 0 ? `\n${details.join("\n")}` : "";
  if (intervention.mode === "interrupt_redirect") {
    return `已停止上一条回复，并按新引导继续：${body}${detailSummary}`;
  }
  return `排队引导：${body}${detailSummary}`;
}

function renderDirectGuidanceFileRef(fileRef: ChannelMessageFileRef): string {
  const line = fileRef.line ? `:${fileRef.line}` : "";
  return `${fileRef.label?.trim() || fileRef.path}${line}`;
}

export async function handleTeammateDirectRuntime(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  teammateId: string,
  service: DirectReplyControlService,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method === "GET") {
      const runtime = service.getRuntime({ store, teammateId });
      if (!runtime.activeReply && runtime.interventions.some((intervention) => intervention.mode === "queue_followup" && intervention.status === "queued")) {
        queueMicrotask(() => {
          void service.maybeStartNextQueuedContinuation({ store, teammateId, threadId: runtime.thread.id }).catch(() => undefined);
        });
      }
      writeJson(response, 200, { cwd, ...runtime });
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for teammate direct-runtime` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleTeammateDirectInterventions(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  teammateId: string,
  service: DirectReplyControlService,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method === "GET") {
      const runtime = service.getRuntime({ store, teammateId });
      writeJson(response, 200, { cwd, teammateId, thread: runtime.thread, interventions: runtime.interventions });
      return;
    }
    if (request.method === "POST") {
      const body = parseDirectInterventionCreateRequest(await readJsonBody(request, config.maxBodyBytes));
      const intervention = service.createIntervention({ store, teammateId, ...body });
      writeJson(response, 201, { cwd, teammateId, intervention, runtime: service.getRuntime({ store, teammateId }) });
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for teammate direct-interventions` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleTeammateDirectInterventionCancel(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  interventionId: string,
  service: DirectReplyControlService,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for teammate direct intervention cancel` });
      return;
    }
    const body = parseOptionalReason(await readOptionalJsonBody(request, config.maxBodyBytes));
    const intervention = service.cancelIntervention({ store, interventionId, reason: body.reason });
    writeJson(response, 200, { cwd, intervention });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleTeammateDirectInterventionPromote(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  interventionId: string,
  service: DirectReplyControlService,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for teammate direct intervention promote` });
      return;
    }
    const body = parseOptionalReason(await readOptionalJsonBody(request, config.maxBodyBytes));
    const result = service.promoteIntervention({ store, interventionId, reason: body.reason });
    writeJson(response, 200, {
      cwd,
      teammateId: result.intervention.teammateId,
      intervention: result.intervention,
      runtime: service.getRuntime({ store, teammateId: result.intervention.teammateId }),
      ...(result.message ? { message: result.message } : {}),
    });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleTeammateDirectReplyCancel(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  workUnitId: string,
  service: DirectReplyControlService,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for teammate direct reply cancel` });
      return;
    }
    const body = parseOptionalReason(await readOptionalJsonBody(request, config.maxBodyBytes));
    const result = service.cancelReply({ store, workUnitId, reason: body.reason });
    writeJson(response, 200, { cwd, ...result });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseDirectInterventionCreateRequest(value: unknown): {
  readonly mode: TeammateDirectReplyInterventionMode;
  readonly instruction: string;
  readonly messagePayload?: TeammateDirectReplyInterventionMessagePayload;
  readonly idempotencyKey?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be an object");
  }
  const record = value as Record<string, unknown>;
  const mode = record.mode;
  if (mode !== "queue_followup" && mode !== "interrupt_redirect") {
    throw new Error("mode must be queue_followup or interrupt_redirect");
  }
  const instruction = typeof record.instruction === "string" ? record.instruction.trim() : "";
  if (!instruction) {
    throw new Error("instruction is required");
  }
  const messagePayload = parseDirectInterventionMessagePayload(record.messagePayload);
  const idempotencyKey = typeof record.idempotencyKey === "string" && record.idempotencyKey.trim() ? record.idempotencyKey.trim() : undefined;
  return { mode, instruction, messagePayload, idempotencyKey };
}

function parseDirectInterventionMessagePayload(value: unknown): TeammateDirectReplyInterventionMessagePayload | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("messagePayload must be an object");
  }
  const body = typeof value.body === "string" ? value.body.trim() : "";
  const attachmentIds = readOptionalStringArray(value, "attachmentIds") ?? [];
  const linkPreviewIds = readOptionalStringArray(value, "linkPreviewIds") ?? [];
  const fileRefs = readOptionalChannelMessageFileRefs(value, "fileRefs") ?? [];
  if (!body && attachmentIds.length === 0 && linkPreviewIds.length === 0 && fileRefs.length === 0) {
    throw new Error("messagePayload must include body, attachments, links, or file references");
  }
  return {
    body,
    attachmentIds,
    linkPreviewIds,
    ...(fileRefs.length ? { fileRefs } : {}),
  };
}

function parseOptionalReason(value: unknown | undefined): { readonly reason?: string } {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be an object");
  }
  const reason = (value as Record<string, unknown>).reason;
  return typeof reason === "string" && reason.trim() ? { reason: reason.trim() } : {};
}
