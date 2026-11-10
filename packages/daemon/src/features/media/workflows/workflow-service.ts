import type {
  MediaWorkflowConnection,
  MediaWorkflowDefinition,
  MediaWorkflowInputField,
  MediaWorkflowOutputRule,
  MediaWorkflowVersion,
  RunStore,
  SecretResolver,
} from "@ling-stack/core";
import type { ExternalSecretStore } from "../../../context.js";
import { ComfyUiClient } from "./comfyui-client.js";
import { analyzeComfyWorkflowGraph, validateComfyWorkflowMappings } from "./comfyui-graph.js";
import { assertCurrentMediaWorkflowProtocol } from "./media-protocol-contract.js";
export { checkMediaWorkflowConnection } from "./workflow-connection-check.js";

export function publicMediaWorkflowConnection(
  connection: MediaWorkflowConnection,
  secretResolver: SecretResolver,
): MediaWorkflowConnection & { readonly secretConfigured: boolean } {
  const secretConfigured = connection.authMode === "none"
    ? true
    : Boolean(connection.secretRef && secretResolver.status(connection.secretRef, "workflow_api_key").configured);
  return { ...connection, secretConfigured };
}

export function mediaWorkflowDefinitionDetail(store: RunStore, definition: MediaWorkflowDefinition) {
  const versions = store.listMediaWorkflowVersions(definition.id);
  return {
    definition,
    currentVersion: definition.currentVersionId ? store.getMediaWorkflowVersion(definition.currentVersionId) : undefined,
    versions,
  };
}

export async function analyzeMediaWorkflowImport(input: {
  readonly store: RunStore;
  readonly connectionId: string;
  readonly graph: Record<string, unknown>;
  readonly secretResolver: SecretResolver;
  readonly now: string;
}) {
  const connection = requireConnection(input.store, input.connectionId);
  const inspection = await createClient(connection, input.secretResolver).inspect();
  return analyzeComfyWorkflowGraph(input.graph, inspection.objectInfo, input.now);
}

export async function importMediaWorkflow(input: {
  readonly store: RunStore;
  readonly connectionId: string;
  readonly workflowDefinitionId?: string;
  readonly name: string;
  readonly description?: string;
  readonly graph: Record<string, unknown>;
  readonly inputFields?: readonly MediaWorkflowInputField[];
  readonly outputRules?: readonly MediaWorkflowOutputRule[];
  readonly secretResolver: SecretResolver;
  readonly now: string;
}) {
  const connection = requireConnection(input.store, input.connectionId);
  const inspection = await createClient(connection, input.secretResolver).inspect();
  const analysis = analyzeComfyWorkflowGraph(input.graph, inspection.objectInfo, input.now);
  const inputFields = input.inputFields ?? analysis.inputFields;
  const outputRules = input.outputRules ?? analysis.outputRules;
  const mappingValidation = validateComfyWorkflowMappings(input.graph, inputFields, outputRules, input.now);
  const validation = {
    ok: analysis.validation.ok && mappingValidation.ok,
    errors: [...new Set([...analysis.validation.errors, ...mappingValidation.errors])],
    warnings: [...new Set([...analysis.validation.warnings, ...mappingValidation.warnings])],
    checkedAt: input.now,
  };
  const definition = input.workflowDefinitionId
    ? requireDefinition(input.store, input.workflowDefinitionId)
    : input.store.createMediaWorkflowDefinition({
        connectionId: connection.id,
        name: input.name,
        description: input.description,
        status: validation.ok ? "draft" : "blocked",
      }, input.now);
  if (definition.connectionId !== connection.id) {
    throw new Error("更新工作流时不能隐式切换连接。");
  }
  const version = input.store.createMediaWorkflowVersion({
    workflowDefinitionId: definition.id,
    sourceDigest: analysis.sourceDigest,
    graphSnapshot: input.graph,
    inputFields,
    outputRules,
    validation,
  }, input.now);
  const updated = input.store.updateMediaWorkflowDefinition(definition.id, {
    name: input.name,
    description: input.description,
    status: validation.ok ? "draft" : "blocked",
  }, input.now) ?? definition;
  return { definition: updated, version, analysis };
}

export function createMediaWorkflowTestJob(input: {
  readonly store: RunStore;
  readonly definition: MediaWorkflowDefinition;
  readonly version: MediaWorkflowVersion;
  readonly connection: MediaWorkflowConnection;
  readonly inputValues: Record<string, unknown>;
  readonly now: string;
}) {
  assertCurrentMediaWorkflowProtocol(input.connection);
  if (!input.version.validation.ok) {
    throw new Error("工作流结构检查未通过，不能试运行。");
  }
  const operation = input.version.outputRules.some((rule) => rule.artifactType === "video")
    ? "video_generate"
    : "image_generate";
  const promptField = input.version.inputFields.find((field) => field.semantic === "prompt");
  const prompt = promptField ? String(input.inputValues[promptField.id] ?? promptField.defaultValue ?? "") : "工作流试运行";
  return input.store.createMediaJob({
    workflowVersionId: input.version.id,
    operation,
    prompt,
    input: {
      workflowInputValues: input.inputValues,
      workflowTest: true,
    },
  }, input.now);
}

export function activateMediaWorkflow(input: {
  readonly store: RunStore;
  readonly definition: MediaWorkflowDefinition;
  readonly version: MediaWorkflowVersion;
  readonly now: string;
}): MediaWorkflowDefinition {
  if (!input.version.validation.ok) {
    throw new Error("工作流结构检查未通过，不能启用。");
  }
  if (!input.version.testMediaJobId) {
    throw new Error("请先完成一次真实试运行，再启用工作流。");
  }
  const testJob = input.store.getMediaJob(input.version.testMediaJobId);
  if (!testJob || testJob.status !== "succeeded") {
    throw new Error("工作流试运行尚未成功，不能启用。");
  }
  return input.store.updateMediaWorkflowDefinition(input.definition.id, {
    currentVersionId: input.version.id,
    status: "ready",
  }, input.now) ?? input.definition;
}

export function configureMediaWorkflowSecret(input: {
  readonly connection: MediaWorkflowConnection;
  readonly apiKey: string;
  readonly secretRef?: string;
  readonly secretStore: ExternalSecretStore;
}): string {
  const secretRef = input.secretRef ?? `keychain:ling.media-workflow.${input.connection.id}`;
  const status = input.secretStore.setSecret(secretRef, input.apiKey, "workflow_api_key");
  if (!status.configured) {
    throw new Error(status.message ?? "无法保存工作流连接密钥。");
  }
  return secretRef;
}

export function resolveMediaWorkflowSecret(connection: MediaWorkflowConnection, secretResolver: SecretResolver): string | undefined {
  if (connection.authMode === "none") return undefined;
  if (!connection.secretRef) throw new Error("工作流连接缺少 API Key。");
  const secret = secretResolver.resolve(connection.secretRef, "workflow_api_key");
  if (!secret.configured || !secret.value) throw new Error(secret.status?.message ?? "工作流连接 API Key 尚未配置。");
  return secret.value;
}

export function requireConnection(store: RunStore, id: string): MediaWorkflowConnection {
  const connection = store.getMediaWorkflowConnection(id);
  if (!connection) throw new Error(`媒体工作流连接不存在：${id}`);
  return connection;
}

export function requireDefinition(store: RunStore, id: string): MediaWorkflowDefinition {
  const definition = store.getMediaWorkflowDefinition(id);
  if (!definition) throw new Error(`媒体工作流不存在：${id}`);
  return definition;
}

export function requireVersion(store: RunStore, id: string): MediaWorkflowVersion {
  const version = store.getMediaWorkflowVersion(id);
  if (!version) throw new Error(`媒体工作流版本不存在：${id}`);
  return version;
}

function createClient(connection: MediaWorkflowConnection, secretResolver: SecretResolver): ComfyUiClient {
  return new ComfyUiClient({ connection, apiKey: resolveMediaWorkflowSecret(connection, secretResolver) });
}
