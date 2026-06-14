import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { acpCapabilityKeys, LING_ACP_PROTOCOL_VERSION, type AcpCapabilities, type AcpRunResult } from "./protocol.js";

export interface FakeAcpServerOptions {
  readonly protocolVersion?: string;
  readonly capabilities?: Partial<AcpCapabilities>;
  readonly malformedInitializeResponse?: boolean;
  readonly malformedRunResponse?: boolean;
  readonly statusCode?: number;
  readonly runResult?: AcpRunResult;
}

export interface FakeAcpServer {
  readonly endpoint: string;
  readonly requests: readonly unknown[];
  close(): Promise<void>;
}

export async function startFakeAcpServer(options: FakeAcpServerOptions = {}): Promise<FakeAcpServer> {
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    await handleFakeAcpRequest(request, response, options, requests);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake ACP server did not bind to a TCP port.");
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => closeServer(server),
  };
}

async function handleFakeAcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: FakeAcpServerOptions,
  requests: unknown[],
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: { code: -32601, message: "method not allowed" } });
    return;
  }
  const raw = await readBody(request);
  const parsed = raw ? JSON.parse(raw) as unknown : undefined;
  requests.push(parsed);
  if (options.statusCode && options.statusCode >= 400) {
    writeJson(response, options.statusCode, { error: { code: -32000, message: "fake ACP failure" } });
    return;
  }
  const requestRecord = isRecord(parsed) ? parsed : {};
  if (requestRecord.method === "session/run") {
    if (options.malformedRunResponse) {
      writeJson(response, 200, { jsonrpc: "2.0", id: requestRecord.id ?? 2, result: "bad-run-response" });
      return;
    }
    writeJson(response, 200, {
      jsonrpc: "2.0",
      id: requestRecord.id ?? 2,
      result: options.runResult ?? {
        taskId: readTaskId(requestRecord.params),
        events: [{ type: "text_delta", data: { text: "OpenClaw ACP fake response." } }],
        messages: ["OpenClaw ACP fake response."],
      },
    });
    return;
  }
  if (options.malformedInitializeResponse) {
    writeJson(response, 200, { jsonrpc: "2.0", id: 1, result: { protocolVersion: 7 } });
    return;
  }
  const capabilities = Object.fromEntries(acpCapabilityKeys.map((key) => [key, options.capabilities?.[key] ?? true]));
  writeJson(response, 200, {
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: options.protocolVersion ?? LING_ACP_PROTOCOL_VERSION,
      capabilities,
    },
  });
}

function readTaskId(params: unknown): string | undefined {
  if (!isRecord(params) || !isRecord(params.task) || typeof params.task.id !== "string") {
    return undefined;
  }
  return params.task.id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
