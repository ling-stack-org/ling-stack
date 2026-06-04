import type { IncomingMessage, ServerResponse } from "node:http";
import {
  buildExternalWorkActionView,
  cancelExternalWorkAction,
  parseExternalWorkflowMarkdown,
  proposeExternalWorkAction,
  type ExternalWorkActionExecutionResult,
  type ExternalWorkActionMutationResponse,
  type ExternalWorkActionDetailResponse,
  type ExternalWorkActionListResponse,
  type RunArtifact,
  type RunStore,
  type SecretResolver,
  type WorkUnit,
  type WorkUnitAttempt,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalIntegerQuery, readOptionalJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import {
  parseExternalWorkActionExecuteRequest,
  readExternalWorkActionCancelRequest,
  readExternalWorkActionProposeRequest,
  readOptionalExternalWorkActionKindQuery,
  readOptionalExternalWorkActionStatusQuery,
} from "./schemas.js";
import {
  readExternalWorkflowFile,
  resolveExternalGitHubToken,
} from "./workflow.js";

export interface ExternalWorkActionRuntimeStartRequest {
  readonly store: RunStore;
  readonly kind: "external_work_action";
  readonly ownerType: "external_work_action";
  readonly ownerId: string;
  readonly channelId: string;
  readonly linkedExternalWorkId: string;
  readonly idempotencyKey: string;
  readonly request: {
    readonly actionId: string;
    readonly externalWorkId: string;
    readonly sourceKind: string;
    readonly actionKind: string;
  };
}

export interface ExternalWorkActionRuntimeHandle {
  readonly workUnit: WorkUnit;
  readonly attempt: WorkUnitAttempt;
}

export interface ExternalWorkActionRuntimeTerminalTransitionRequest {
  readonly store: RunStore;
  readonly workUnitId: string;
  readonly attemptId: string;
  readonly event: "runner_succeeded" | "runner_failed";
  readonly attemptStatus: "succeeded" | "failed";
  readonly runtimeEventType: "work_unit_succeeded" | "work_unit_failed";
  readonly actor: "runner";
  readonly now: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface ExternalWorkActionArtifactRuntimeEventRequest {
  readonly store: RunStore;
  readonly workUnitId: string;
  readonly attemptId: string;
  readonly artifact: Pick<RunArtifact, "id" | "title" | "path">;
  readonly now: string;
}

export interface ExternalWorkActionExecuteRequest {
  readonly store: RunStore;
  readonly actionId: string;
  readonly githubToken?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface ExternalWorkActionExecuteHooks {
  readonly startRuntimeWorkUnit: (input: ExternalWorkActionRuntimeStartRequest) => ExternalWorkActionRuntimeHandle;
  readonly appendArtifactRuntimeEvent: (input: ExternalWorkActionArtifactRuntimeEventRequest) => void;
  readonly transitionRuntimeWorkUnitTerminal: (input: ExternalWorkActionRuntimeTerminalTransitionRequest) => void;
  readonly executeExternalWorkAction: (input: ExternalWorkActionExecuteRequest) => Promise<ExternalWorkActionExecutionResult>;
}

export async function handleExternalWorkActionPropose(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work action propose` });
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
    const result = proposeExternalWorkAction({
      store: storeRegistry.getStore(cwd),
      request: readExternalWorkActionProposeRequest(body),
      now: new Date().toISOString(),
    });
    const responseBody: ExternalWorkActionMutationResponse = {
      cwd,
      action: result.action,
      ...(result.approval ? { approval: result.approval } : {}),
      artifacts: result.artifacts,
      duplicate: result.duplicate,
    };
    writeJson(response, 200, responseBody);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleExternalWorkActionsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work actions list` });
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
    const actions = store.listExternalWorkActions({
      externalWorkId: url.searchParams.get("externalWorkId") ?? undefined,
      channelId: url.searchParams.get("channelId") ?? undefined,
      status: readOptionalExternalWorkActionStatusQuery(url),
      actionKind: readOptionalExternalWorkActionKindQuery(url),
      limit: readOptionalIntegerQuery(url, "limit", 1),
    });
    const responseBody: ExternalWorkActionListResponse = {
      cwd,
      actions: actions.map((action) => buildExternalWorkActionView(store, action)),
    };
    writeJson(response, 200, responseBody);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleExternalWorkActionCancel(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  actionId: string,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work action cancel` });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  const store = storeRegistry.getStore(cwd);
  try {
    const body = await readOptionalJsonBody(request, config.maxBodyBytes);
    const result = cancelExternalWorkAction({
      store,
      actionId,
      request: readExternalWorkActionCancelRequest(body),
      now: new Date().toISOString(),
    });
    const responseBody: ExternalWorkActionMutationResponse = {
      cwd,
      action: result.action,
      ...(result.approval ? { approval: result.approval } : {}),
      artifacts: result.artifacts,
    };
    writeJson(response, 200, responseBody);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleExternalWorkActionExecute(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  externalWorkFetch: typeof globalThis.fetch | undefined,
  actionId: string,
  hooks: ExternalWorkActionExecuteHooks,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  const store = storeRegistry.getStore(cwd);
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work action execute` });
    return;
  }

  let supervised: ExternalWorkActionRuntimeHandle | undefined;
  try {
    const body = await readOptionalJsonBody(request, config.maxBodyBytes);
    const input = parseExternalWorkActionExecuteRequest(body);
    const action = store.getExternalWorkAction(actionId);
    if (!action) {
      writeJson(response, 404, { error: "external_work_action_not_found", message: `External work action not found: ${actionId}` });
      return;
    }
    const channel = store.getChannel(action.channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${action.channelId}` });
      return;
    }
    const workflowFile = readExternalWorkflowFile(input, channel, cwd);
    const workflowDefinition = parseExternalWorkflowMarkdown(workflowFile.markdown);
    if (workflowDefinition.config.source.kind !== "github") {
      writeJson(response, 400, { error: "unsupported_source", message: `Unsupported external source kind: ${workflowDefinition.config.source.kind}` });
      return;
    }
    if (workflowDefinition.config.source.repository && workflowDefinition.config.source.repository !== action.target.repository) {
      writeJson(response, 400, { error: "repository_mismatch", message: `WORKFLOW.md source.repository does not match action target: ${workflowDefinition.config.source.repository} !== ${action.target.repository}` });
      return;
    }

    supervised = hooks.startRuntimeWorkUnit({
      store,
      kind: "external_work_action",
      ownerType: "external_work_action",
      ownerId: action.id,
      channelId: action.channelId,
      linkedExternalWorkId: action.externalWorkId,
      idempotencyKey: `external_work_action:${action.id}:${action.executionAttemptCount}`,
      request: {
        actionId: action.id,
        externalWorkId: action.externalWorkId,
        sourceKind: action.sourceKind,
        actionKind: action.actionKind,
      },
    });
    const githubToken = resolveExternalGitHubToken(workflowDefinition, secretResolver);
    const result = await hooks.executeExternalWorkAction({
      store,
      actionId,
      githubToken,
      fetch: externalWorkFetch,
    });
    for (const artifact of result.artifacts) {
      hooks.appendArtifactRuntimeEvent({
        store,
        workUnitId: supervised.workUnit.id,
        attemptId: supervised.attempt.id,
        artifact,
        now: new Date().toISOString(),
      });
    }
    hooks.transitionRuntimeWorkUnitTerminal({
      store,
      workUnitId: supervised.workUnit.id,
      attemptId: supervised.attempt.id,
      event: result.action.status === "succeeded" ? "runner_succeeded" : "runner_failed",
      attemptStatus: result.action.status === "succeeded" ? "succeeded" : "failed",
      runtimeEventType: result.action.status === "succeeded" ? "work_unit_succeeded" : "work_unit_failed",
      actor: "runner",
      now: new Date().toISOString(),
      errorCode: result.action.status === "succeeded" ? undefined : result.action.status,
      errorMessage: result.action.lastErrorMessage,
    });
    const responseBody: ExternalWorkActionMutationResponse = {
      cwd,
      action: result.action,
      ...(result.approval ? { approval: result.approval } : {}),
      artifacts: result.artifacts,
    };
    writeJson(response, 200, responseBody);
  } catch (error) {
    if (supervised) {
      hooks.transitionRuntimeWorkUnitTerminal({
        store,
        workUnitId: supervised.workUnit.id,
        attemptId: supervised.attempt.id,
        event: "runner_failed",
        attemptStatus: "failed",
        runtimeEventType: "work_unit_failed",
        actor: "runner",
        now: new Date().toISOString(),
        errorCode: error instanceof HttpError ? error.code : "external_work_action_failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleExternalWorkActionDetail(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  actionId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  const store = storeRegistry.getStore(cwd);
  if (request.method === "GET") {
    const action = store.getExternalWorkAction(actionId);
    if (!action) {
      writeJson(response, 404, { error: "external_work_action_not_found", message: `External work action not found: ${actionId}` });
      return;
    }
    const responseBody: ExternalWorkActionDetailResponse = {
      cwd,
      action: buildExternalWorkActionView(store, action),
    };
    writeJson(response, 200, responseBody);
    return;
  }
  writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work action detail` });
}
