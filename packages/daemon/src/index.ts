import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  createRunId,
  createSqliteRunStore,
  getRunSummaryPath,
  writeRunSummary,
  type RunEventEnvelope,
  type RunEventType,
  type RunSession,
  type RunStore,
  type RunSummary,
} from "@ling-stack/core";
import {
  createPiRunner,
  type PiRunnerEvent,
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

export type RunRequest = Omit<PiRunnerRunOptions, "onEvent">;

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
  const server = createServer(async (request, response) => {
    try {
      await routeRequest(request, response, resolvedConfig, runner, storeRegistry);
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

  if (request.method === "POST" && url.pathname === "/runs") {
    await handleRun(request, response, config, runner, storeRegistry);
    return;
  }

  const runRoute = parseRunRoute(url.pathname);
  if (request.method === "GET" && runRoute?.kind === "run") {
    handleGetRun(response, url, storeRegistry, runRoute.runId);
    return;
  }
  if (request.method === "GET" && runRoute?.kind === "events") {
    handleGetRunEvents(response, url, storeRegistry, runRoute.runId);
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
  try {
    store = storeRegistry.getStore(runRequest.cwd);
    const runId = createRunId();
    const createdAt = new Date().toISOString();
    run = store.createRun({
      id: runId,
      cwd: runRequest.cwd,
      taskId: runRequest.task.id,
      channelId: runRequest.task.channelId,
      providerName: runRequest.provider.provider,
      providerModel: runRequest.provider.model,
      taskSnapshot: runRequest.task,
      providerSnapshot: runRequest.provider,
      requestSnapshot: runRequest,
      createdAt,
    });
    storeRegistry.rememberRun(run.id, store);
    store.appendEvent(run.id, "run_created", {
      taskId: run.taskId,
      cwd: run.cwd,
      providerName: run.providerName,
      providerModel: run.providerModel,
    });
  } catch (error) {
    writeJson(response, 500, {
      error: "run_storage_unavailable",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  writeSseHead(response);
  writeSse(response, "ready", { ok: true, runId: run.id });

  let clientClosed = false;
  let runStartedAt: string | undefined;
  let persistedRunError = false;
  let persistenceError: unknown;
  response.on("close", () => {
    clientClosed = true;
  });

  const appendAndMaybeStream = (type: RunEventType, data: unknown): RunEventEnvelope | undefined => {
    if (persistenceError) {
      return undefined;
    }

    try {
      const envelope = store.appendEvent(run.id, type, data);
      if (type === "run_error") {
        persistedRunError = true;
      }
      if (!clientClosed) {
        writeSse(response, envelope.type, envelope);
      }
      return envelope;
    } catch (error) {
      persistenceError = error;
      return undefined;
    }
  };

  try {
    runStartedAt = new Date().toISOString();
    store.markRunStarted(run.id, runStartedAt);

    const result = await runner.runTask({
      ...runRequest,
      onEvent: (event: PiRunnerEvent) => {
        appendAndMaybeStream(event.type, event);
      },
    });

    if (persistenceError) {
      throw persistenceError;
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

    if (!clientClosed) {
      response.end();
    }
  } catch (error) {
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

    if (!clientClosed) {
      response.end();
    }
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

function parseRunRequest(value: unknown): RunRequest {
  if (!isRecord(value)) {
    throw new Error("Run request must be a JSON object");
  }

  const cwd = readString(value, "cwd");
  const task = value.task;
  const provider = value.provider;

  if (!isRecord(task)) {
    throw new Error("task must be an object");
  }
  if (!isRecord(provider)) {
    throw new Error("provider must be an object");
  }

  const runRequest: RunRequest = {
    cwd,
    task: {
      id: readString(task, "id"),
      title: readString(task, "title"),
      prompt: readString(task, "prompt"),
      channelId: readOptionalString(task, "channelId"),
    },
    provider: {
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
    },
    tools: readOptionalStringArray(value, "tools", ["read", "bash", "edit", "write", "grep", "find", "ls"]),
    thinkingLevel: readOptionalThinkingLevel(value, "thinkingLevel"),
    systemPrompt: readOptionalString(value, "systemPrompt"),
    appendSystemPrompt: readOptionalStringArray(value, "appendSystemPrompt"),
    agentDir: readOptionalString(value, "agentDir"),
  };

  return runRequest;
}

function parseRunRoute(pathname: string): { kind: "run"; runId: string } | { kind: "events"; runId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "runs") {
    return { kind: "run", runId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "runs" && segments[2] === "events") {
    return { kind: "events", runId: segments[1] };
  }
  return undefined;
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
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
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

function readOptionalProviderApi(record: Record<string, unknown>, key: string): RunRequest["provider"]["api"] {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
