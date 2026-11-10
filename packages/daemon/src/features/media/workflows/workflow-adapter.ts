import { readFile } from "node:fs/promises";
import { basename, resolve as resolvePath, sep } from "node:path";
import type {
  MediaWorkflowConnection,
  MediaWorkflowVersion,
  RunArtifact,
  RunStore,
} from "@ling-stack/core";
import type {
  MediaExecutionArtifact,
  MediaExecutionHandle,
  MediaExecutionPollResult,
  MediaExecutionResult,
  MediaExecutionSubmission,
} from "@ling-stack/providers";
import { ComfyUiClient } from "./comfyui-client.js";
import type { ComfyUiTerminalObservation } from "./comfyui-terminal-observation.js";
import { materializeComfyWorkflowGraph } from "./comfyui-graph.js";
import { assertCurrentMediaWorkflowProtocol } from "./media-protocol-contract.js";

export interface MediaWorkflowExecutionRequest {
  readonly jobId: string;
  readonly prompt: string;
  readonly inputValues: Record<string, unknown>;
  readonly requestedAt: string;
}

export interface MediaWorkflowAdapter {
  readonly id: string;
  submit(request: MediaWorkflowExecutionRequest): Promise<MediaExecutionSubmission>;
  poll(handle: MediaExecutionHandle): Promise<MediaExecutionPollResult>;
  collectArtifacts(handle: MediaExecutionHandle): Promise<MediaExecutionResult>;
  cancel(handle: MediaExecutionHandle): Promise<void>;
}

export function createComfyUiWorkflowAdapter(input: {
  readonly store: RunStore;
  readonly connection: MediaWorkflowConnection;
  readonly version: MediaWorkflowVersion;
  readonly apiKey?: string;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly resolveHostAddresses?: (hostname: string) => Promise<readonly string[]>;
}): MediaWorkflowAdapter {
  const client = new ComfyUiClient({
    connection: input.connection,
    apiKey: input.apiKey,
    fetchImpl: input.fetchImpl,
    resolveHostAddresses: input.resolveHostAddresses,
  });
  // Same-instance business projection, not a restored handle's authority.
  // The Host retains independently captured transport/terminal lineage.
  const observedRecoveries = new WeakMap<Record<string, unknown>, {
    readonly payload: Record<string, unknown>;
    readonly terminalObservation: ComfyUiTerminalObservation;
  }>();
  return {
    id: "comfyui",
    async submit(request) {
      try {
        // The adapter is a new-task boundary. Historical Prompt/History
        // handles are still accepted by poll/cancel/collection below, but a
        // fresh submission must never select that protocol.
        assertCurrentMediaWorkflowProtocol(input.connection);
        const protocolVariant = input.connection.health?.protocolVariant ??
          (input.connection.protocolVariant === "auto" ? (await client.inspect()).protocolVariant : input.connection.protocolVariant);
        const values = await materializeWorkflowArtifactInputs({
          store: input.store,
          client,
          version: input.version,
          values: materializePromptInputs(input.version, request.inputValues, request.prompt),
        });
        const graph = materializeComfyWorkflowGraph(input.version.graphSnapshot, input.version.inputFields, values);
        const submission = await client.submit(graph, protocolVariant);
        return {
          status: "submitted",
          handle: {
            adapterKind: "comfyui",
            externalOperationId: submission.operationId,
            recovery: {
              protocolVariant: submission.protocolVariant,
              workflowVersionId: input.version.id,
            },
          },
        };
      } catch (error) {
        return {
          status: "failed",
          errorCode: "provider_internal_error",
          errorMessage: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async poll(handle) {
      const protocolVariant = readProtocolVariant(handle.recovery.protocolVariant);
      const result = await client.poll(handle.externalOperationId, protocolVariant);
      if (result.status === "pending") {
        return { status: "pending" };
      }
      if (result.status === "failed") {
        return { status: "failed", errorCode: "provider_internal_error", errorMessage: result.message,
          ...(result.terminalObservation ? { terminalObservation: result.terminalObservation } : {}) };
      }
      const recovery = { ...handle.recovery, protocolVariant, resultPayload: result.payload };
      observedRecoveries.set(recovery, { payload: result.payload, terminalObservation: result.terminalObservation });
      return {
        status: "succeeded",
        terminalObservation: result.terminalObservation,
        recovery,
      };
    },
    async collectArtifacts(handle) {
      const payload = handle.recovery.resultPayload;
      const observed = observedRecoveries.get(handle.recovery);
      const terminalObservation = observed && observed.payload === payload &&
        observed.terminalObservation.externalOperationId === handle.externalOperationId
        ? observed.terminalObservation : undefined;
      const terminal = terminalObservation ? { terminalObservation } : {};
      if (!isRecord(payload)) {
        return { status: "failed", artifacts: [], errorCode: "invalid_request", errorMessage: "ComfyUI 任务缺少结果快照。" };
      }
      const files = client.collectOutputFiles(payload, input.version.outputRules).slice(0, 8);
      if (files.length === 0) {
        return { status: "failed", artifacts: [], ...terminal, errorCode: "invalid_request", errorMessage: "ComfyUI 没有返回映射的图片或视频结果。" };
      }
      const artifacts: MediaExecutionArtifact[] = [];
      try {
        for (const file of files) {
          const downloaded = await client.downloadOutput(file);
          artifacts.push({
            type: file.artifactType,
            title: basename(file.filename),
            contentBytes: downloaded.bytes,
            contentType: downloaded.contentType,
            pathHint: file.filename,
          });
        }
        return { status: "succeeded", artifacts, ...terminal };
      } catch (error) {
        return { status: "failed", artifacts, ...terminal, errorCode: "provider_internal_error",
          errorMessage: error instanceof Error ? error.message : String(error) };
      }
    },
    async cancel(handle) {
      const protocolVariant = readProtocolVariant(handle.recovery.protocolVariant);
      const cancelled = await client.cancel(handle.externalOperationId, protocolVariant);
      if (!cancelled && protocolVariant === "prompt_legacy") {
        throw new Error("当前 ComfyUI 版本不支持精确取消运行中的任务，已停止 Ling 后续轮询。");
      }
    },
  };
}

function materializePromptInputs(
  version: MediaWorkflowVersion,
  inputValues: Record<string, unknown>,
  prompt: string,
): Record<string, unknown> {
  const values = { ...inputValues };
  for (const field of version.inputFields) {
    if (field.semantic === "prompt") values[field.id] = prompt;
  }
  return values;
}

async function materializeWorkflowArtifactInputs(input: {
  readonly store: RunStore;
  readonly client: ComfyUiClient;
  readonly version: MediaWorkflowVersion;
  readonly values: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const values = { ...input.values };
  for (const field of input.version.inputFields) {
    if (field.kind !== "image_artifact") continue;
    const value = values[field.id] ?? field.defaultValue;
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") throw new Error(`工作流输入“${field.label}”必须引用一个图片产物。`);
    const artifact = input.store.getArtifact(value);
    assertImageArtifact(artifact, value);
    const absolutePath = resolveArtifactPath(input.store.paths.artifactsDir, artifact.path);
    const bytes = new Uint8Array(await readFile(absolutePath));
    if (bytes.byteLength > 25 * 1024 * 1024) throw new Error(`参考图片“${artifact.title ?? artifact.id}”超过 25 MB。`);
    values[field.id] = await input.client.uploadImage({
      bytes,
      fileName: basename(artifact.path),
      contentType: artifact.contentType || "image/png",
    });
  }
  return values;
}

function assertImageArtifact(artifact: RunArtifact | undefined, artifactId: string): asserts artifact is RunArtifact {
  if (!artifact || artifact.type !== "image") {
    throw new Error(`参考素材必须是当前工作区已有的图片产物：${artifactId}。`);
  }
}

function resolveArtifactPath(root: string, relativePath: string): string {
  const normalizedRoot = resolvePath(root);
  const absolutePath = resolvePath(normalizedRoot, relativePath);
  if (absolutePath !== normalizedRoot && !absolutePath.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error("参考素材路径超出当前工作区产物目录。");
  }
  return absolutePath;
}

function readProtocolVariant(value: unknown): "jobs_v1" | "prompt_legacy" {
  return value === "jobs_v1" ? "jobs_v1" : "prompt_legacy";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
