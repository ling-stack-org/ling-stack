import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createPiRunner, type PiRunnerEvent, type PiRunnerRunOptions } from "@ling-stack/runner-pi";

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

export function createDaemonServer(config: DaemonConfig = defaultDaemonConfig): DaemonServer {
  const resolvedConfig = resolveConfig(config);
  const runner = createPiRunner();
  const server = createServer(async (request, response) => {
    try {
      await routeRequest(request, response, resolvedConfig, runner);
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
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

export async function startDaemon(config: DaemonConfig = defaultDaemonConfig): Promise<DaemonServer> {
  const daemon = createDaemonServer(config);
  await daemon.start();
  return daemon;
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  runner: ReturnType<typeof createPiRunner>,
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
    await handleRun(request, response, config, runner);
    return;
  }

  writeJson(response, 404, { error: "not_found", message: `No route for ${request.method} ${url.pathname}` });
}

async function handleRun(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  runner: ReturnType<typeof createPiRunner>,
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

  writeSseHead(response);
  writeSse(response, "ready", { ok: true });

  let clientClosed = false;
  response.on("close", () => {
    clientClosed = true;
  });

  try {
    const result = await runner.runTask({
      ...runRequest,
      onEvent: (event: PiRunnerEvent) => {
        if (!clientClosed) {
          writeSse(response, event.type, event);
        }
      },
    });

    if (!clientClosed) {
      writeSse(response, "result", {
        taskId: result.taskId,
        messageCount: result.messages.length,
        eventCount: result.events.length,
      });
      response.end();
    }
  } catch (error) {
    if (!clientClosed) {
      writeSse(response, "error", {
        error: "run_failed",
        message: error instanceof Error ? error.message : String(error),
      });
      response.end();
    }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
