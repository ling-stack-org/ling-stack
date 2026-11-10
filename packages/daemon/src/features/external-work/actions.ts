import type { IncomingMessage, ServerResponse } from "node:http";
import {
  buildExternalWorkActionView,
  cancelExternalWorkAction,
  ExternalWorkActionExecutionError,
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
  readonly transitionRuntimeWorkUnitCancelled: (input: {
    readonly store: RunStore;
    readonly workUnitId: string;
    readonly attemptId: string;
    readonly reason: string;
  }) => void;
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
  let executionResult: ExternalWorkActionExecutionResult | undefined;
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
    executionResult = result;
    // A rejected execution may observe another invocation's current action.
    // Its artifacts and terminal status do not belong to this Runtime attempt.
    for (const artifact of result.executionSettled ? result.artifacts : []) {
      hooks.appendArtifactRuntimeEvent({
        store,
        workUnitId: supervised.workUnit.id,
        attemptId: supervised.attempt.id,
        artifact,
        now: new Date().toISOString(),
      });
    }
    const effectUnconfirmed = result.dispatchState === "effect_unconfirmed";
    const cancelled = result.executionSettled && result.action.status === "cancelled" && result.dispatchState === "not_sent";
    const succeeded = result.executionSettled && result.action.status === "succeeded" && !effectUnconfirmed;
    const errorCode = effectUnconfirmed
      ? "external_action_effect_unconfirmed"
      : !result.executionSettled
        ? "external_action_authority_lost"
        : result.action.lastErrorCode ?? result.action.status;
    const errorMessage = !result.executionSettled
      ? effectUnconfirmed
        ? "This execution lost its authority after dispatch; external effects remain unconfirmed. Verify the remote subject before any further action."
        : "This execution lost its authority before dispatch and did not send a mutation. The returned action is the current persisted snapshot, not this execution's result."
      : result.action.lastErrorMessage;
    if (cancelled) {
      hooks.transitionRuntimeWorkUnitCancelled({
        store, workUnitId: supervised.workUnit.id, attemptId: supervised.attempt.id,
        reason: "External work action was cancelled before dispatch.",
      });
    } else {
      hooks.transitionRuntimeWorkUnitTerminal({
        store,
        workUnitId: supervised.workUnit.id,
        attemptId: supervised.attempt.id,
        event: succeeded ? "runner_succeeded" : "runner_failed",
        attemptStatus: succeeded ? "succeeded" : "failed",
        runtimeEventType: succeeded ? "work_unit_succeeded" : "work_unit_failed",
        actor: "runner",
        now: new Date().toISOString(),
        errorCode: succeeded ? undefined : errorCode,
        errorMessage,
      });
    }
    if (!result.executionSettled) {
      writeJson(response, 409, {
        error: errorCode, message: errorMessage, cwd,
        action: result.action, dispatchState: result.dispatchState,
      });
      return;
    }
    const responseBody: ExternalWorkActionMutationResponse = {
      cwd,
      action: result.action,
      ...(result.approval ? { approval: result.approval } : {}),
      artifacts: result.artifacts,
    };
    writeJson(response, 200, responseBody);
  } catch (error) {
    if (executionResult) {
      // Core has already decided this invocation's outcome. A failed Runtime
      // projection must not replace that fact with runner_failed or authorize
      // another dispatch, including cancelled and unconfirmed outcomes.
      writeJson(response, 503, {
        error: executionResult.dispatchState === "effect_unconfirmed"
          ? "external_action_effect_unconfirmed"
          : "external_action_runtime_projection_failed",
        message: "Runtime projection could not be persisted. The current action snapshot and this invocation's dispatch state are preserved; projection failure does not grant permission to replay the action.",
        cwd,
        action: executionResult.action,
        dispatchState: executionResult.dispatchState,
        executionSettled: executionResult.executionSettled,
        runtimeProjectionUnavailable: true,
      });
      return;
    }
    const executionError = error instanceof ExternalWorkActionExecutionError ? error : undefined;
    let runtimeProjectionUnavailable = false;
    if (supervised) {
      try {
        hooks.transitionRuntimeWorkUnitTerminal({
          store,
          workUnitId: supervised.workUnit.id,
          attemptId: supervised.attempt.id,
          event: "runner_failed",
          attemptStatus: "failed",
          runtimeEventType: "work_unit_failed",
          actor: "runner",
          now: new Date().toISOString(),
          errorCode: executionError?.code ?? (error instanceof HttpError ? error.code : "external_work_action_failed"),
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // Storage may be unavailable twice. Keep the known send boundary in
        // the response instead of replacing it with a generic projection error.
        runtimeProjectionUnavailable = true;
      }
    }
    if (executionError) {
      writeJson(response, 503, {
        error: executionError.code, message: executionError.message,
        dispatchState: executionError.dispatchState,
        ...(runtimeProjectionUnavailable ? { runtimeProjectionUnavailable: true } : {}),
      });
      return;
    }
    writeJson(response, 400, {
      error: "bad_request", message: error instanceof Error ? error.message : String(error),
      ...(runtimeProjectionUnavailable ? { runtimeProjectionUnavailable: true } : {}),
    });
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
