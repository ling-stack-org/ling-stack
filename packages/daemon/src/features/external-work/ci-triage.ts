import type { IncomingMessage, ServerResponse } from "node:http";
import {
  buildExternalWorkCiTriageView,
  parseExternalWorkflowMarkdown,
  triageGitHubExternalWorkCi,
  type ExternalWorkCiTriageDetailResponse,
  type ExternalWorkCiTriageListResponse,
  type ExternalWorkCiTriageResponse,
  type RunTool,
  type SecretResolver,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import {
  parseExternalGitHubCiTriageRequest,
  parseExternalWorkCiTriageRunRequest,
  readOptionalExternalWorkCiTriageStatusQuery,
} from "./schemas.js";
import {
  readExternalWorkflowFile,
  resolveExternalGitHubToken,
} from "./workflow.js";

export interface ExternalWorkCiTriageRunStartRequest {
  readonly workspaceCwd: string;
  readonly cwd: string;
  readonly providerPresetId: string;
  readonly teammateId?: string;
  readonly skipProviderPreflight: boolean;
  readonly idempotencyKey: string;
  readonly task: {
    readonly id: string;
    readonly title: string;
    readonly prompt: string;
    readonly channelId: string;
  };
  readonly tools?: readonly RunTool[];
  readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  readonly systemPrompt?: string;
  readonly appendSystemPrompt?: readonly string[];
  readonly agentDir?: string;
}

export interface ExternalWorkCiTriageRunHooks {
  readonly onRunReady: (runId: string) => void;
}

export type ExternalWorkCiTriageRunExecutor = (
  runRequest: ExternalWorkCiTriageRunStartRequest,
  response: ServerResponse,
  hooks: ExternalWorkCiTriageRunHooks,
) => Promise<void>;

export async function handleExternalGitHubCiTriage(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  externalWorkFetch?: typeof globalThis.fetch,
): Promise<void> {
  if (request.method === "GET") {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
    const cwd = url.searchParams.get("cwd");
    if (!cwd) {
      writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
      return;
    }

    try {
      const store = storeRegistry.getStore(cwd);
      const records = store.listExternalWorkCiTriage({
        externalWorkId: url.searchParams.get("externalWorkId") ?? undefined,
        channelId: url.searchParams.get("channelId") ?? undefined,
        status: readOptionalExternalWorkCiTriageStatusQuery(url),
        limit: readOptionalIntegerQuery(url, "limit", 1),
      });
      const responseBody: ExternalWorkCiTriageListResponse = {
        cwd,
        records: records.map((record) => buildExternalWorkCiTriageView(store, record)),
      };
      writeJson(response, 200, responseBody);
    } catch (error) {
      writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for GitHub CI triage` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseExternalGitHubCiTriageRequest(body);
    const externalWork = store.getExternalWorkRecord(input.externalWorkId);
    if (!externalWork) {
      writeJson(response, 404, { error: "external_work_not_found", message: `External work item not found: ${input.externalWorkId}` });
      return;
    }
    const channel = store.getChannel(externalWork.channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${externalWork.channelId}` });
      return;
    }
    const workflowFile = readExternalWorkflowFile(input, channel, cwd);
    const workflowDefinition = parseExternalWorkflowMarkdown(workflowFile.markdown);
    if (workflowDefinition.config.source.kind !== "github") {
      writeJson(response, 400, { error: "unsupported_source", message: `Unsupported external source kind: ${workflowDefinition.config.source.kind}` });
      return;
    }
    const githubToken = resolveExternalGitHubToken(workflowDefinition, secretResolver);
    const triageResponse: ExternalWorkCiTriageResponse = await triageGitHubExternalWorkCi({
      store,
      cwd,
      externalWorkId: input.externalWorkId,
      workflowDefinition,
      githubToken,
      fetch: externalWorkFetch,
      limit: input.limit,
      createTask: input.createTask,
      startRun: input.startRun,
    });
    writeJson(response, 200, triageResponse);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleExternalWorkCiTriageRun(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  triageId: string,
  executeRun: ExternalWorkCiTriageRunExecutor,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for CI triage run` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseExternalWorkCiTriageRunRequest(body);
    const store = storeRegistry.getStore(cwd);
    const triage = store.getExternalWorkCiTriage(triageId);
    if (!triage) {
      writeJson(response, 404, { error: "ci_triage_not_found", message: `External work CI triage record not found: ${triageId}` });
      return;
    }
    if (triage.status === "stale") {
      writeJson(response, 409, { error: "ci_triage_stale", message: `CI triage target is stale: ${triageId}` });
      return;
    }
    if (!triage.taskId) {
      writeJson(response, 409, { error: "ci_triage_task_missing", message: `CI triage record has no local fix task: ${triageId}` });
      return;
    }
    const task = store.getTask(triage.taskId);
    if (!task) {
      writeJson(response, 404, { error: "task_not_found", message: `Task not found: ${triage.taskId}` });
      return;
    }
    const channel = store.getChannel(task.channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${task.channelId}` });
      return;
    }

    await executeRun(
      {
        workspaceCwd: cwd,
        cwd: channel.boundPath ?? cwd,
        providerPresetId: input.providerPresetId,
        teammateId: task.assigneeTeammateId ?? channel.defaultTeammateId,
        skipProviderPreflight: input.skipProviderPreflight ?? false,
        idempotencyKey: input.idempotencyKey ?? `external_work_ci_triage_run:${triage.id}:${triage.taskId}:${triage.headSha}`,
        task: {
          id: task.id,
          title: task.title,
          prompt: task.prompt,
          channelId: task.channelId,
        },
        tools: input.tools ?? channel.allowedTools,
        thinkingLevel: input.thinkingLevel,
        systemPrompt: input.systemPrompt,
        appendSystemPrompt: input.appendSystemPrompt,
        agentDir: input.agentDir,
      },
      response,
      {
        onRunReady: (runId) => {
          store.updateExternalWorkCiTriage(triage.id, { status: "run_requested", runId }, new Date().toISOString());
        },
      },
    );
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleExternalWorkCiTriageItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  triageId: string,
): Promise<void> {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for CI triage detail` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const record = store.getExternalWorkCiTriage(triageId);
    if (!record) {
      writeJson(response, 404, { error: "ci_triage_not_found", message: `External work CI triage record not found: ${triageId}` });
      return;
    }
    const responseBody: ExternalWorkCiTriageDetailResponse = {
      cwd,
      record: buildExternalWorkCiTriageView(store, record),
    };
    writeJson(response, 200, responseBody);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}
