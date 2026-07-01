import type { IncomingMessage, ServerResponse } from "node:http";
import type { Channel, Task } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { getChannelPlanModeBlocker } from "../channels/plan-mode-guard.js";
import { validateChannelMessageReferences } from "../channels/protocol.js";
import { parseCreateTaskInput, parseTaskRunRequest, parseTaskUpdateInput, readOptionalTaskStatusQuery, type TaskRunRequest } from "./schemas.js";

export type StartTaskRun = (input: {
  readonly workspaceCwd: string;
  readonly task: Task;
  readonly channel: Channel;
  readonly runRequest: TaskRunRequest;
  readonly response: ServerResponse;
}) => Promise<void>;

export async function handleTasksCollection(
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
          assigneeTeammateId: url.searchParams.get("assigneeTeammateId") ?? undefined,
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
      const referenceError = validateChannelMessageReferences(store, input.channelId, input.attachmentIds ?? [], []);
      if (referenceError) {
        writeJson(response, referenceError.statusCode, { error: referenceError.code, message: referenceError.message });
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

export async function handleTaskItem(
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
      const nextChannelId = input.channelId ?? task.channelId;
      const referenceError = input.attachmentIds === undefined
        ? undefined
        : validateChannelMessageReferences(store, nextChannelId, input.attachmentIds, []);
      if (referenceError) {
        writeJson(response, referenceError.statusCode, { error: referenceError.code, message: referenceError.message });
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

export async function handleTaskRun(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  taskId: string,
  startTaskRun: StartTaskRun,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for task run` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const workspaceCwd = url.searchParams.get("cwd");
  if (!workspaceCwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const body = await readJsonBody(request, config.maxBodyBytes);
    const runRequest = parseTaskRunRequest(body);
    const store = storeRegistry.getStore(workspaceCwd);
    const task = store.getTask(taskId);
    if (!task) {
      writeJson(response, 404, { error: "task_not_found", message: `Task not found: ${taskId}` });
      return;
    }
    const channel = store.getChannel(task.channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${task.channelId}` });
      return;
    }
    const planModeBlocker = getChannelPlanModeBlocker(store, channel.id);
    if (planModeBlocker) {
      writeJson(response, 409, { error: "plan_mode_task_run_blocked", message: planModeBlocker });
      return;
    }
    await startTaskRun({ workspaceCwd, task, channel, runRequest, response });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
