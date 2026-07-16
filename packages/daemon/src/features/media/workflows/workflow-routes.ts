import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  MediaWorkflowAuthMode,
  MediaWorkflowNetworkPolicy,
  MediaWorkflowProtocolVariant,
  RunStore,
  SecretResolver,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../../config.js";
import type { ExternalSecretStore } from "../../../context.js";
import type { RunStoreRegistry } from "../../../runtime/store-registry.js";
import { readJsonBody } from "../../../shared/request.js";
import { writeJson } from "../../../shared/response.js";
import { isRecord, readOptionalObject, readOptionalString, readString } from "../../../shared/validation.js";
import {
  activateMediaWorkflow,
  analyzeMediaWorkflowImport,
  checkMediaWorkflowConnection,
  configureMediaWorkflowSecret,
  createMediaWorkflowTestJob,
  importMediaWorkflow,
  mediaWorkflowDefinitionDetail,
  publicMediaWorkflowConnection,
  requireConnection,
  requireDefinition,
  requireVersion,
} from "./workflow-service.js";
import {
  parseMediaWorkflowInputFields,
  parseMediaWorkflowOutputRules,
} from "./workflow-request-parsers.js";

export type MediaWorkflowRoute =
  | { readonly resource: "connection"; readonly id: string; readonly action?: "check" }
  | { readonly resource: "workflow"; readonly id: string; readonly action?: "test" | "activate" | "archive" };

export async function handleMediaWorkflowConnectionsCollection(input: RouteContext): Promise<void> {
  const { request, response, config, storeRegistry, secretResolver } = input;
  const context = resolveContext(input);
  if (!context) return;
  try {
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd: context.cwd,
        connections: context.store.listMediaWorkflowConnections().map((connection) => publicMediaWorkflowConnection(connection, secretResolver)),
      });
      return;
    }
    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const parsed = parseConnectionCreate(body);
      let connection = context.store.createMediaWorkflowConnection(parsed.connection, now());
      if (parsed.apiKey) {
        const secretRef = configureMediaWorkflowSecret({ connection, apiKey: parsed.apiKey, secretRef: parsed.connection.secretRef, secretStore: input.secretStore });
        connection = context.store.updateMediaWorkflowConnection(connection.id, { secretRef }, now()) ?? connection;
      }
      writeJson(response, 201, { connection: publicMediaWorkflowConnection(connection, secretResolver) });
      return;
    }
    methodNotAllowed(response, request.method, "/media-workflow-connections");
  } catch (error) {
    writeWorkflowError(response, error);
  }
}

export async function handleMediaWorkflowsCollection(input: RouteContext): Promise<void> {
  const context = resolveContext(input);
  if (!context) return;
  try {
    if (input.request.method !== "GET") {
      methodNotAllowed(input.response, input.request.method, "/media-workflows");
      return;
    }
    writeJson(input.response, 200, {
      cwd: context.cwd,
      workflows: context.store.listMediaWorkflowDefinitions().map((definition) => mediaWorkflowDefinitionDetail(context.store, definition)),
    });
  } catch (error) {
    writeWorkflowError(input.response, error);
  }
}

export async function handleMediaWorkflowAnalyze(input: RouteContext): Promise<void> {
  const context = resolveContext(input);
  if (!context) return;
  try {
    if (input.request.method !== "POST") {
      methodNotAllowed(input.response, input.request.method, "/media-workflows/analyze");
      return;
    }
    const body = await readJsonBody(input.request, input.config.maxBodyBytes);
    if (!isRecord(body)) throw new Error("工作流检查请求必须是 JSON 对象。");
    const graph = readRequiredObject(body, "graph");
    const analysis = await analyzeMediaWorkflowImport({
      store: context.store,
      connectionId: readString(body, "connectionId"),
      graph,
      secretResolver: input.secretResolver,
      now: now(),
    });
    writeJson(input.response, 200, analysis);
  } catch (error) {
    writeWorkflowError(input.response, error);
  }
}

export async function handleMediaWorkflowImport(input: RouteContext): Promise<void> {
  const context = resolveContext(input);
  if (!context) return;
  try {
    if (input.request.method !== "POST") {
      methodNotAllowed(input.response, input.request.method, "/media-workflows/import");
      return;
    }
    const body = await readJsonBody(input.request, input.config.maxBodyBytes);
    if (!isRecord(body)) throw new Error("工作流导入请求必须是 JSON 对象。");
    const result = await importMediaWorkflow({
      store: context.store,
      connectionId: readString(body, "connectionId"),
      workflowDefinitionId: readOptionalString(body, "workflowDefinitionId"),
      name: readString(body, "name"),
      description: readOptionalString(body, "description"),
      graph: readRequiredObject(body, "graph"),
      inputFields: parseMediaWorkflowInputFields(body.inputFields),
      outputRules: parseMediaWorkflowOutputRules(body.outputRules),
      secretResolver: input.secretResolver,
      now: now(),
    });
    writeJson(input.response, 201, {
      ...mediaWorkflowDefinitionDetail(context.store, result.definition),
      importedVersion: result.version,
      analysis: result.analysis,
    });
  } catch (error) {
    writeWorkflowError(input.response, error);
  }
}

export async function handleMediaWorkflowRoute(input: RouteContext & { readonly route: MediaWorkflowRoute }): Promise<void> {
  const context = resolveContext(input);
  if (!context) return;
  try {
    if (input.route.resource === "connection") {
      await handleConnectionItem(input, context.store);
    } else {
      await handleWorkflowItem(input, context.store, context.cwd);
    }
  } catch (error) {
    writeWorkflowError(input.response, error);
  }
}

export function parseMediaWorkflowRoute(pathname: string): MediaWorkflowRoute | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "media-workflow-connections") {
    return { resource: "connection", id: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "media-workflow-connections" && segments[2] === "check") {
    return { resource: "connection", id: segments[1], action: "check" };
  }
  if (segments.length === 2 && segments[0] === "media-workflows") {
    return { resource: "workflow", id: segments[1] };
  }
  if (
    segments.length === 3 && segments[0] === "media-workflows" &&
    (segments[2] === "test" || segments[2] === "activate" || segments[2] === "archive")
  ) {
    return { resource: "workflow", id: segments[1], action: segments[2] };
  }
  return undefined;
}

interface RouteContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly config: ResolvedDaemonConfig;
  readonly storeRegistry: RunStoreRegistry;
  readonly secretResolver: SecretResolver;
  readonly secretStore: ExternalSecretStore;
  readonly launchMediaJob: (cwd: string, mediaJobId: string) => void;
}

async function handleConnectionItem(input: RouteContext & { readonly route: MediaWorkflowRoute }, store: RunStore): Promise<void> {
  const connection = requireConnection(store, input.route.id);
  if (input.route.resource !== "connection") return;
  if (input.route.action === "check") {
    if (input.request.method !== "POST") return methodNotAllowed(input.response, input.request.method, "/media-workflow-connections/:id/check");
    const checked = await checkMediaWorkflowConnection({ store, connection, secretResolver: input.secretResolver, now: now() });
    writeJson(input.response, 200, { connection: publicMediaWorkflowConnection(checked, input.secretResolver) });
    return;
  }
  if (input.request.method === "GET") {
    writeJson(input.response, 200, { connection: publicMediaWorkflowConnection(connection, input.secretResolver) });
    return;
  }
  if (input.request.method === "PATCH") {
    const body = await readJsonBody(input.request, input.config.maxBodyBytes);
    const parsed = parseConnectionUpdate(body);
    let updated = store.updateMediaWorkflowConnection(connection.id, parsed.connection, now()) ?? connection;
    if (parsed.apiKey) {
      const secretRef = configureMediaWorkflowSecret({ connection: updated, apiKey: parsed.apiKey, secretRef: parsed.connection.secretRef ?? undefined, secretStore: input.secretStore });
      updated = store.updateMediaWorkflowConnection(updated.id, { secretRef, status: "unchecked", health: null }, now()) ?? updated;
    }
    writeJson(input.response, 200, { connection: publicMediaWorkflowConnection(updated, input.secretResolver) });
    return;
  }
  if (input.request.method === "DELETE") {
    if (connection.secretRef?.startsWith("keychain:")) input.secretStore.deleteSecret(connection.secretRef, "workflow_api_key");
    writeJson(input.response, 200, { deleted: store.deleteMediaWorkflowConnection(connection.id), connectionId: connection.id });
    return;
  }
  methodNotAllowed(input.response, input.request.method, "/media-workflow-connections/:id");
}

async function handleWorkflowItem(
  input: RouteContext & { readonly route: MediaWorkflowRoute },
  store: RunStore,
  cwd: string,
): Promise<void> {
  const definition = requireDefinition(store, input.route.id);
  if (input.route.resource !== "workflow") return;
  if (!input.route.action) {
    if (input.request.method === "GET") {
      writeJson(input.response, 200, mediaWorkflowDefinitionDetail(store, definition));
      return;
    }
    if (input.request.method === "DELETE") {
      writeJson(input.response, 200, { deleted: store.deleteMediaWorkflowDefinition(definition.id), workflowDefinitionId: definition.id });
      return;
    }
    methodNotAllowed(input.response, input.request.method, "/media-workflows/:id");
    return;
  }
  if (input.route.action === "archive") {
    if (input.request.method !== "POST") return methodNotAllowed(input.response, input.request.method, "/media-workflows/:id/archive");
    const archived = store.updateMediaWorkflowDefinition(definition.id, { status: "archived" }, now()) ?? definition;
    writeJson(input.response, 200, mediaWorkflowDefinitionDetail(store, archived));
    return;
  }
  const body = await readJsonBody(input.request, input.config.maxBodyBytes);
  if (!isRecord(body)) throw new Error("工作流操作请求必须是 JSON 对象。");
  const versionId = readOptionalString(body, "versionId") ?? definition.currentVersionId ?? store.listMediaWorkflowVersions(definition.id)[0]?.id;
  if (!versionId) throw new Error("工作流还没有可用版本。");
  const version = requireVersion(store, versionId);
  if (version.workflowDefinitionId !== definition.id) throw new Error("工作流版本不属于当前流程。");
  if (input.route.action === "test") {
    if (input.request.method !== "POST") return methodNotAllowed(input.response, input.request.method, "/media-workflows/:id/test");
    const job = createMediaWorkflowTestJob({
      store,
      definition,
      version,
      inputValues: readOptionalObject(body, "inputValues") ?? {},
      now: now(),
    });
    store.setMediaWorkflowVersionTestJob(version.id, job.id);
    writeJson(input.response, 202, {
      mediaJob: job,
      workflowDefinitionId: definition.id,
      workflowVersionId: version.id,
    });
    input.launchMediaJob(cwd, job.id);
    return;
  }
  if (input.route.action === "activate") {
    if (input.request.method !== "POST") return methodNotAllowed(input.response, input.request.method, "/media-workflows/:id/activate");
    const activated = activateMediaWorkflow({ store, definition, version: requireVersion(store, version.id), now: now() });
    writeJson(input.response, 200, mediaWorkflowDefinitionDetail(store, activated));
  }
}

function parseConnectionCreate(value: unknown) {
  if (!isRecord(value)) throw new Error("工作流连接请求必须是 JSON 对象。");
  return {
    apiKey: readOptionalString(value, "apiKey"),
    connection: {
      name: readString(value, "name"),
      adapterKind: "comfyui" as const,
      baseUrl: readString(value, "baseUrl"),
      authMode: readEnum(value.authMode, ["none", "bearer"] as const, "authMode"),
      secretRef: readOptionalString(value, "secretRef"),
      networkPolicy: readEnum(value.networkPolicy, ["public_only", "trusted_private_network"] as const, "networkPolicy"),
      protocolVariant: readOptionalEnum(value.protocolVariant, ["auto", "jobs_v1", "prompt_legacy"] as const, "protocolVariant"),
    },
  };
}

function parseConnectionUpdate(value: unknown) {
  if (!isRecord(value)) throw new Error("工作流连接更新必须是 JSON 对象。");
  return {
    apiKey: readOptionalString(value, "apiKey"),
    connection: {
      name: readOptionalString(value, "name"),
      baseUrl: readOptionalString(value, "baseUrl"),
      authMode: readOptionalEnum(value.authMode, ["none", "bearer"] as const, "authMode") as MediaWorkflowAuthMode | undefined,
      secretRef: value.secretRef === null ? null : readOptionalString(value, "secretRef"),
      networkPolicy: readOptionalEnum(value.networkPolicy, ["public_only", "trusted_private_network"] as const, "networkPolicy") as MediaWorkflowNetworkPolicy | undefined,
      protocolVariant: readOptionalEnum(value.protocolVariant, ["auto", "jobs_v1", "prompt_legacy"] as const, "protocolVariant") as MediaWorkflowProtocolVariant | undefined,
      status: "unchecked" as const,
      health: null,
    },
  };
}

function resolveContext(input: RouteContext): { readonly cwd: string; readonly store: RunStore } | undefined {
  const url = new URL(input.request.url ?? "/", `http://${input.config.host}:${input.config.port}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(input.response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return undefined;
  }
  return { cwd, store: input.storeRegistry.getStore(cwd) };
}

function readRequiredObject(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = readOptionalObject(record, key);
  if (!value) throw new Error(`${key} 必须是 JSON 对象。`);
  return value;
}

function readEnum<const T extends readonly string[]>(value: unknown, values: T, key: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new Error(`${key} 必须是：${values.join(" / ")}。`);
  return value;
}

function readOptionalEnum<const T extends readonly string[]>(value: unknown, values: T, key: string): T[number] | undefined {
  return value === undefined ? undefined : readEnum(value, values, key);
}

function methodNotAllowed(response: ServerResponse, method: string | undefined, path: string): void {
  writeJson(response, 405, { error: "method_not_allowed", message: `${method ?? "UNKNOWN"} is not supported for ${path}` });
}

function writeWorkflowError(response: ServerResponse, error: unknown): void {
  writeJson(response, 400, { error: "media_workflow_error", message: error instanceof Error ? error.message : String(error) });
}

function now(): string {
  return new Date().toISOString();
}
