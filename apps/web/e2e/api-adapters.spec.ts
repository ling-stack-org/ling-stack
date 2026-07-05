import { expect, test } from "@playwright/test";
import { approvalPolicyFormToPayload } from "../src/api/approval-payloads.js";
import { channelFormToPayload, channelFormToUpdatePayload, taskEditFormToPayload } from "../src/api/channel-payloads.js";
import { mediaJobFormToPayload, parseMediaInput } from "../src/api/media-payloads.js";
import { mcpServerFormToPayload } from "../src/api/mcp-payloads.js";
import { providerFormToPayload } from "../src/api/provider-payloads.js";
import { buildRerunRequest, buildRunRequest, buildTaskRunRequest } from "../src/api/run-request-builders.js";
import type {
  Channel,
  ChannelFormState,
  McpServerFormState,
  ProviderFormState,
  RunFormState,
  RunSession,
  Task,
} from "../src/types.js";

const runtimePolicy = {
  maxConcurrentRuns: 2,
  executionMode: "parallel",
  writeLockScope: "workspace",
  allowReadOnlyParallel: true,
  queueOnConflict: false,
} as const;

test("run request builders preserve provider preset and legacy provider payloads", () => {
  const baseForm = {
    cwd: "/repo",
    providerPresetId: "provider_chat",
    taskId: "task_1",
    title: "Ship it",
    prompt: "Implement the split",
    provider: "openai",
    model: "gpt-5",
    baseUrl: "",
    apiKey: "",
    api: "openai-responses",
    tools: ["read", "grep", "write"],
    permissionPreset: "workspace_collaboration",
    permissionMode: "workspace_write",
  } satisfies RunFormState;

  const presetRequest = buildRunRequest(baseForm) as Record<string, unknown>;
  expect(presetRequest).toMatchObject({
    cwd: "/repo",
    providerPresetId: "provider_chat",
    permissionPreset: "workspace_collaboration",
    permissionMode: "workspace_write",
    thinkingLevel: "medium",
  });
  expect(presetRequest).not.toHaveProperty("provider");

  const legacyRequest = buildRunRequest({
    ...baseForm,
    providerPresetId: "",
    baseUrl: "https://example.test/v1",
    apiKey: "sk-test",
  }) as Record<string, unknown>;
  expect(legacyRequest).not.toHaveProperty("providerPresetId");
  expect(legacyRequest.provider).toMatchObject({
    provider: "openai",
    model: "gpt-5",
    baseUrl: "https://example.test/v1",
    apiKey: "sk-test",
    api: "openai-responses",
    authHeader: true,
    input: ["text"],
  });
});

test("task run requests preserve workspace cwd fallback and approval profile", () => {
  const task = {
    id: "task_2",
    workspaceId: "workspace",
    channelId: "channel_1",
    title: "Follow up",
    prompt: "Run the task",
    status: "todo",
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  } satisfies Task;
  const channel = {
    id: "channel_1",
    workspaceId: "workspace",
    name: "General",
    status: "active",
    allowedTools: [],
    runtimePolicy,
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  } satisfies Channel;

  const request = buildTaskRunRequest("/workspace", task, channel, "provider_chat", {
    approvalProfile: { mode: "standard", risk: "medium", requiredForTools: ["bash"] },
    permissionPreset: "read_only",
    permissionMode: "ask_everything",
  }) as Record<string, unknown>;

  expect(request).toMatchObject({
    workspaceCwd: "/workspace",
    cwd: "/workspace",
    providerPresetId: "provider_chat",
    tools: ["read", "grep", "find", "ls"],
    approvalProfile: { mode: "standard", risk: "medium", requiredForTools: ["bash"] },
    permissionPreset: "read_only",
    permissionMode: "ask_everything",
  });
});

test("rerun request reconstructs provider preset payload from run snapshots", () => {
  const run = {
    id: "run_1",
    status: "succeeded",
    cwd: "/repo",
    taskId: "task_3",
    channelId: "channel_2",
    providerName: "openai",
    providerModel: "gpt-5",
    taskSnapshot: {
      id: "task_3",
      title: "Original task",
      prompt: "Repeat this",
      channelId: "channel_2",
    },
    providerSnapshot: {},
    requestSnapshot: {
      workspaceCwd: "/workspace",
      providerPresetId: "provider_snapshot",
      tools: ["read", "invalid", "bash"],
      permissionPreset: "custom",
      permissionMode: "balanced",
      lingConversationTone: "friendly",
      appendSystemPrompt: ["one", "", "two"],
    },
    eventLogPath: "/tmp/run.log",
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  } satisfies RunSession;

  expect(buildRerunRequest(run)).toEqual({
    workspaceCwd: "/workspace",
    cwd: "/repo",
    task: {
      id: "task_3",
      title: "Original task",
      prompt: "Repeat this",
      channelId: "channel_2",
    },
    providerPresetId: "provider_snapshot",
    tools: ["read", "bash"],
    permissionPreset: "custom",
    permissionMode: "balanced",
    thinkingLevel: "medium",
    lingConversationTone: "friendly",
    appendSystemPrompt: ["one", "two"],
  });
});

test("form payload adapters preserve daemon request boundary semantics", () => {
  const providerForm = {
    kind: "seedream",
    displayName: "Seedream Live",
    providerId: "seedream",
    model: "seedream-v4",
    api: "media-job",
    providerTransport: "",
    baseUrl: "",
    apiKey: "  sk-live  ",
    apiKeyRef: "",
    clearApiKey: true,
    secretHeaderRefsText: "",
    capabilitiesText: "image_generate, image_edit",
    inputText: "image, text",
    enabled: true,
    authHeader: false,
    reasoning: false,
    thinkingModes: [],
    contextWindow: "128000",
    maxTokens: "4096",
  } satisfies ProviderFormState;
  expect(providerFormToPayload(providerForm)).toMatchObject({
    kind: "seedream",
    displayName: "Seedream Live",
    apiKey: "sk-live",
    clearApiKey: true,
    capabilities: ["image_generate", "image_edit"],
    input: ["image", "text"],
    contextWindow: 128000,
    maxTokens: 4096,
    compat: { mediaVendorTransport: { mode: "live" } },
  });

  const mcpForm = {
    displayName: "Local MCP",
    serverId: " local ",
    transportType: "stdio",
    command: " node ",
    argsText: "server.js --verbose",
    cwd: " /repo ",
    url: "",
    headerName: "",
    headerSecretRef: "",
    bearerTokenRef: "",
    envName: "API_KEY",
    envSecretRef: "keychain:mcp",
    startupTimeoutSec: "10",
    toolTimeoutSec: "30",
    enabled: true,
    required: false,
  } satisfies McpServerFormState;
  expect(mcpServerFormToPayload(mcpForm)).toMatchObject({
    id: "local",
    displayName: "Local MCP",
    transport: {
      type: "stdio",
      command: "node",
      args: ["server.js", "--verbose"],
      cwd: "/repo",
      secretEnvRefs: { API_KEY: "keychain:mcp" },
    },
    startupTimeoutSec: 10,
    toolTimeoutSec: 30,
  });

  const channelForm = {
    name: " General ",
    status: "active",
    boundPath: "",
    defaultProviderPresetId: "",
    defaultTeammateId: "",
    autoReplyMode: "mentions_only",
    allowedTools: ["read", "bash"],
    runtimePolicy,
  } satisfies ChannelFormState;
  expect(channelFormToPayload(channelForm)).toMatchObject({
    name: "General",
    boundPath: undefined,
    defaultProviderPresetId: undefined,
    defaultTeammateId: undefined,
    autoReplyMode: "mentions_only",
    allowedTools: ["read", "bash"],
  });
  expect(channelFormToUpdatePayload(channelForm)).toMatchObject({
    name: "General",
    boundPath: null,
    defaultProviderPresetId: null,
    defaultTeammateId: null,
    autoReplyMode: "mentions_only",
  });

  expect(taskEditFormToPayload({ title: "T", prompt: "P", status: "review" })).toEqual({
    title: "T",
    prompt: "P",
    status: "review",
  });

  expect(approvalPolicyFormToPayload({
    toolDecisions: { read: "allow", grep: "allow", find: "allow", ls: "allow", bash: "ask", edit: "ask", write: "deny" },
    allowedWritePathsText: "\napps/web/src\n\npackages/core/src\n",
  })).toMatchObject({
    allowedWritePaths: ["apps/web/src", "packages/core/src"],
  });
});

test("media payload adapter requires object JSON input", () => {
  expect(mediaJobFormToPayload({
    providerPresetId: "media_provider",
    operation: "image_generate",
    prompt: "A diagram",
    inputText: "{\"size\":\"1024x1024\"}",
  })).toEqual({
    providerPresetId: "media_provider",
    operation: "image_generate",
    prompt: "A diagram",
    input: { size: "1024x1024" },
  });

  expect(parseMediaInput("")).toBeUndefined();
  expect(() => parseMediaInput("[1,2,3]")).toThrow("Generation task input must be a JSON object.");
});
