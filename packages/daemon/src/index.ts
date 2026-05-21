import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import {
  approvalStatuses,
  createRunId,
  createSqliteRunStore,
  getRunSummaryPath,
  isSupportedSecretRef,
  providerApis,
  providerCapabilities,
  providerKinds,
  readOnlyRunTools,
  resolveSecretRef,
  taskStatuses,
  writeRunSummary,
  type ApprovalPayload,
  type ApprovalRequest,
  type ApprovalRisk,
  type ApprovalStatus,
  type CreateApprovalRequestInput,
  type ChannelUpdateInput,
  type CreateChannelInput,
  type CreateTaskInput,
  type ProviderApi,
  type ProviderCapability,
  type ProviderCheckResult,
  type ProviderKind,
  type ProviderPreset,
  type ProviderPresetInput,
  type ProviderPresetUpdateInput,
  type PublicProviderPreset,
  type RunEventEnvelope,
  type RunEventType,
  type RunTool,
  type RunSession,
  type RunStore,
  type RunSummary,
  type RunStatus,
  type TaskStatus,
  type TaskUpdateInput,
} from "@ling-stack/core";
import {
  createPiRunner,
  type PiRunnerApprovalRequest,
  type PiRunnerEvent,
  type PiRunnerProviderConfig,
  type PiRunnerResult,
  type PiRunnerRunOptions,
} from "@ling-stack/runner-pi";

export interface DaemonConfig {
  readonly host?: string;
  readonly port?: number;
  readonly maxBodyBytes?: number;
}

export interface ResolvedDaemonConfig {
  readonly host: string;
  readonly port: number;
  readonly maxBodyBytes: number;
}

export interface RunnerAdapter {
  runTask(options: PiRunnerRunOptions): Promise<PiRunnerResult>;
}

export type RunStoreFactory = (cwd: string) => RunStore;

export interface DaemonDependencies {
  readonly runner?: RunnerAdapter;
  readonly storeFactory?: RunStoreFactory;
}

export const defaultDaemonConfig: DaemonConfig = {
  host: "127.0.0.1",
  port: 17891,
  maxBodyBytes: 1024 * 1024,
};

const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
const APPROVAL_POLL_INTERVAL_MS = 500;
const APPROVAL_PREVIEW_LIMIT = 1_200;

export interface RunRequest extends Omit<PiRunnerRunOptions, "onApprovalRequired" | "onEvent" | "provider"> {
  readonly workspaceCwd?: string;
  readonly providerPresetId?: string;
  readonly provider?: PiRunnerProviderConfig;
}

export interface DaemonServer {
  readonly server: Server;
  readonly config: ResolvedDaemonConfig;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createDaemonServer(
  config: DaemonConfig = defaultDaemonConfig,
  dependencies: DaemonDependencies = {},
): DaemonServer {
  const resolvedConfig = resolveConfig(config);
  const runner = dependencies.runner ?? createPiRunner();
  const storeRegistry = new RunStoreRegistry(dependencies.storeFactory ?? createSqliteRunStore);
  const activeRuns = new ActiveRunRegistry();
  const server = createServer(async (request, response) => {
    try {
      await routeRequest(request, response, resolvedConfig, runner, storeRegistry, activeRuns);
    } catch (error) {
      if (!response.headersSent) {
        writeJson(response, 500, {
          error: "internal_error",
          message: error instanceof Error ? error.message : String(error),
        });
      } else {
        response.end();
      }
    }
  });

  return {
    server,
    config: resolvedConfig,
    start: () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(resolvedConfig.port, resolvedConfig.host, () => {
          server.off("error", reject);
          resolve();
        });
      }),
    stop: () =>
      new Promise<void>((resolve, reject) => {
        activeRuns.cancelAll();
        server.close((error) => {
          storeRegistry.closeAll();
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

export async function startDaemon(
  config: DaemonConfig = defaultDaemonConfig,
  dependencies: DaemonDependencies = {},
): Promise<DaemonServer> {
  const daemon = createDaemonServer(config, dependencies);
  await daemon.start();
  return daemon;
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  runner: RunnerAdapter,
  storeRegistry: RunStoreRegistry,
  activeRuns: ActiveRunRegistry,
): Promise<void> {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);

  if (request.method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, { ok: true, service: "ling-stack-daemon" });
    return;
  }

  if (url.pathname === "/channels") {
    await handleChannelsCollection(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/tasks") {
    await handleTasksCollection(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/providers") {
    await handleProvidersCollection(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/approvals") {
    handleApprovalsCollection(request, response, url, storeRegistry);
    return;
  }

  if (request.method === "POST" && url.pathname === "/runs") {
    await handleRun(request, response, config, runner, storeRegistry, activeRuns);
    return;
  }
  if (request.method === "GET" && url.pathname === "/runs") {
    handleListRuns(response, url, storeRegistry);
    return;
  }

  const runRoute = parseRunRoute(url.pathname);
  if (request.method === "POST" && runRoute?.kind === "cancel") {
    handleCancelRun(response, url, storeRegistry, activeRuns, runRoute.runId);
    return;
  }
  if (request.method === "GET" && runRoute?.kind === "run") {
    handleGetRun(response, url, storeRegistry, runRoute.runId);
    return;
  }
  if (request.method === "GET" && runRoute?.kind === "events") {
    handleGetRunEvents(response, url, storeRegistry, runRoute.runId);
    return;
  }

  const channelRoute = parseChannelRoute(url.pathname);
  if (channelRoute) {
    await handleChannelItem(request, response, config, storeRegistry, channelRoute.channelId);
    return;
  }

  const taskRoute = parseTaskRoute(url.pathname);
  if (taskRoute) {
    await handleTaskItem(request, response, config, storeRegistry, taskRoute.taskId);
    return;
  }

  const providerRoute = parseProviderRoute(url.pathname);
  if (providerRoute) {
    await handleProviderItem(request, response, config, storeRegistry, providerRoute);
    return;
  }

  const approvalRoute = parseApprovalRoute(url.pathname);
  if (approvalRoute) {
    await handleApprovalItem(request, response, config, storeRegistry, approvalRoute);
    return;
  }

  writeJson(response, 404, { error: "not_found", message: `No route for ${request.method} ${url.pathname}` });
}

async function handleRun(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  runner: RunnerAdapter,
  storeRegistry: RunStoreRegistry,
  activeRuns: ActiveRunRegistry,
): Promise<void> {
  let runRequest: RunRequest;
  try {
    const body = await readJsonBody(request, config.maxBodyBytes);
    runRequest = parseRunRequest(body);
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  let store: RunStore;
  let run: RunSession;
  let runnerRequest: PiRunnerRunOptions;
  try {
    const workspaceCwd = runRequest.workspaceCwd ?? runRequest.cwd;
    store = storeRegistry.getStore(workspaceCwd);
    const resolvedProvider = resolveProviderForRun(store, runRequest);
    runnerRequest = {
      cwd: runRequest.cwd,
      task: runRequest.task,
      provider: resolvedProvider,
      tools: runRequest.tools,
      thinkingLevel: runRequest.thinkingLevel,
      systemPrompt: runRequest.systemPrompt,
      appendSystemPrompt: runRequest.appendSystemPrompt,
      agentDir: runRequest.agentDir,
    };
    const runId = createRunId();
    const createdAt = new Date().toISOString();
    run = store.createRun({
      id: runId,
      cwd: runRequest.cwd,
      taskId: runRequest.task.id,
      channelId: runRequest.task.channelId,
      providerPresetId: runRequest.providerPresetId,
      providerName: resolvedProvider.provider,
      providerModel: resolvedProvider.model,
      taskSnapshot: runRequest.task,
      providerSnapshot: { providerPresetId: runRequest.providerPresetId, ...resolvedProvider },
      requestSnapshot: { ...runRequest, workspaceCwd, provider: resolvedProvider },
      createdAt,
    });
    storeRegistry.rememberRun(run.id, store);
    store.appendEvent(run.id, "run_created", {
      taskId: run.taskId,
      workspaceCwd,
      cwd: run.cwd,
      providerName: run.providerName,
      providerModel: run.providerModel,
    });
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    writeJson(response, statusCode, {
      error: error instanceof HttpError ? error.code : "run_storage_unavailable",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  writeSseHead(response);
  writeSse(response, "ready", { ok: true, runId: run.id });

  const abortController = new AbortController();
  let clientClosed = false;
  let runStartedAt: string | undefined;
  let persistedRunError = false;
  let persistenceError: unknown;
  response.on("close", () => {
    clientClosed = true;
  });

  const streamEnvelope = (envelope: RunEventEnvelope): void => {
    if (!clientClosed) {
      writeSse(response, envelope.type, envelope);
    }
  };

  activeRuns.add(run.id, {
    abortController,
    streamEnvelope,
  });

  const appendAndMaybeStream = (type: RunEventType, data: unknown): RunEventEnvelope | undefined => {
    if (persistenceError) {
      return undefined;
    }
    if (abortController.signal.aborted && type !== "run_cancelled") {
      return undefined;
    }
    if (store.getRun(run.id)?.status === "cancelled" && type !== "run_cancelled") {
      return undefined;
    }

    try {
      const envelope = store.appendEvent(run.id, type, data);
      if (type === "run_error") {
        persistedRunError = true;
      }
      streamEnvelope(envelope);
      return envelope;
    } catch (error) {
      persistenceError = error;
      return undefined;
    }
  };

  try {
    runStartedAt = new Date().toISOString();
    store.markRunStarted(run.id, runStartedAt);
    updateLinkedTaskForRun(store, run.taskId, { status: "running", currentRunId: run.id });

    const result = await runner.runTask({
      ...runnerRequest,
      onApprovalRequired: createRunApprovalHandler({
        store,
        run,
        appendAndMaybeStream,
        streamEnvelope,
        signal: abortController.signal,
      }),
      onEvent: (event: PiRunnerEvent) => {
        appendAndMaybeStream(event.type, event);
      },
      signal: abortController.signal,
    });

    if (persistenceError) {
      throw persistenceError;
    }
    if (store.getRun(run.id)?.status === "cancelled") {
      if (!clientClosed) {
        response.end();
      }
      return;
    }

    const resultEnvelope = appendAndMaybeStream("result", {
      taskId: result.taskId,
      messageCount: result.messages.length,
      runnerEventCount: result.events.length,
    });
    if (!resultEnvelope && persistenceError) {
      throw persistenceError;
    }

    const endedAt = new Date().toISOString();
    const summaryPath = writeTerminalSummary(getRunSummaryPath(store.paths, run.id), {
      runId: run.id,
      status: "succeeded",
      taskId: run.taskId,
      eventCount: resultEnvelope?.seq ?? store.countEvents(run.id),
      messageCount: result.messages.length,
      startedAt: runStartedAt,
      endedAt,
      errorMessage: null,
    });
    store.markRunSucceeded(run.id, endedAt, summaryPath);
    updateLinkedTaskForRun(store, run.taskId, { status: "done", currentRunId: run.id });

    if (!clientClosed) {
      response.end();
    }
  } catch (error) {
    if (isAbortError(error) || store.getRun(run.id)?.status === "cancelled") {
      ensureRunCancelled({
        store,
        runId: run.id,
        taskId: run.taskId,
        startedAt: runStartedAt,
        reason: "cancelled",
        active: false,
        streamEnvelope,
      });
      if (!clientClosed) {
        response.end();
      }
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const endedAt = new Date().toISOString();
    const failureEvent = persistedRunError
      ? undefined
      : appendFailureEvent(store, run.id, message, clientClosed, response);
    const summaryPath = writeTerminalSummary(getRunSummaryPath(store.paths, run.id), {
      runId: run.id,
      status: "failed",
      taskId: run.taskId,
      eventCount: failureEvent?.seq ?? store.countEvents(run.id),
      startedAt: runStartedAt,
      endedAt,
      errorMessage: message,
    });
    store.markRunFailed(run.id, endedAt, message, summaryPath);
    updateLinkedTaskForRun(store, run.taskId, { status: "failed", currentRunId: run.id });

    if (!clientClosed) {
      response.end();
    }
  } finally {
    activeRuns.delete(run.id);
  }
}

async function handleChannelsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
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
      writeJson(response, 200, {
        cwd,
        channels: store.listChannels({ limit: readOptionalIntegerQuery(url, "limit", 1) }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const channel = store.createChannel(parseCreateChannelInput(body), new Date().toISOString());
      writeJson(response, 201, { channel });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /channels` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleChannelItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const channel = store.getChannel(channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, { channel });
      return;
    }

    if (request.method === "PATCH") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const updated = store.updateChannel(channelId, parseChannelUpdateInput(body), new Date().toISOString());
      writeJson(response, 200, { channel: updated });
      return;
    }

    if (request.method === "DELETE") {
      const tasks = store.listTasks({ channelId, limit: 1 });
      if (tasks.length > 0) {
        writeJson(response, 409, { error: "channel_has_tasks", message: `Channel has tasks and cannot be deleted: ${channelId}` });
        return;
      }
      store.deleteChannel(channelId);
      writeJson(response, 200, { ok: true });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channels` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleTasksCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
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
      writeJson(response, 200, {
        cwd,
        tasks: store.listTasks({
          channelId: url.searchParams.get("channelId") ?? undefined,
          status: readOptionalTaskStatusQuery(url),
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseCreateTaskInput(body);
      if (!store.getChannel(input.channelId)) {
        writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${input.channelId}` });
        return;
      }
      const task = store.createTask(input, new Date().toISOString());
      writeJson(response, 201, { task });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /tasks` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleTaskItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  taskId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const task = store.getTask(taskId);
    if (!task) {
      writeJson(response, 404, { error: "task_not_found", message: `Task not found: ${taskId}` });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, { task });
      return;
    }

    if (request.method === "PATCH") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseTaskUpdateInput(body);
      if (input.channelId && !store.getChannel(input.channelId)) {
        writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${input.channelId}` });
        return;
      }
      const updated = store.updateTask(taskId, input, new Date().toISOString());
      writeJson(response, 200, { task: updated });
      return;
    }

    if (request.method === "DELETE") {
      store.deleteTask(taskId);
      writeJson(response, 200, { ok: true });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for tasks` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleProvidersCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  const store = storeRegistry.getStore(cwd);
  if (request.method === "GET") {
    writeJson(response, 200, {
      cwd,
      providers: store.listProviderPresets().map(toPublicProviderPreset),
    });
    return;
  }

  if (request.method === "POST") {
    try {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const preset = store.createProviderPreset(parseProviderPresetInput(body), new Date().toISOString());
      writeJson(response, 201, { provider: toPublicProviderPreset(preset) });
    } catch (error) {
      writeJson(response, 400, {
        error: "bad_request",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /providers` });
}

async function handleProviderItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  route: { readonly providerId: string; readonly action?: "check" },
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  const store = storeRegistry.getStore(cwd);
  const preset = store.getProviderPreset(route.providerId);
  if (!preset) {
    writeJson(response, 404, { error: "provider_not_found", message: `Provider preset not found: ${route.providerId}` });
    return;
  }

  if (request.method === "POST" && route.action === "check") {
    writeJson(response, 200, checkProviderPreset(preset));
    return;
  }

  if (route.action) {
    writeJson(response, 404, { error: "not_found", message: `No route for ${request.method} ${url.pathname}` });
    return;
  }

  if (request.method === "GET") {
    writeJson(response, 200, { provider: toPublicProviderPreset(preset) });
    return;
  }

  if (request.method === "PATCH") {
    try {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const updateInput = parseProviderPresetUpdateInput(body);
      validateProviderPresetUpdate(preset, updateInput);
      const updated = store.updateProviderPreset(route.providerId, updateInput, new Date().toISOString());
      if (!updated) {
        writeJson(response, 404, { error: "provider_not_found", message: `Provider preset not found: ${route.providerId}` });
        return;
      }
      writeJson(response, 200, { provider: toPublicProviderPreset(updated) });
    } catch (error) {
      writeJson(response, 400, {
        error: "bad_request",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (request.method === "DELETE") {
    store.deleteProviderPreset(route.providerId);
    writeJson(response, 200, { ok: true });
    return;
  }

  writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for provider presets` });
}

function handleApprovalsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
): void {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /approvals` });
    return;
  }

  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    writeJson(response, 200, {
      cwd,
      approvals: store.listApprovalRequests({
        status: readOptionalApprovalStatusQuery(url),
        runId: url.searchParams.get("runId") ?? undefined,
        limit: readOptionalIntegerQuery(url, "limit", 1),
      }),
    });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleApprovalItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  route: { readonly approvalId: string; readonly action?: "approve" | "deny" },
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  const store = storeRegistry.getStore(cwd);
  const approval = store.getApprovalRequest(route.approvalId);
  if (!approval) {
    writeJson(response, 404, { error: "approval_not_found", message: `Approval request not found: ${route.approvalId}` });
    return;
  }

  if (!route.action && request.method === "GET") {
    writeJson(response, 200, { approval });
    return;
  }

  if (!route.action) {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for approval requests` });
    return;
  }

  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for approval decisions` });
    return;
  }

  try {
    const body = await readOptionalJsonBody(request, config.maxBodyBytes);
    const decision = { reason: isRecord(body) ? readOptionalString(body, "reason") : undefined, resolvedBy: "local-user" as const };
    const now = new Date().toISOString();
    const updated =
      route.action === "approve"
        ? store.approveApprovalRequest(route.approvalId, decision, now)
        : store.denyApprovalRequest(route.approvalId, decision, now);
    if (!updated) {
      writeJson(response, 404, { error: "approval_not_found", message: `Approval request not found: ${route.approvalId}` });
      return;
    }
    appendApprovalDecisionEvent(store, updated);
    writeJson(response, 200, { approval: updated });
  } catch (error) {
    writeJson(response, 400, {
      error: error instanceof Error && error.message.includes("not pending") ? "approval_not_pending" : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function writeTerminalSummary(summaryPath: string, summary: RunSummary): string | undefined {
  try {
    writeRunSummary(summaryPath, summary);
    return summaryPath;
  } catch {
    return undefined;
  }
}

function handleListRuns(response: ServerResponse, url: URL, storeRegistry: RunStoreRegistry): void {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, {
      error: "bad_request",
      message: "cwd query parameter is required",
    });
    return;
  }

  try {
    const limit = readOptionalIntegerQuery(url, "limit", 1);
    const status = readOptionalRunStatusQuery(url);
    const store = storeRegistry.getStore(cwd);
    writeJson(response, 200, {
      cwd,
      runs: store.listRuns({ limit, status }),
    });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function handleGetRun(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  runId: string,
): void {
  const store = storeRegistry.findStoreForRun(runId, url.searchParams.get("cwd") ?? undefined);
  const run = store?.getRun(runId);
  if (!run) {
    writeJson(response, 404, {
      error: "run_not_found",
      message: "Run was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }

  writeJson(response, 200, run);
}

function handleGetRunEvents(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  runId: string,
): void {
  let afterSeq: number | undefined;
  let limit: number | undefined;
  try {
    afterSeq = readOptionalIntegerQuery(url, "afterSeq", 0);
    limit = readOptionalIntegerQuery(url, "limit", 1);
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const store = storeRegistry.findStoreForRun(runId, url.searchParams.get("cwd") ?? undefined);
  if (!store?.getRun(runId)) {
    writeJson(response, 404, {
      error: "run_not_found",
      message: "Run was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }

  const events = store.listEvents(runId, { afterSeq, limit });
  const lastEvent = events.at(-1);
  writeJson(response, 200, {
    runId,
    events,
    nextSeq: lastEvent ? lastEvent.seq + 1 : (afterSeq ?? 0) + 1,
  });
}

function handleCancelRun(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  activeRuns: ActiveRunRegistry,
  runId: string,
): void {
  const store = storeRegistry.findStoreForRun(runId, url.searchParams.get("cwd") ?? undefined);
  const run = store?.getRun(runId);
  if (!store || !run) {
    writeJson(response, 404, {
      error: "run_not_found",
      message: "Run was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }

  if (run.status === "cancelled") {
    writeJson(response, 200, { cancelled: true, active: false, run });
    return;
  }

  if (isTerminalRunStatus(run.status)) {
    writeJson(response, 409, {
      error: "run_not_cancellable",
      message: `Run ${runId} is already ${run.status}.`,
      run,
    });
    return;
  }

  const activeRun = activeRuns.get(runId);
  const cancelled = ensureRunCancelled({
    store,
    runId,
    taskId: run.taskId,
    startedAt: run.startedAt,
    reason: "user_requested",
    active: Boolean(activeRun),
    streamEnvelope: activeRun?.streamEnvelope,
  });
  activeRun?.abortController.abort();

  writeJson(response, 200, {
    cancelled: true,
    active: Boolean(activeRun),
    run: store.getRun(runId),
    event: cancelled.event,
  });
}

function ensureRunCancelled(input: {
  readonly store: RunStore;
  readonly runId: string;
  readonly taskId: string;
  readonly startedAt?: string;
  readonly reason: string;
  readonly active: boolean;
  readonly streamEnvelope?: (envelope: RunEventEnvelope) => void;
}): { readonly event?: RunEventEnvelope } {
  const current = input.store.getRun(input.runId);
  if (!current || current.status === "cancelled") {
    return {};
  }
  if (isTerminalRunStatus(current.status)) {
    return {};
  }

  const endedAt = new Date().toISOString();
  const event = input.store.appendEvent(input.runId, "run_cancelled", {
    reason: input.reason,
    active: input.active,
  });
  input.streamEnvelope?.(event);
  const summaryPath = writeTerminalSummary(getRunSummaryPath(input.store.paths, input.runId), {
    runId: input.runId,
    status: "cancelled",
    taskId: input.taskId,
    eventCount: event.seq,
    startedAt: input.startedAt,
    endedAt,
    errorMessage: null,
  });
  input.store.markRunCancelled(input.runId, endedAt, summaryPath);
  updateLinkedTaskForRun(input.store, input.taskId, { status: "cancelled", currentRunId: input.runId });
  return { event };
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function updateLinkedTaskForRun(store: RunStore, taskId: string, input: TaskUpdateInput): void {
  if (!store.getTask(taskId)) {
    return;
  }
  store.updateTask(taskId, input, new Date().toISOString());
}

function appendFailureEvent(
  store: RunStore,
  runId: string,
  message: string,
  clientClosed: boolean,
  response: ServerResponse,
): RunEventEnvelope | undefined {
  try {
    const envelope = store.appendEvent(runId, "run_error", { message });
    if (!clientClosed) {
      writeSse(response, envelope.type, envelope);
    }
    return envelope;
  } catch {
    return undefined;
  }
}

function resolveProviderForRun(store: RunStore, runRequest: RunRequest): PiRunnerProviderConfig {
  if (runRequest.providerPresetId && runRequest.provider) {
    throw new HttpError(400, "bad_request", "providerPresetId and inline provider cannot both be supplied");
  }

  if (runRequest.providerPresetId) {
    const preset = store.getProviderPreset(runRequest.providerPresetId);
    if (!preset) {
      throw new HttpError(404, "provider_not_found", `Provider preset not found: ${runRequest.providerPresetId}`);
    }
    if (!preset.enabled) {
      throw new HttpError(400, "provider_disabled", `Provider preset is disabled: ${preset.id}`);
    }
    if (preset.api === "media-job") {
      throw new HttpError(400, "unsupported_capability", "Media provider presets cannot run pi coding tasks");
    }
    if (!preset.capabilities.includes("chat")) {
      throw new HttpError(400, "unsupported_capability", "Provider preset must include chat capability for coding runs");
    }
    const secret = resolveSecretRef(preset.apiKeyRef);
    return removeUndefined({
      provider: preset.providerId,
      model: preset.model,
      displayName: preset.displayName,
      apiKey: secret.value,
      baseUrl: preset.baseUrl,
      api: preset.api as PiRunnerProviderConfig["api"],
      headers: preset.headers,
      authHeader: preset.authHeader,
      reasoning: preset.reasoning,
      input: preset.input,
      contextWindow: preset.contextWindow,
      maxTokens: preset.maxTokens,
      compat: preset.compat,
    }) as PiRunnerProviderConfig;
  }

  if (!runRequest.provider) {
    throw new HttpError(400, "bad_request", "Either providerPresetId or provider is required");
  }

  return runRequest.provider;
}

function appendApprovalDecisionEvent(store: RunStore, approval: ApprovalRequest): void {
  const run = store.getRun(approval.runId);
  if (!run) {
    return;
  }
  store.appendEvent(approval.runId, approval.status === "approved" ? "approval_approved" : "approval_denied", {
    approvalId: approval.id,
    status: approval.status,
    resolvedBy: approval.resolvedBy,
    decisionReason: approval.decisionReason,
  });
}

function createRunApprovalHandler(options: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly appendAndMaybeStream: (type: RunEventType, data: unknown) => RunEventEnvelope | undefined;
  readonly streamEnvelope: (envelope: RunEventEnvelope) => void;
  readonly signal?: AbortSignal;
}): PiRunnerRunOptions["onApprovalRequired"] {
  return async (request: PiRunnerApprovalRequest) => {
    const approval = options.store.createApprovalRequest(
      toCreateApprovalRequestInput(options.run, request),
      new Date().toISOString(),
    );
    const waitingAt = new Date().toISOString();
    options.store.markRunWaitingForApproval(options.run.id, waitingAt);
    const requestEvent = options.appendAndMaybeStream("approval_requested", {
      approvalId: approval.id,
      toolCallId: approval.toolCallId,
      actionType: approval.actionType,
      risk: approval.risk,
      title: approval.title,
      description: approval.description,
      payload: approval.payload,
      expiresAt: approval.expiresAt,
    });

    const resolvedApproval = await waitForApprovalDecision(options.store, approval.id, options.signal);
    options.store.markRunRunning(options.run.id, new Date().toISOString());
    streamOrAppendApprovalDecisionEvent({
      store: options.store,
      approval: resolvedApproval,
      afterSeq: requestEvent?.seq ?? 0,
      appendAndMaybeStream: options.appendAndMaybeStream,
      streamEnvelope: options.streamEnvelope,
    });

    if (resolvedApproval.status === "approved") {
      return {
        approved: true,
        approvalId: resolvedApproval.id,
        reason: resolvedApproval.decisionReason,
      };
    }

    return {
      approved: false,
      approvalId: resolvedApproval.id,
      reason:
        resolvedApproval.decisionReason ??
        `Ling Stack approval ${resolvedApproval.status} for ${resolvedApproval.actionType}.`,
    };
  };
}

function toCreateApprovalRequestInput(run: RunSession, request: PiRunnerApprovalRequest): CreateApprovalRequestInput {
  const payload = toApprovalPayload(request);
  const risk = classifyApprovalRisk(request, payload);
  return {
    runId: run.id,
    taskId: run.taskId,
    channelId: run.channelId,
    toolCallId: request.toolCallId,
    actionType: request.toolName,
    risk,
    title: approvalTitle(request.toolName, risk),
    description: approvalDescription(request.toolName, payload),
    payload,
    expiresAt: new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString(),
  };
}

function toApprovalPayload(request: PiRunnerApprovalRequest): ApprovalPayload {
  if (request.toolName === "bash") {
    const command = readInputString(request.input, "command", "");
    return {
      type: "bash",
      cwd: request.cwd,
      command,
      riskFlags: classifyBashRiskFlags(command),
    };
  }

  if (request.toolName === "write") {
    const path = readInputString(request.input, "path", "<unknown>");
    const content = readInputString(request.input, "content", "");
    return {
      type: "file_write",
      path,
      bytes: Buffer.byteLength(content, "utf8"),
      preview: truncatePreview(content),
    };
  }

  const path = readInputString(request.input, "path", "<unknown>");
  return {
    type: "file_edit",
    path,
    diffPreview: truncatePreview(formatEditPreview(readInputArray(request.input, "edits"))),
  };
}

function classifyApprovalRisk(request: PiRunnerApprovalRequest, payload: ApprovalPayload): ApprovalRisk {
  if (payload.type === "bash") {
    return payload.riskFlags.length > 0 ? "high" : "medium";
  }

  if (payload.type === "file_write" && isOutsideWorkspace(payload.path, request.cwd)) {
    return "high";
  }

  if (payload.type === "file_edit" && isOutsideWorkspace(payload.path, request.cwd)) {
    return "high";
  }

  return "medium";
}

function approvalTitle(toolName: PiRunnerApprovalRequest["toolName"], risk: ApprovalRisk): string {
  if (toolName === "bash") {
    return risk === "high" ? "Approve high-risk shell command" : "Approve shell command";
  }
  if (toolName === "write") {
    return "Approve file write";
  }
  return "Approve file edit";
}

function approvalDescription(toolName: PiRunnerApprovalRequest["toolName"], payload: ApprovalPayload): string {
  if (payload.type === "bash") {
    return payload.command || "The agent requested a shell command.";
  }
  if (payload.type === "file_write") {
    return `The agent requested writing ${payload.bytes} bytes to ${payload.path}.`;
  }
  if (payload.type === "file_edit") {
    return `The agent requested editing ${payload.path}.`;
  }
  return `The agent requested ${toolName}.`;
}

async function waitForApprovalDecision(store: RunStore, approvalId: string, signal?: AbortSignal): Promise<ApprovalRequest> {
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    throwIfAborted(signal);
    const approval = store.getApprovalRequest(approvalId);
    if (!approval) {
      throw new Error(`Approval request not found: ${approvalId}`);
    }
    if (approval.status !== "pending") {
      return approval;
    }
    await delay(APPROVAL_POLL_INTERVAL_MS);
  }

  const expired = store.denyApprovalRequest(
    approvalId,
    { reason: "Approval request timed out before a decision was received." },
    new Date().toISOString(),
  );
  if (!expired) {
    throw new Error(`Approval request not found after timeout: ${approvalId}`);
  }
  appendApprovalDecisionEvent(store, expired);
  return expired;
}

function streamOrAppendApprovalDecisionEvent(options: {
  readonly store: RunStore;
  readonly approval: ApprovalRequest;
  readonly afterSeq: number;
  readonly appendAndMaybeStream: (type: RunEventType, data: unknown) => RunEventEnvelope | undefined;
  readonly streamEnvelope: (envelope: RunEventEnvelope) => void;
}): void {
  const existingEvent = findApprovalDecisionEvent(options.store, options.approval, options.afterSeq);
  if (existingEvent) {
    options.streamEnvelope(existingEvent);
    return;
  }

  options.appendAndMaybeStream(options.approval.status === "approved" ? "approval_approved" : "approval_denied", {
    approvalId: options.approval.id,
    status: options.approval.status,
    resolvedBy: options.approval.resolvedBy,
    decisionReason: options.approval.decisionReason,
  });
}

function findApprovalDecisionEvent(
  store: RunStore,
  approval: ApprovalRequest,
  afterSeq: number,
): RunEventEnvelope | undefined {
  return store
    .listEvents(approval.runId, { afterSeq, limit: 1000 })
    .find(
      (event) =>
        (event.type === "approval_approved" || event.type === "approval_denied") &&
        isRecord(event.data) &&
        event.data.approvalId === approval.id,
    );
}

function classifyBashRiskFlags(command: string): string[] {
  const checks: Array<[RegExp, string]> = [
    [/\brm\s+-(?:[^\n]*r[^\n]*f|[^\n]*f[^\n]*r)\b/i, "destructive_remove"],
    [/\bgit\s+reset\s+--hard\b/i, "git_reset_hard"],
    [/\bgit\s+push\b[^\n]*--force\b/i, "git_force_push"],
    [/\bsudo\b/i, "sudo"],
    [/\b(?:chmod|chown)\s+-R\b/i, "recursive_permission_change"],
    [/\b(?:dd|mkfs|diskutil)\b/i, "disk_mutation"],
    [/\b(?:kubectl|helm|flyctl|vercel|netlify|aws|gcloud|az)\b[^\n]*\b(?:apply|delete|deploy|destroy|terminate)\b/i, "external_mutation"],
    [/\b(?:curl|wget)\b[^\n|;]*\|\s*(?:sh|bash)\b/i, "remote_script_execution"],
  ];
  return checks.filter(([pattern]) => pattern.test(command)).map(([, flag]) => flag);
}

function isOutsideWorkspace(inputPath: string, cwd: string): boolean {
  if (inputPath === "<unknown>") {
    return true;
  }
  const absolutePath = isAbsolute(inputPath) ? inputPath : resolvePath(cwd, inputPath);
  const relativePath = relative(cwd, absolutePath);
  return relativePath.startsWith("..") || isAbsolute(relativePath);
}

function formatEditPreview(edits: readonly unknown[]): string {
  if (edits.length === 0) {
    return "No edit preview was provided.";
  }
  return edits
    .map((edit, index) => {
      if (!isRecord(edit)) {
        return `#${index + 1}\n<invalid edit entry>`;
      }
      const oldText = readInputString(edit, "oldText", "");
      const newText = readInputString(edit, "newText", "");
      return `#${index + 1}\n- ${truncatePreview(oldText, 320)}\n+ ${truncatePreview(newText, 320)}`;
    })
    .join("\n\n");
}

function readInputString(input: unknown, key: string, fallback: string): string {
  if (!isRecord(input)) {
    return fallback;
  }
  const value = input[key];
  return typeof value === "string" ? value : fallback;
}

function readInputArray(input: unknown, key: string): unknown[] {
  if (!isRecord(input)) {
    return [];
  }
  const value = input[key];
  return Array.isArray(value) ? value : [];
}

function truncatePreview(value: string, limit = APPROVAL_PREVIEW_LIMIT): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw createAbortError();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function createAbortError(): Error {
  const error = new Error("Run cancelled.");
  error.name = "AbortError";
  return error;
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error(`Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    throw new Error("Request body is required");
  }

  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

async function readOptionalJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown | undefined> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error(`Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function parseRunRequest(value: unknown): RunRequest {
  if (!isRecord(value)) {
    throw new Error("Run request must be a JSON object");
  }

  const cwd = readString(value, "cwd");
  const workspaceCwd = readOptionalString(value, "workspaceCwd");
  const task = value.task;
  const provider = value.provider;
  const providerPresetId = readOptionalString(value, "providerPresetId");

  if (!isRecord(task)) {
    throw new Error("task must be an object");
  }
  if (provider !== undefined && !isRecord(provider)) {
    throw new Error("provider must be an object");
  }
  if (providerPresetId && provider !== undefined) {
    throw new Error("providerPresetId and provider cannot both be supplied");
  }
  if (!providerPresetId && provider === undefined) {
    throw new Error("Either providerPresetId or provider is required");
  }

  const runRequest: RunRequest = {
    cwd,
    workspaceCwd,
    providerPresetId,
    task: {
      id: readString(task, "id"),
      title: readString(task, "title"),
      prompt: readString(task, "prompt"),
      channelId: readOptionalString(task, "channelId"),
    },
    provider: provider ? parseInlineProvider(provider) : undefined,
    tools: readOptionalStringArray(value, "tools", ["read", "bash", "edit", "write", "grep", "find", "ls"]) ?? [...readOnlyRunTools],
    thinkingLevel: readOptionalThinkingLevel(value, "thinkingLevel"),
    systemPrompt: readOptionalString(value, "systemPrompt"),
    appendSystemPrompt: readOptionalStringArray(value, "appendSystemPrompt"),
    agentDir: readOptionalString(value, "agentDir"),
  };

  return runRequest;
}

function parseInlineProvider(provider: Record<string, unknown>): PiRunnerProviderConfig {
  return {
    provider: readString(provider, "provider"),
    model: readString(provider, "model"),
    displayName: readOptionalString(provider, "displayName"),
    apiKey: readOptionalString(provider, "apiKey"),
    baseUrl: readOptionalString(provider, "baseUrl"),
    api: readOptionalProviderApi(provider, "api"),
    headers: readOptionalStringRecord(provider, "headers"),
    authHeader: readOptionalBoolean(provider, "authHeader"),
    reasoning: readOptionalBoolean(provider, "reasoning"),
    input: readOptionalStringArray(provider, "input", ["text", "image"]),
    contextWindow: readOptionalNumber(provider, "contextWindow"),
    maxTokens: readOptionalNumber(provider, "maxTokens"),
    compat: isRecord(provider.compat) ? provider.compat : undefined,
  };
}

function parseRunRoute(pathname: string): { kind: "run"; runId: string } | { kind: "events"; runId: string } | { kind: "cancel"; runId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "runs") {
    return { kind: "run", runId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "runs" && segments[2] === "events") {
    return { kind: "events", runId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "runs" && segments[2] === "cancel") {
    return { kind: "cancel", runId: segments[1] };
  }
  return undefined;
}

function parseChannelRoute(pathname: string): { readonly channelId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "channels") {
    return { channelId: segments[1] };
  }
  return undefined;
}

function parseTaskRoute(pathname: string): { readonly taskId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "tasks") {
    return { taskId: segments[1] };
  }
  return undefined;
}

function parseProviderRoute(pathname: string): { readonly providerId: string; readonly action?: "check" } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "providers") {
    return { providerId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "providers" && segments[2] === "check") {
    return { providerId: segments[1], action: "check" };
  }
  return undefined;
}

function parseApprovalRoute(pathname: string): { readonly approvalId: string; readonly action?: "approve" | "deny" } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "approvals") {
    return { approvalId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "approvals" && (segments[2] === "approve" || segments[2] === "deny")) {
    return { approvalId: segments[1], action: segments[2] };
  }
  return undefined;
}

function parseCreateChannelInput(value: unknown): CreateChannelInput {
  if (!isRecord(value)) {
    throw new Error("Channel request must be a JSON object");
  }
  const input: CreateChannelInput = {
    name: readString(value, "name"),
    boundPath: readOptionalString(value, "boundPath"),
    defaultProviderPresetId: readOptionalString(value, "defaultProviderPresetId"),
    defaultTeammateId: readOptionalString(value, "defaultTeammateId"),
    allowedTools: readOptionalRunTools(value, "allowedTools"),
  };
  validateChannelInput(input);
  return input;
}

function parseChannelUpdateInput(value: unknown): ChannelUpdateInput {
  if (!isRecord(value)) {
    throw new Error("Channel update must be a JSON object");
  }
  const input: ChannelUpdateInput = {
    name: readOptionalString(value, "name"),
    boundPath: readNullableString(value, "boundPath"),
    defaultProviderPresetId: readNullableString(value, "defaultProviderPresetId"),
    defaultTeammateId: readNullableString(value, "defaultTeammateId"),
    allowedTools: readOptionalRunTools(value, "allowedTools"),
  };
  validateChannelInput(input);
  return input;
}

function validateChannelInput(input: ChannelUpdateInput): void {
  if (input.name !== undefined && input.name.trim().length === 0) {
    throw new Error("name must be a non-empty string");
  }
  if (input.allowedTools !== undefined && input.allowedTools.length === 0) {
    throw new Error("allowedTools must contain at least one tool");
  }
}

function parseCreateTaskInput(value: unknown): CreateTaskInput {
  if (!isRecord(value)) {
    throw new Error("Task request must be a JSON object");
  }
  const input: CreateTaskInput = {
    channelId: readString(value, "channelId"),
    title: readString(value, "title"),
    prompt: readString(value, "prompt"),
    status: readOptionalTaskStatus(value, "status"),
    assigneeTeammateId: readOptionalString(value, "assigneeTeammateId"),
  };
  validateTaskInput(input);
  return input;
}

function parseTaskUpdateInput(value: unknown): TaskUpdateInput {
  if (!isRecord(value)) {
    throw new Error("Task update must be a JSON object");
  }
  const input: TaskUpdateInput = {
    channelId: readOptionalString(value, "channelId"),
    title: readOptionalString(value, "title"),
    prompt: readOptionalString(value, "prompt"),
    status: readOptionalTaskStatus(value, "status"),
    assigneeTeammateId: readNullableString(value, "assigneeTeammateId"),
    currentRunId: readNullableString(value, "currentRunId"),
  };
  validateTaskInput(input);
  return input;
}

function validateTaskInput(input: TaskUpdateInput): void {
  if (input.channelId !== undefined && input.channelId.trim().length === 0) {
    throw new Error("channelId must be a non-empty string");
  }
  if (input.title !== undefined && input.title.trim().length === 0) {
    throw new Error("title must be a non-empty string");
  }
  if (input.prompt !== undefined && input.prompt.trim().length === 0) {
    throw new Error("prompt must be a non-empty string");
  }
}

function parseProviderPresetInput(value: unknown): ProviderPresetInput {
  if (!isRecord(value)) {
    throw new Error("Provider preset request must be a JSON object");
  }
  return validateProviderPresetInput({
    kind: readProviderKind(value, "kind"),
    displayName: readString(value, "displayName"),
    providerId: readString(value, "providerId"),
    model: readString(value, "model"),
    api: readProviderApi(value, "api"),
    baseUrl: readOptionalString(value, "baseUrl"),
    apiKeyRef: readOptionalApiKeyRef(value),
    headers: readOptionalStringRecord(value, "headers"),
    authHeader: readOptionalBoolean(value, "authHeader"),
    reasoning: readOptionalBoolean(value, "reasoning"),
    input: readOptionalStringArray(value, "input", ["text", "image"]),
    contextWindow: readOptionalNumber(value, "contextWindow"),
    maxTokens: readOptionalNumber(value, "maxTokens"),
    compat: isRecord(value.compat) ? value.compat : undefined,
    capabilities: readProviderCapabilities(value, "capabilities"),
    enabled: readOptionalBoolean(value, "enabled"),
  });
}

function parseProviderPresetUpdateInput(value: unknown): ProviderPresetUpdateInput {
  if (!isRecord(value)) {
    throw new Error("Provider preset update must be a JSON object");
  }

  const input: ProviderPresetUpdateInput = {
    kind: value.kind === undefined ? undefined : readProviderKind(value, "kind"),
    displayName: readOptionalString(value, "displayName"),
    providerId: readOptionalString(value, "providerId"),
    model: readOptionalString(value, "model"),
    api: value.api === undefined ? undefined : readProviderApi(value, "api"),
    baseUrl: readNullableString(value, "baseUrl"),
    apiKeyRef: readNullableApiKeyRef(value),
    headers: readOptionalStringRecord(value, "headers"),
    authHeader: readNullableBoolean(value, "authHeader"),
    reasoning: readNullableBoolean(value, "reasoning"),
    input: readOptionalStringArray(value, "input", ["text", "image"]),
    contextWindow: readNullableNumber(value, "contextWindow"),
    maxTokens: readNullableNumber(value, "maxTokens"),
    compat: isRecord(value.compat) ? value.compat : undefined,
    capabilities: value.capabilities === undefined ? undefined : readProviderCapabilities(value, "capabilities"),
    enabled: readOptionalBoolean(value, "enabled"),
  };

  return input;
}

function validateProviderPresetInput(input: ProviderPresetInput): ProviderPresetInput {
  validateProviderPresetShape(input);
  return input;
}

function validateProviderPresetUpdate(existing: ProviderPreset, input: ProviderPresetUpdateInput): void {
  validateProviderPresetShape({
    kind: input.kind ?? existing.kind,
    displayName: input.displayName ?? existing.displayName,
    providerId: input.providerId ?? existing.providerId,
    model: input.model ?? existing.model,
    api: input.api ?? existing.api,
    baseUrl: input.baseUrl === null ? undefined : input.baseUrl ?? existing.baseUrl,
    apiKeyRef: input.apiKeyRef === null ? undefined : input.apiKeyRef ?? existing.apiKeyRef,
    capabilities: input.capabilities ?? existing.capabilities,
  });
}

function validateProviderPresetShape(input: {
  readonly kind?: ProviderKind;
  readonly displayName?: string;
  readonly providerId?: string;
  readonly model?: string;
  readonly api?: ProviderApi;
  readonly baseUrl?: string | null;
  readonly apiKeyRef?: string | null;
  readonly capabilities?: readonly ProviderCapability[];
}): void {
  if (!input.displayName?.trim()) {
    throw new Error("displayName must be a non-empty string");
  }
  if (!input.providerId?.trim()) {
    throw new Error("providerId must be a non-empty string");
  }
  if (input.providerId && !/^[A-Za-z0-9._-]+$/.test(input.providerId)) {
    throw new Error("providerId may only contain letters, numbers, dot, underscore, and dash");
  }
  if (!input.model?.trim()) {
    throw new Error("model must be a non-empty string");
  }
  if (input.kind === "openai-compatible" && !input.baseUrl) {
    throw new Error("baseUrl is required for openai-compatible providers");
  }
  if (input.baseUrl) {
    validateUrl(input.baseUrl, "baseUrl");
  }
  if (input.apiKeyRef && !isSupportedSecretRef(input.apiKeyRef)) {
    throw new Error("apiKeyRef must use env:NAME");
  }
  if (!input.capabilities || input.capabilities.length === 0) {
    throw new Error("capabilities must contain at least one capability");
  }
  if (input.api === "media-job") {
    const hasMediaCapability = input.capabilities.some((capability) =>
      ["image_generate", "image_edit", "video_generate"].includes(capability),
    );
    if (!hasMediaCapability) {
      throw new Error("media-job providers must include a media capability");
    }
    return;
  }
  if (!input.capabilities.includes("chat")) {
    throw new Error("coding provider presets must include chat capability");
  }
}

function toPublicProviderPreset(preset: ProviderPreset): PublicProviderPreset {
  return {
    ...preset,
    apiKeyConfigured: resolveSecretRef(preset.apiKeyRef).configured,
  };
}

function checkProviderPreset(preset: ProviderPreset): ProviderCheckResult {
  const checkedAt = new Date().toISOString();
  if (!preset.enabled) {
    return { ok: false, code: "provider_disabled", message: "Provider preset is disabled.", checkedAt };
  }
  if (preset.baseUrl) {
    try {
      validateUrl(preset.baseUrl, "baseUrl");
    } catch (error) {
      return { ok: false, code: "bad_request", message: error instanceof Error ? error.message : String(error), checkedAt };
    }
  }
  if (preset.apiKeyRef && !resolveSecretRef(preset.apiKeyRef).configured) {
    return { ok: false, code: "secret_missing", message: `Secret is not configured: ${preset.apiKeyRef}`, checkedAt };
  }
  if (preset.api !== "media-job" && !preset.capabilities.includes("chat")) {
    return { ok: false, code: "unsupported_capability", message: "Provider preset cannot run chat tasks.", checkedAt };
  }
  return { ok: true, message: "Provider preset configuration is valid.", checkedAt };
}

function resolveConfig(config: DaemonConfig): ResolvedDaemonConfig {
  return {
    host: config.host ?? "127.0.0.1",
    port: config.port ?? 17891,
    maxBodyBytes: config.maxBodyBytes ?? 1024 * 1024,
  };
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  setCorsHeaders(response);
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

function writeSseHead(response: ServerResponse): void {
  setCorsHeaders(response);
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write(": ling-stack run stream\n\n");
}

function writeSse(response: ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function readNullableString(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string or null`);
  }
  return value;
}

function readOptionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function readNullableBoolean(record: Record<string, unknown>, key: string): boolean | null | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean or null`);
  }
  return value;
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}

function readNullableNumber(record: Record<string, unknown>, key: string): number | null | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number or null`);
  }
  return value;
}

function readOptionalStringRecord(record: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  const result: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== "string") {
      throw new Error(`${key}.${entryKey} must be a string`);
    }
    result[entryKey] = entryValue;
  }
  return result;
}

function readOptionalApiKeyRef(record: Record<string, unknown>): string | undefined {
  const value = readOptionalString(record, "apiKeyRef");
  if (value && !isSupportedSecretRef(value)) {
    throw new Error("apiKeyRef must use env:NAME");
  }
  return value;
}

function readNullableApiKeyRef(record: Record<string, unknown>): string | null | undefined {
  const value = readNullableString(record, "apiKeyRef");
  if (typeof value === "string" && !isSupportedSecretRef(value)) {
    throw new Error("apiKeyRef must use env:NAME");
  }
  return value;
}

function readOptionalStringArray<T extends string = string>(
  record: Record<string, unknown>,
  key: string,
  allowed?: readonly T[],
): T[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`${key}[${index}] must be a string`);
    }
    if (allowed && !allowed.includes(item as T)) {
      throw new Error(`${key}[${index}] must be one of: ${allowed.join(", ")}`);
    }
    return item as T;
  });
}

function readOptionalRunTools(record: Record<string, unknown>, key: string): RunTool[] | undefined {
  return readOptionalStringArray(record, key, [...readOnlyRunTools, "bash", "edit", "write"] as const);
}

function readOptionalTaskStatus(record: Record<string, unknown>, key: string): TaskStatus | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!taskStatuses.includes(value as TaskStatus)) {
    throw new Error(`${key} must be one of: ${taskStatuses.join(", ")}`);
  }
  return value as TaskStatus;
}

function readProviderKind(record: Record<string, unknown>, key: string): ProviderKind {
  const value = readString(record, key);
  if (!providerKinds.includes(value as ProviderKind)) {
    throw new Error(`${key} must be one of: ${providerKinds.join(", ")}`);
  }
  return value as ProviderKind;
}

function readProviderApi(record: Record<string, unknown>, key: string): ProviderApi {
  const value = readString(record, key);
  if (!providerApis.includes(value as ProviderApi)) {
    throw new Error(`${key} must be one of: ${providerApis.join(", ")}`);
  }
  return value as ProviderApi;
}

function readProviderCapabilities(record: Record<string, unknown>, key: string): ProviderCapability[] {
  return readOptionalStringArray(record, key, providerCapabilities)?.map((capability) => capability as ProviderCapability) ?? [];
}

function readOptionalThinkingLevel(record: Record<string, unknown>, key: string): RunRequest["thinkingLevel"] {
  return readOptionalStringArray({ [key]: record[key] === undefined ? undefined : [record[key]] }, key, [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ])?.[0];
}

function readOptionalProviderApi(record: Record<string, unknown>, key: string): PiRunnerProviderConfig["api"] {
  return readOptionalStringArray({ [key]: record[key] === undefined ? undefined : [record[key]] }, key, [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
    "mistral-conversations",
  ])?.[0];
}

function readOptionalIntegerQuery(url: URL, key: string, minValue: number): number | undefined {
  const rawValue = url.searchParams.get(key);
  if (rawValue === null) {
    return undefined;
  }
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(value) || value < minValue || String(value) !== rawValue) {
    throw new Error(`${key} must be an integer greater than or equal to ${minValue}`);
  }
  return value;
}

function readOptionalRunStatusQuery(url: URL): RunStatus | undefined {
  const value = url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (!["queued", "running", "waiting_for_approval", "succeeded", "failed", "cancelled"].includes(value)) {
    throw new Error("status must be one of: queued, running, waiting_for_approval, succeeded, failed, cancelled");
  }
  return value as RunStatus;
}

function readOptionalTaskStatusQuery(url: URL): TaskStatus | undefined {
  const value = url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (!taskStatuses.includes(value as TaskStatus)) {
    throw new Error(`status must be one of: ${taskStatuses.join(", ")}`);
  }
  return value as TaskStatus;
}

function readOptionalApprovalStatusQuery(url: URL): ApprovalStatus | undefined {
  const value = url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (!approvalStatuses.includes(value as ApprovalStatus)) {
    throw new Error(`status must be one of: ${approvalStatuses.join(", ")}`);
  }
  return value as ApprovalStatus;
}

function validateUrl(value: string, fieldName: string): void {
  try {
    new URL(value);
  } catch {
    throw new Error(`${fieldName} must be a valid URL`);
  }
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface ActiveRun {
  readonly abortController: AbortController;
  readonly streamEnvelope: (envelope: RunEventEnvelope) => void;
}

class ActiveRunRegistry {
  private readonly activeRuns = new Map<string, ActiveRun>();

  add(runId: string, run: ActiveRun): void {
    this.activeRuns.set(runId, run);
  }

  get(runId: string): ActiveRun | undefined {
    return this.activeRuns.get(runId);
  }

  delete(runId: string): void {
    this.activeRuns.delete(runId);
  }

  cancelAll(): void {
    for (const run of this.activeRuns.values()) {
      run.abortController.abort();
    }
    this.activeRuns.clear();
  }
}

class RunStoreRegistry {
  private readonly storesByCwd = new Map<string, RunStore>();
  private readonly storesByRunId = new Map<string, RunStore>();

  constructor(private readonly storeFactory: RunStoreFactory) {}

  getStore(cwd: string): RunStore {
    const existing = this.storesByCwd.get(cwd);
    if (existing) {
      return existing;
    }

    const store = this.storeFactory(cwd);
    store.recoverStaleRuns(new Date().toISOString());
    this.storesByCwd.set(cwd, store);
    return store;
  }

  rememberRun(runId: string, store: RunStore): void {
    this.storesByRunId.set(runId, store);
  }

  findStoreForRun(runId: string, cwd?: string): RunStore | undefined {
    if (cwd) {
      return this.getStore(cwd);
    }

    const knownStore = this.storesByRunId.get(runId);
    if (knownStore?.getRun(runId)) {
      return knownStore;
    }

    for (const store of this.storesByCwd.values()) {
      if (store.getRun(runId)) {
        this.rememberRun(runId, store);
        return store;
      }
    }

    return undefined;
  }

  closeAll(): void {
    for (const store of this.storesByCwd.values()) {
      store.close();
    }
    this.storesByCwd.clear();
    this.storesByRunId.clear();
  }
}
