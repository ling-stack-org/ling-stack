import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DEFAULT_WORKSPACE_ID,
  automationDraftToCreateRequest,
  getBuiltinAutomationTemplate,
  builtinAutomationTemplates,
  defaultDraftExecutionPolicy,
  defaultDraftOutputPolicy,
  validateAutomationDraft,
  type AutomationDraft,
  type AutomationDraftConfirmInput,
  type AutomationDefinition,
  type AutomationKind,
  type AutomationOutputPolicy,
  type AutomationPromptTemplate,
  type AutomationTarget,
  type AutomationTrigger,
  type BuiltinAutomationTemplateKind,
  type CreateAutomationDraftInput,
  type RunStore,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalBooleanQuery, readOptionalIntegerQuery, readOptionalJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { ensureRunCancelled } from "../runs/cancellation.js";
import type { AutomationSchedulerRegistry } from "./scheduler.js";
import { buildAutomationContext } from "./context.js";
import { runAutomation, type StartAutomationRunExecution } from "./run.js";
import {
  parseAutomationRunCancelRequest,
  parseAutomationRunRequest,
  parseCreateAutomationRequest,
  parseCreateAutomationDraftRequest,
  parseOptionalAutomationDraftSourceQuery,
  parseOptionalAutomationDraftStatusQuery,
  parseOptionalAutomationKindQuery,
  parseOptionalAutomationRunStatusQuery,
  parseOptionalAutomationStatusQuery,
  parseUpdateAutomationDraftRequest,
  parseUpdateAutomationRequest,
} from "./schemas.js";

export type AutomationRoute =
  | { readonly kind: "detail"; readonly automationId: string }
  | { readonly kind: "preview"; readonly automationId: string }
  | { readonly kind: "run"; readonly automationId: string };

export type AutomationRunRoute =
  | { readonly kind: "detail"; readonly automationRunId: string }
  | { readonly kind: "cancel"; readonly automationRunId: string };

export type AutomationDraftRoute =
  | { readonly kind: "detail"; readonly draftId: string }
  | { readonly kind: "preview"; readonly draftId: string }
  | { readonly kind: "confirm"; readonly draftId: string };

export async function handleAutomationsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = requireCwd(url);
  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        automations: store.listAutomationDefinitions({
          status: parseOptionalAutomationStatusQuery(url.searchParams.get("status")),
          kind: parseOptionalAutomationKindQuery(url.searchParams.get("kind")),
          channelId: url.searchParams.get("channelId") ?? undefined,
          includeArchived: readOptionalBooleanQuery(url, "includeArchived"),
          scheduledOnly: readOptionalBooleanQuery(url, "scheduledOnly"),
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
        templates: builtinAutomationTemplates,
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      rejectSecretLikeKeys(body);
      const input = parseCreateAutomationRequest(body);
      const created = createAutomationDefinitionFromRequest({ store, cwd, input, now: new Date().toISOString() });
      writeJson(response, 201, { cwd, automation: created.automation, thread: created.thread });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /automations` });
  } catch (error) {
    writeJson(response, statusForError(error), errorBody(error));
  }
}

export async function handleAutomationDraftsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = requireCwd(url);
  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        drafts: store.listAutomationDrafts({
          status: parseOptionalAutomationDraftStatusQuery(url.searchParams.get("status")),
          source: parseOptionalAutomationDraftSourceQuery(url.searchParams.get("source")),
          channelId: url.searchParams.get("channelId") ?? undefined,
          includeTerminal: readOptionalBooleanQuery(url, "includeTerminal"),
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
        templates: builtinAutomationTemplates,
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      rejectSecretLikeKeys(body);
      const input = parseCreateAutomationDraftRequest(body);
      const draft = store.createAutomationDraft(createAutomationDraftInputFromRequest({ store, cwd, input }), new Date().toISOString());
      writeJson(response, 201, { cwd, draft });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /automation-drafts` });
  } catch (error) {
    writeJson(response, statusForError(error), errorBody(error));
  }
}

export async function handleAutomationDraftItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  route: AutomationDraftRoute,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = requireCwd(url);
  try {
    const store = storeRegistry.getStore(cwd);
    const draft = store.getAutomationDraft(route.draftId);
    if (!draft) {
      writeJson(response, 404, { error: "automation_draft_not_found", message: `Automation draft not found: ${route.draftId}` });
      return;
    }

    if (route.kind === "detail") {
      if (request.method === "GET") {
        writeJson(response, 200, { cwd, draft });
        return;
      }
      if (request.method === "PATCH") {
        const body = await readJsonBody(request, config.maxBodyBytes);
        rejectSecretLikeKeys(body);
        const input = parseUpdateAutomationDraftRequest(body);
        const updated = store.updateAutomationDraft(
          draft.id,
          automationDraftUpdateInputFromRequest(input),
          new Date().toISOString(),
        );
        writeJson(response, 200, { cwd, draft: updated ?? draft });
        return;
      }
      if (request.method === "DELETE") {
        const discarded = store.discardAutomationDraft(draft.id, new Date().toISOString());
        writeJson(response, 200, { cwd, draft: discarded ?? draft });
        return;
      }
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for automation draft detail` });
      return;
    }

    if (route.kind === "preview") {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for automation draft preview` });
        return;
      }
      await readOptionalJsonBody(request, config.maxBodyBytes);
      const validated = validateAutomationDraft(draft);
      if (validated.status !== "ready_for_confirmation") {
        writeJson(response, 409, {
          error: "automation_draft_not_ready",
          message: `Automation draft is not ready for preview: ${validated.status}`,
          draft: validated,
        });
        return;
      }
      const context = buildAutomationContext({
        store,
        automation: previewAutomationDefinitionFromDraft(validated, cwd, new Date().toISOString()),
        now: new Date().toISOString(),
        mode: "preview",
      });
      writeJson(response, 200, { cwd, draft: validated, context });
      return;
    }

    if (route.kind === "confirm") {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for automation draft confirm` });
        return;
      }
      await readOptionalJsonBody(request, config.maxBodyBytes);
      if (draft.status === "confirmed" && draft.confirmedAutomationId) {
        const automation = store.getAutomationDefinition(draft.confirmedAutomationId);
        if (!automation) {
          writeJson(response, 409, {
            error: "confirmed_automation_missing",
            message: `Confirmed automation not found: ${draft.confirmedAutomationId}`,
          });
          return;
        }
        writeJson(response, 200, { cwd, draft, automation, thread: store.getLingThread(automation.threadId) });
        return;
      }
      const validated = validateAutomationDraft(draft);
      if (validated.status !== "ready_for_confirmation") {
        writeJson(response, 409, {
          error: "automation_draft_not_ready",
          message: `Automation draft is not ready for confirmation: ${validated.status}`,
          draft: validated,
        });
        return;
      }
      const createInput = automationDraftToCreateRequest(validated);
      const created = createAutomationDefinitionFromResolvedInput({ store, input: createInput, now: new Date().toISOString() });
      const confirmed = store.confirmAutomationDraft(validated.id, created.automation.id, new Date().toISOString());
      writeJson(response, 201, { cwd, draft: confirmed ?? validated, automation: created.automation, thread: created.thread });
      return;
    }
  } catch (error) {
    writeJson(response, statusForError(error), errorBody(error));
  }
}

export async function handleAutomationItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  route: AutomationRoute,
  startRun: StartAutomationRunExecution,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = requireCwd(url);
  try {
    const store = storeRegistry.getStore(cwd);
    const automation = store.getAutomationDefinition(route.automationId);
    if (!automation) {
      writeJson(response, 404, { error: "automation_not_found", message: `Automation not found: ${route.automationId}` });
      return;
    }

    if (route.kind === "detail") {
      if (request.method === "GET") {
        writeJson(response, 200, {
          cwd,
          automation,
          thread: store.getLingThread(automation.threadId),
          runs: store.listAutomationRuns({ automationId: automation.id, limit: 20 }),
        });
        return;
      }
      if (request.method === "PATCH") {
        const body = await readJsonBody(request, config.maxBodyBytes);
        rejectSecretLikeKeys(body);
        const input = parseUpdateAutomationRequest(body);
        const updated = store.updateAutomationDefinition(automation.id, input, new Date().toISOString());
        if (updated) {
          store.updateLingThread(
            updated.threadId,
            {
              title: updated.title,
              objective: updated.promptTemplate.promptMarkdown,
              status: updated.status === "archived" ? "archived" : undefined,
              archivedAt: updated.status === "archived" ? new Date().toISOString() : undefined,
            },
            new Date().toISOString(),
          );
        }
        writeJson(response, 200, { cwd, automation: updated, thread: updated ? store.getLingThread(updated.threadId) : undefined });
        return;
      }
      if (request.method === "DELETE") {
        const archivedAt = new Date().toISOString();
        const archived = store.archiveAutomationDefinition(automation.id, archivedAt);
        store.updateLingThread(automation.threadId, { status: "archived", activeRunId: null, archivedAt }, archivedAt);
        writeJson(response, 200, { cwd, automation: archived, thread: store.getLingThread(automation.threadId) });
        return;
      }
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for automation detail` });
      return;
    }

    if (route.kind === "preview") {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for automation preview` });
        return;
      }
      await readOptionalJsonBody(request, config.maxBodyBytes);
      const context = buildAutomationContext({ store, automation, now: new Date().toISOString(), mode: "preview" });
      writeJson(response, 200, { cwd, automation, context });
      return;
    }

    if (route.kind === "run") {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for automation run` });
        return;
      }
      const body = await readOptionalJsonBody(request, config.maxBodyBytes);
      const result = await runAutomation({
        cwd,
        automationId: automation.id,
        storeRegistry,
        request: parseAutomationRunRequest(body),
        startRun,
      });
      writeJson(response, 202, result);
      return;
    }
  } catch (error) {
    writeJson(response, statusForError(error), errorBody(error));
  }
}

export async function handleAutomationRunsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /automation-runs` });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  try {
    const cwd = requireCwd(url);
    const store = storeRegistry.getStore(cwd);
    writeJson(response, 200, {
      cwd,
      automationRuns: store.listAutomationRuns({
        automationId: url.searchParams.get("automationId") ?? undefined,
        runId: url.searchParams.get("runId") ?? undefined,
        status: parseOptionalAutomationRunStatusQuery(url.searchParams.get("status")),
        limit: readOptionalIntegerQuery(url, "limit", 1),
      }),
    });
  } catch (error) {
    writeJson(response, statusForError(error), errorBody(error));
  }
}

export async function handleAutomationRunItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  activeRuns: ActiveRunRegistry,
  route: AutomationRunRoute,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  try {
    const cwd = requireCwd(url);
    const store = storeRegistry.getStore(cwd);
    const automationRun = store.getAutomationRun(route.automationRunId);
    if (!automationRun) {
      writeJson(response, 404, { error: "automation_run_not_found", message: `Automation run not found: ${route.automationRunId}` });
      return;
    }
    if (route.kind === "detail") {
      if (request.method !== "GET") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for automation run detail` });
        return;
      }
      writeJson(response, 200, {
        cwd,
        automationRun,
        automation: store.getAutomationDefinition(automationRun.automationId),
        thread: store.getLingThread(automationRun.threadId),
        run: automationRun.runId ? store.getRun(automationRun.runId) : undefined,
      });
      return;
    }
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for automation run cancel` });
      return;
    }
    const body = await readOptionalJsonBody(request, config.maxBodyBytes);
    const cancelRequest = parseAutomationRunCancelRequest(body);
    const now = new Date().toISOString();
    if (automationRun.runId) {
      const run = store.getRun(automationRun.runId);
      const activeRun = activeRuns.get(automationRun.runId);
      if (run && activeRun) {
        ensureRunCancelled({
          store,
          runId: run.id,
          taskId: run.taskId,
          startedAt: run.startedAt,
          reason: cancelRequest.reason ?? "automation_cancelled",
          active: true,
          streamEnvelope: activeRun.streamEnvelope,
        });
        activeRun.abortController.abort();
      }
    }
    const cancelled = store.updateAutomationRun(
      automationRun.id,
      { status: "cancelled", completedAt: now, errorMessage: cancelRequest.reason ?? null },
      now,
    );
    writeJson(response, 200, { cwd, automationRun: cancelled });
  } catch (error) {
    writeJson(response, statusForError(error), errorBody(error));
  }
}

export async function handleAutomationSchedulerStart(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  schedulerRegistry: AutomationSchedulerRegistry,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for automation scheduler start` });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  try {
    const cwd = requireCwd(url);
    const result = schedulerRegistry.start(cwd);
    writeJson(response, 200, { cwd, scheduler: result.scheduler, duplicate: result.duplicate });
  } catch (error) {
    writeJson(response, statusForError(error), errorBody(error));
  }
}

export async function handleAutomationSchedulerCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  schedulerRegistry: AutomationSchedulerRegistry,
): Promise<void> {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for automation schedulers` });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  try {
    const cwd = requireCwd(url);
    writeJson(response, 200, { cwd, schedulers: schedulerRegistry.list(cwd) });
  } catch (error) {
    writeJson(response, statusForError(error), errorBody(error));
  }
}

export async function handleAutomationSchedulerStop(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  schedulerRegistry: AutomationSchedulerRegistry,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for automation scheduler stop` });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  try {
    const cwd = requireCwd(url);
    const scheduler = schedulerRegistry.stop(cwd);
    if (!scheduler) {
      writeJson(response, 404, { error: "automation_scheduler_not_found", message: `Automation scheduler is not running for ${cwd}` });
      return;
    }
    writeJson(response, 200, { cwd, scheduler });
  } catch (error) {
    writeJson(response, statusForError(error), errorBody(error));
  }
}

export function parseAutomationRoute(pathname: string): AutomationRoute | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "automations") {
    return { kind: "detail", automationId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "automations" && segments[2] === "preview") {
    return { kind: "preview", automationId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "automations" && segments[2] === "run") {
    return { kind: "run", automationId: segments[1] };
  }
  return undefined;
}

export function parseAutomationDraftRoute(pathname: string): AutomationDraftRoute | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "automation-drafts") {
    return { kind: "detail", draftId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "automation-drafts" && segments[2] === "preview") {
    return { kind: "preview", draftId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "automation-drafts" && segments[2] === "confirm") {
    return { kind: "confirm", draftId: segments[1] };
  }
  return undefined;
}

export function parseAutomationRunRoute(pathname: string): AutomationRunRoute | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "automation-runs") {
    return { kind: "detail", automationRunId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "automation-runs" && segments[2] === "cancel") {
    return { kind: "cancel", automationRunId: segments[1] };
  }
  return undefined;
}

function createAutomationDraftInputFromRequest(input: {
  readonly store: RunStore;
  readonly cwd: string;
  readonly input: ReturnType<typeof parseCreateAutomationDraftRequest>;
}): CreateAutomationDraftInput {
  const partial = input.input.partialAutomation ?? {};
  const channelId = partial.channelId ?? partial.target?.channelId;
  if (channelId && !input.store.getChannel(channelId)) {
    throw new HttpError(404, "channel_not_found", `Channel not found: ${channelId}`);
  }

  if (input.input.source === "template") {
    const templateId = input.input.templateId ?? (partial.kind === "daily_brief" || partial.kind === "weekly_review" ? partial.kind : undefined);
    if (!templateId) {
      throw new Error("templateId is required for template automation drafts");
    }
    const template = getBuiltinAutomationTemplate(templateId);
    return {
      source: "template",
      channelId,
      title: partial.title ?? template.title,
      description: partial.description ?? template.description,
      kind: partial.kind ?? template.kind,
      trigger: partial.trigger ?? template.defaultTrigger,
      target: resolveTarget(input.cwd, channelId, partial.target),
      promptTemplate: partial.promptTemplate ?? template.defaultPromptTemplate,
      executionPolicy: partial.executionPolicy ?? template.defaultExecutionPolicy,
      outputPolicy: partial.outputPolicy ?? template.defaultOutputPolicy,
      proposedByRunId: input.input.proposedByRunId,
      proposedByThreadId: input.input.proposedByThreadId,
    };
  }

  if (input.input.source === "chat") {
    const prompt = input.input.prompt?.trim();
    if (!prompt) {
      throw new Error("prompt is required for chat automation drafts");
    }
    return {
      source: "chat",
      channelId,
      title: partial.title ?? inferChatDraftTitle(prompt),
      description: partial.description ?? "Chat-assisted automation draft. Review before confirming.",
      kind: partial.kind ?? "custom_prompt",
      trigger: partial.trigger ?? inferChatDraftTrigger(prompt),
      target: resolveTarget(input.cwd, channelId, partial.target),
      promptTemplate: partial.promptTemplate ?? createChatDraftPromptTemplate(prompt),
      executionPolicy: partial.executionPolicy ?? defaultDraftExecutionPolicy(),
      outputPolicy: partial.outputPolicy ?? defaultDraftOutputPolicy(),
      proposedByRunId: input.input.proposedByRunId,
      proposedByThreadId: input.input.proposedByThreadId,
    };
  }

  return {
    source: "manual",
    channelId,
    title: partial.title,
    description: partial.description,
    kind: partial.kind ?? "custom_prompt",
    trigger: partial.trigger ?? { type: "manual" },
    target: partial.target || channelId ? resolveTarget(input.cwd, channelId, partial.target) : undefined,
    promptTemplate: partial.promptTemplate,
    executionPolicy: partial.executionPolicy ?? defaultDraftExecutionPolicy(),
    outputPolicy: partial.outputPolicy ?? defaultDraftOutputPolicy(),
    proposedByRunId: input.input.proposedByRunId,
    proposedByThreadId: input.input.proposedByThreadId,
  };
}

function automationDraftUpdateInputFromRequest(
  input: ReturnType<typeof parseUpdateAutomationDraftRequest>,
): Parameters<RunStore["updateAutomationDraft"]>[1] {
  const partial = input.partialAutomation ?? {};
  return {
    channelId: partial.channelId,
    title: partial.title,
    description: partial.description,
    kind: partial.kind,
    trigger: partial.trigger,
    target: partial.target,
    promptTemplate: partial.promptTemplate,
    executionPolicy: partial.executionPolicy,
    outputPolicy: partial.outputPolicy,
    proposedByRunId: input.proposedByRunId,
    proposedByThreadId: input.proposedByThreadId,
  };
}

function createAutomationDefinitionFromRequest(input: {
  readonly store: RunStore;
  readonly cwd: string;
  readonly input: ReturnType<typeof parseCreateAutomationRequest>;
  readonly now: string;
}): { readonly automation: AutomationDefinition; readonly thread: NonNullable<ReturnType<RunStore["getLingThread"]>> } {
  const template = resolveTemplate(input.input.kind, input.input.promptTemplate);
  const channelId = input.input.channelId ?? input.input.target?.channelId;
  if (channelId && !input.store.getChannel(channelId)) {
    throw new HttpError(404, "channel_not_found", `Channel not found: ${channelId}`);
  }
  return createAutomationDefinitionFromResolvedInput({
    store: input.store,
    input: {
      channelId,
      workspaceId: DEFAULT_WORKSPACE_ID,
      title: input.input.title,
      description: input.input.description ?? template.description,
      kind: input.input.kind,
      status: input.input.status ?? "enabled",
      trigger: input.input.trigger ?? template.trigger,
      target: resolveTarget(input.cwd, channelId, input.input.target),
      promptTemplate: input.input.promptTemplate ?? template.promptTemplate,
      executionPolicy: { ...template.executionPolicy, ...(input.input.executionPolicy ?? {}) },
      outputPolicy: input.input.outputPolicy ?? template.outputPolicy,
    },
    now: input.now,
  });
}

function createAutomationDefinitionFromResolvedInput(input: {
  readonly store: RunStore;
  readonly input: AutomationDraftConfirmInput;
  readonly now: string;
}): { readonly automation: AutomationDefinition; readonly thread: NonNullable<ReturnType<RunStore["getLingThread"]>> } {
  const channelId = input.input.channelId ?? input.input.target.channelId;
  if (channelId && !input.store.getChannel(channelId)) {
    throw new HttpError(404, "channel_not_found", `Channel not found: ${channelId}`);
  }
  const thread = input.store.createLingThread(
    {
      kind: "automation",
      channelId,
      title: input.input.title,
      objective: input.input.promptTemplate.promptMarkdown,
      status: "open",
    },
    input.now,
  );
  const automation = input.store.createAutomationDefinition(
    {
      workspaceId: input.input.workspaceId,
      channelId,
      threadId: thread.id,
      title: input.input.title,
      description: input.input.description,
      kind: input.input.kind,
      status: input.input.status ?? "enabled",
      trigger: input.input.trigger,
      target: input.input.target,
      promptTemplate: input.input.promptTemplate,
      executionPolicy: input.input.executionPolicy,
      outputPolicy: input.input.outputPolicy,
    },
    input.now,
  );
  return { automation, thread };
}

function previewAutomationDefinitionFromDraft(draft: AutomationDraft, cwd: string, now: string): AutomationDefinition {
  const createInput = automationDraftToCreateRequest(draft);
  return {
    id: `automation_preview_${draft.id}`,
    workspaceId: createInput.workspaceId ?? DEFAULT_WORKSPACE_ID,
    channelId: createInput.channelId,
    threadId: draft.proposedByThreadId ?? `automation_preview_thread_${draft.id}`,
    title: createInput.title,
    description: createInput.description,
    kind: createInput.kind,
    status: "enabled",
    trigger: createInput.trigger,
    target: createInput.target ?? resolveTarget(cwd, createInput.channelId, undefined),
    promptTemplate: createInput.promptTemplate,
    executionPolicy: createInput.executionPolicy,
    outputPolicy: createInput.outputPolicy,
    createdAt: draft.createdAt,
    updatedAt: now,
  };
}

function inferChatDraftTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "Chat Automation";
  const cleaned = firstLine.replace(/^create\s+(an?\s+)?automation\s+(that|to)\s+/i, "").trim();
  return (cleaned || "Chat Automation").slice(0, 72);
}

function inferChatDraftTrigger(prompt: string): AutomationTrigger {
  const normalized = prompt.toLowerCase();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (/\bweekly\b|每周|周报/.test(normalized)) {
    return {
      type: "schedule",
      timezone,
      schedule: { cadence: "weekly", weekday: 5, timeOfDay: "17:00" },
      missedRunPolicy: "skip",
    };
  }
  if (/\bdaily\b|每天|日报/.test(normalized)) {
    return {
      type: "schedule",
      timezone,
      schedule: { cadence: "daily", timeOfDay: "09:00" },
      missedRunPolicy: "skip",
    };
  }
  return { type: "manual" };
}

function createChatDraftPromptTemplate(prompt: string): AutomationPromptTemplate {
  return {
    templateVersion: 1,
    systemPurpose:
      "Execute a user-confirmed chat-created automation from supplied Ling context only. Do not mutate files, GitHub, providers, memory, tasks, or secrets.",
    promptMarkdown: [
      "Run this confirmed automation request:",
      "",
      prompt,
      "",
      "Use only the supplied Ling context. If evidence is missing, say so explicitly before recommending any follow-up.",
    ].join("\n"),
    contextSelectors: [
      { kind: "channel_brief" },
      { kind: "recent_runs", limit: 8 },
      { kind: "pending_approvals", limit: 8 },
      { kind: "external_work", limit: 8 },
      { kind: "recent_artifacts", limit: 8 },
    ],
    maxContextItems: 32,
  };
}

function resolveTemplate(
  kind: AutomationKind,
  promptTemplate: AutomationPromptTemplate | undefined,
): {
  readonly description?: string;
  readonly trigger: AutomationTrigger;
  readonly promptTemplate: AutomationPromptTemplate;
  readonly executionPolicy: ReturnType<typeof getBuiltinAutomationTemplate>["defaultExecutionPolicy"];
  readonly outputPolicy: AutomationOutputPolicy;
} {
  if (kind === "daily_brief" || kind === "weekly_review") {
    const template = getBuiltinAutomationTemplate(kind);
    return {
      description: template.description,
      trigger: template.defaultTrigger,
      promptTemplate: template.defaultPromptTemplate,
      executionPolicy: template.defaultExecutionPolicy,
      outputPolicy: template.defaultOutputPolicy,
    };
  }
  if (!promptTemplate) {
    throw new Error("custom_prompt requires promptTemplate");
  }
  return {
    trigger: { type: "manual" },
    promptTemplate,
    executionPolicy: { allowedTools: ["read", "grep", "find", "ls"], approvalProfile: { mode: "none" } },
    outputPolicy: { destinations: [{ type: "automation_thread" }, { type: "markdown_artifact" }], artifactFormat: "markdown" },
  };
}

function resolveTarget(cwd: string, channelId: string | undefined, target: AutomationTarget | undefined): AutomationTarget {
  if (target) {
    return target;
  }
  return {
    scope: channelId ? "channel" : "workspace",
    workspaceId: DEFAULT_WORKSPACE_ID,
    channelId,
    cwd,
  };
}

function requireCwd(url: URL): string {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    throw new HttpError(400, "bad_request", "cwd query parameter is required");
  }
  return cwd;
}

function statusForError(error: unknown): number {
  return error instanceof HttpError ? error.statusCode : 400;
}

function errorBody(error: unknown): { readonly error: string; readonly message: string } {
  return {
    error: error instanceof HttpError ? error.code : "bad_request",
    message: error instanceof Error ? error.message : String(error),
  };
}

function rejectSecretLikeKeys(value: unknown): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const [key, nested] of Object.entries(current)) {
      const normalized = key.toLowerCase();
      if (normalized === "apikey" || normalized === "api_key" || normalized === "secret" || normalized === "token" || normalized === "password") {
        throw new Error(`Raw secret fields are not allowed in automations: ${key}`);
      }
      stack.push(nested);
    }
  }
}
