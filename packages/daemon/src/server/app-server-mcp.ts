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
  const methods = new Set((await client.getCapabilities().catch(error => {
    client.close();
    throw error;
  })).methods);
  const server = new McpServer({ name: "ling-app-server", version: LING_PRODUCT_VERSION });
  const describe = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
  if (methods.has("thread/read")) server.registerTool("ling_thread_read", {
    description: "Read a Ling Thread and its current Goal.",
    inputSchema: z.strictObject({ threadId: objectId }),
    annotations: { readOnlyHint: true },
  }, async ({ threadId }) => describe(await client.readThread(threadId)));
  if (methods.has("thread/snapshot")) server.registerTool("ling_thread_snapshot", {
    description: "Read the active Ling Turn, Run, Goal, pending requests, and event cursor.",
    inputSchema: z.strictObject({ threadId: objectId }),
    annotations: { readOnlyHint: true },
  }, async params => {
    const { turn, run, goal, cursor, pendingApprovals, pendingInputs } = await client.readThreadSnapshot(params);
    return describe({ turn, run, goal, cursor, pendingApprovals,
      pendingInputs: pendingInputs.map(({ answerAuthority: _authority, ...input }) => input) });
  });
  if (methods.has("thread/events/read")) server.registerTool("ling_thread_events", {
    description: "Read a page of Ling Thread events. Use the returned cursor to continue reading; use a Thread snapshot if resync is required.",
    inputSchema: z.strictObject({ threadId: objectId, cursor: z.string().min(1).max(128).optional() }),
    annotations: { readOnlyHint: true },
  }, async ({ threadId, cursor }) => describe(await client.readThreadEvents({ threadId, cursor, limit: 1 })));

  if (methods.has("workItem/read")) server.registerTool("ling_work_item_read", {
    description: "Read the Work Item, its current control state and any automatic intake receipt.",
    inputSchema: z.strictObject({ workspaceId: objectId, workItemId: objectId }),
    annotations: { readOnlyHint: true },
  }, async ({ workspaceId, workItemId }) => describe(await client.readWorkItemSnapshot(workspaceId, workItemId)));

  if (options.authToken) {
    const followupInput = z.strictObject({ threadId: objectId, expectedTurnId: objectId, expectedTurnRevision: objectId,
      message: z.string().min(1).max(16_384), idempotencyKey: requestKey });
    if (methods.has("thread/start")) server.registerTool("ling_thread_start", {
      description: "Create a Ling Thread in the connected workspace. Use the same request key when retrying.",
      inputSchema: z.strictObject({ title: z.string().min(1).max(200), idempotencyKey: requestKey }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async ({ title, idempotencyKey }) => describe(await client.startThread({
      title, threadId: `thread_mcp_${createHash("sha256").update(idempotencyKey).digest("hex")}`,
    })));
    if (methods.has("turn/start")) server.registerTool("ling_turn_start", {
      description: "Submit a Turn to Ling using a configured provider preset. Use the same key when retrying.",
      inputSchema: z.strictObject({
        threadId: objectId, message: z.string().min(1).max(16_384), providerPresetId: objectId, idempotencyKey: requestKey,
      }),
      annotations: { idempotentHint: true },
    }, async params => describe(await client.startTurn(params)));
    if (methods.has("workItem/create")) server.registerTool("ling_work_item_create", {
      description: "Submit a source occurrence to the Ling task inbox. Use a structured GitHub subject to join existing work.",
      inputSchema: z.strictObject({ sourceId: objectId, title: z.string().min(1).max(200), idempotencyKey: requestKey,
        gitHubSubject: z.strictObject({ repository: z.string().min(3).max(201), kind: z.enum(["issue", "pull_request"]), number: z.number().int().positive() }).optional(),
      }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.createWorkItem(params)));
    if (methods.has("workItem/accept")) server.registerTool("ling_work_item_accept", {
      description: "Accept a Work Item and give its primary execution to a Ling conversation. A retry uses the original dispatch.",
      inputSchema: z.strictObject({ workItemId: objectId, expectedWorkItemRevision: z.number().int().positive(), idempotencyKey: requestKey,
        dispatch: z.strictObject({ threadId: objectId, message: z.string().min(1).max(16_384), providerPresetId: objectId.optional() }).optional(),
      }),
      annotations: { idempotentHint: true },
    }, async params => describe(await client.acceptWorkItem(params)));
    if (methods.has("changes/capture")) server.registerTool("ling_changes_capture", {
      description: "Capture the current working-tree candidate and its coverage.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true },
    }, async () => describe(await client.captureChanges()));
    if (methods.has("changes/read")) server.registerTool("ling_changes_read", {
      description: "Read the bounded current candidate diff for a captured candidate digest.",
      inputSchema: z.strictObject({ candidateDigest: z.string().length(64), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(50).optional() }),
      annotations: { readOnlyHint: true },
    }, async params => describe(await client.readChanges(params)));
    if (methods.has("changes/apply/preview")) server.registerTool("ling_changes_preview_recovery", {
      description: "Preview undo or reapply for a completed Ling Turn before committing the workspace recovery.",
      inputSchema: z.strictObject({ threadId: objectId, turnId: objectId, action: z.enum(["undo", "reapply"]) }),
      annotations: { readOnlyHint: true },
    }, async params => describe(await client.previewChangeRecovery(params)));
    if (methods.has("changes/apply")) server.registerTool("ling_changes_apply_recovery", {
      description: "Apply a previously reviewed Turn recovery preview using its exact revision and idempotency key.",
      inputSchema: z.strictObject({ threadId: objectId, turnId: objectId, action: z.enum(["undo", "reapply"]), expectedRevision: z.string().length(64), idempotencyKey: requestKey, confirmed: z.literal(true) }),
      annotations: { idempotentHint: true, destructiveHint: true },
    }, async params => describe(await client.applyChanges(params)));
    if (methods.has("github/intake/poll")) server.registerTool("ling_github_intake_poll", {
      description: "Evaluate a registered GitHub intake page under its current manual, suggestion, or automatic admission policy.",
      inputSchema: z.strictObject({ repository: z.string().min(3).max(201), page: z.number().int().min(1).max(500).optional(),
        retryKey: z.string().max(160).optional() }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.pollGitHubIntake(params)));
    if (methods.has("github/intake/read")) server.registerTool("ling_github_intake_read", {
      description: "Read a durable GitHub intake evaluation receipt.",
      inputSchema: z.strictObject({ receiptId: objectId }),
      annotations: { readOnlyHint: true },
    }, async params => describe(await client.readGitHubIntake(params)));
    if (methods.has("github/intake/policy/list")) server.registerTool("ling_github_intake_policies", {
      description: "Read registered GitHub intake policies and provider availability.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true },
    }, async () => describe(await client.listGitHubIntakePolicies()));
    if (methods.has("turn/queue")) server.registerTool("ling_turn_queue", {
      description: "Queue a follow-up for the active Ling Turn from ling_thread_snapshot. Retry with the same request key.",
      inputSchema: followupInput,
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.queueTurn(params)));
    if (methods.has("turn/interrupt")) server.registerTool("ling_turn_interrupt", {
      description: "Request a stop for the current Run on a Ling Turn.",
      inputSchema: z.strictObject({ threadId: objectId, turnId: objectId, expectedTurnRevision: objectId.optional() }),
    }, async params => describe(await client.interruptTurn(params)));
    if (methods.has("turn/resume")) server.registerTool("ling_turn_resume", {
      description: "Recover a prepared or stopped Ling Turn using its observed revision. Reuse the recovery key when retrying.",
      inputSchema: z.strictObject({
        threadId: objectId, turnId: objectId, expectedTurnRevision: objectId, sourceRunId: objectId.optional(),
        idempotencyKey: requestKey, instruction: z.string().max(16_384).optional(),
      }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.resumeTurn(params)));
    if (methods.has("turn/interrupt")) server.registerTool("ling_turn_redirect", {
      description: "Stop the observed Ling Turn and submit a follow-up after its Run settles. Retry with the same request key.",
      inputSchema: followupInput,
      annotations: { idempotentHint: true, destructiveHint: true },
    }, async params => describe(await client.redirectTurn(params)));
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
