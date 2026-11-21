import { createHash } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { LING_PRODUCT_VERSION } from "@ling-stack/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { connectToAppServer, type AppServerLocalTransportOptions } from "./app-server-local-transport.js";

const objectId = z.string().min(1).max(256);
const requestKey = z.string().min(1).max(128);

export async function runLingAppServerMcp(
  options: AppServerLocalTransportOptions,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const client = connectToAppServer(options, "ling-mcp");
  const server = new McpServer({ name: "ling-app-server", version: LING_PRODUCT_VERSION });
  const describe = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
  server.registerTool("ling_thread_read", {
    description: "Read a Ling Thread and its current Goal.",
    inputSchema: z.strictObject({ threadId: objectId }),
    annotations: { readOnlyHint: true },
  }, async ({ threadId }) => describe(await client.readThread(threadId)));
  server.registerTool("ling_thread_events", {
    description: "Read a page of Ling Thread events. Use window.nextAfterSeq as the next cursor.",
    inputSchema: z.strictObject({ threadId: objectId, cursor: z.string().regex(/^\d+$/u).optional() }),
    annotations: { readOnlyHint: true },
  }, async ({ threadId, cursor }) => describe(await client.readThreadEvents({ threadId, cursor, limit: 1 })));

  if (options.authToken) {
    server.registerTool("ling_thread_start", {
      description: "Create a Ling Thread in the connected workspace. Use the same request key when retrying.",
      inputSchema: z.strictObject({ title: z.string().min(1).max(200), idempotencyKey: requestKey }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async ({ title, idempotencyKey }) => describe(await client.startThread({
      title, threadId: `thread_mcp_${createHash("sha256").update(idempotencyKey).digest("hex")}`,
    })));
    server.registerTool("ling_turn_start", {
      description: "Submit a Turn to Ling using a configured provider preset. Use the same key when retrying.",
      inputSchema: z.strictObject({
        threadId: objectId, message: z.string().min(1).max(16_384), providerPresetId: objectId, idempotencyKey: requestKey,
      }),
      annotations: { idempotentHint: true },
    }, async params => describe(await client.startTurn(params)));
    server.registerTool("ling_turn_interrupt", {
      description: "Request a stop for the current Run on a Ling Turn.",
      inputSchema: z.strictObject({ turnId: objectId }),
    }, async ({ turnId }) => describe(await client.interruptTurn({ turnId })));
  }

  const transport = new StdioServerTransport(input, output, { maxBufferSize: 1024 * 1024 });
  const closed = new Promise<void>(resolve => {
    server.server.onclose = resolve;
    input.once("end", resolve);
    input.once("close", resolve);
  });
  try {
    await server.connect(transport);
    await closed;
  } finally {
    client.close();
    await server.close();
  }
}
