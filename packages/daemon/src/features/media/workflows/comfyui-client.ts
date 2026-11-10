import type {
  MediaWorkflowConnection,
  MediaWorkflowOutputRule,
  MediaWorkflowProtocolVariant,
} from "@ling-stack/core";
import { isRecord } from "../../../shared/validation.js";
import { preparePinnedPublicHttpRequest, PublicHttpError } from "../../../shared/public-http-transport.js";
import {
  decodeComfyUiJobObservation,
  decodeComfyUiLegacyObservation,
  type ComfyUiStatusObservation,
  type ComfyUiTerminalObservation,
} from "./comfyui-terminal-observation.js";

export interface ComfyUiClientOptions {
  readonly connection: MediaWorkflowConnection;
  readonly apiKey?: string;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly resolveHostAddresses?: (hostname: string) => Promise<readonly string[]>;
}

export interface ComfyUiConnectionInspection {
  readonly protocolVariant: Exclude<MediaWorkflowProtocolVariant, "auto">;
  readonly objectInfo: Record<string, unknown>;
}

export interface ComfyUiSubmission {
  readonly operationId: string;
  readonly protocolVariant: Exclude<MediaWorkflowProtocolVariant, "auto">;
}

export type ComfyUiPollResult =
  | { readonly status: "pending"; readonly recovery?: Record<string, unknown> }
  | { readonly status: "succeeded"; readonly payload: Record<string, unknown>;
      readonly terminalObservation: ComfyUiTerminalObservation }
  | { readonly status: "failed"; readonly message: string;
      readonly terminalObservation?: ComfyUiTerminalObservation };

export interface ComfyUiOutputFile {
  readonly filename: string;
  readonly subfolder?: string;
  readonly type?: string;
  readonly artifactType: "image" | "video";
}

export class ComfyUiClient {
  private readonly connection: MediaWorkflowConnection;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly resolveHostAddresses?: (hostname: string) => Promise<readonly string[]>;
  private readonly baseUrl: URL;

  constructor(options: ComfyUiClientOptions) {
    this.connection = options.connection;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.resolveHostAddresses = options.resolveHostAddresses;
    this.baseUrl = normalizeBaseUrl(options.connection.baseUrl);
  }

  async inspect(): Promise<ComfyUiConnectionInspection> {
    const objectInfo = await this.requestJson("/api/object_info", { method: "GET" });
    if (!isRecord(objectInfo)) {
      throw new Error("ComfyUI 节点信息返回格式无效。");
    }
    const configured = this.connection.protocolVariant;
    if (configured !== "auto") {
      return { protocolVariant: configured, objectInfo };
    }
    const jobs = await this.tryRequestJson("/api/jobs?limit=1", { method: "GET" });
    return {
      protocolVariant: jobs.ok ? "jobs_v1" : "prompt_legacy",
      objectInfo,
    };
  }

  async submit(
    graph: Record<string, unknown>,
    protocolVariant: Exclude<MediaWorkflowProtocolVariant, "auto">,
  ): Promise<ComfyUiSubmission> {
    const response = await this.requestJson("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ prompt: graph }),
      headers: { "content-type": "application/json" },
    });
    if (!isRecord(response) || typeof response.prompt_id !== "string" || !response.prompt_id.trim()) {
      const detail = isRecord(response) && isRecord(response.node_errors)
        ? ` ${JSON.stringify(response.node_errors)}`
        : "";
      throw new Error(`ComfyUI 没有返回任务 ID。${detail}`.trim());
    }
    return { operationId: response.prompt_id, protocolVariant };
  }

  async poll(
    operationId: string,
    protocolVariant: Exclude<MediaWorkflowProtocolVariant, "auto">,
  ): Promise<ComfyUiPollResult> {
    return protocolVariant === "jobs_v1"
      ? await this.pollJob(operationId)
      : await this.pollLegacyHistory(operationId);
  }

  async cancel(operationId: string, protocolVariant: Exclude<MediaWorkflowProtocolVariant, "auto">): Promise<boolean> {
    if (protocolVariant !== "jobs_v1") {
      return false;
    }
    const response = await this.tryRequestJson(`/api/jobs/${encodeURIComponent(operationId)}/cancel`, { method: "POST" });
    if (!response.ok && response.status !== 404) {
      throw new Error(`ComfyUI 取消任务失败：HTTP ${response.status}。`);
    }
    return response.ok;
  }

  async uploadImage(input: {
    readonly bytes: Uint8Array;
    readonly fileName: string;
    readonly contentType: string;
  }): Promise<string> {
    const form = new FormData();
    const blobBytes = input.bytes.buffer.slice(input.bytes.byteOffset, input.bytes.byteOffset + input.bytes.byteLength) as ArrayBuffer;
    form.append("image", new Blob([blobBytes], { type: input.contentType }), input.fileName);
    form.append("type", "input");
    form.append("overwrite", "false");
    const response = await this.requestJson("/api/upload/image", { method: "POST", body: form });
    if (!isRecord(response) || typeof response.name !== "string") {
      throw new Error("ComfyUI 上传参考图后没有返回文件名。");
    }
    const subfolder = typeof response.subfolder === "string" && response.subfolder ? `${response.subfolder}/` : "";
    return `${subfolder}${response.name}`;
  }

  async downloadOutput(file: ComfyUiOutputFile): Promise<{ readonly bytes: Uint8Array; readonly contentType: string }> {
    const query = new URLSearchParams({ filename: file.filename });
    if (file.subfolder) query.set("subfolder", file.subfolder);
    if (file.type) query.set("type", file.type);
    const response = await this.request(`/api/view?${query.toString()}`, { method: "GET" });
    const declaredLength = Number(response.headers.get("content-length"));
    const limit = file.artifactType === "video" ? 512 * 1024 * 1024 : 25 * 1024 * 1024;
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
      await cancelResponseBody(response);
      throw new Error(`ComfyUI ${file.artifactType === "video" ? "视频" : "图片"}超过允许大小。`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) {
      throw new Error(`ComfyUI ${file.artifactType === "video" ? "视频" : "图片"}超过允许大小。`);
    }
    return { bytes, contentType: response.headers.get("content-type") || inferContentType(file.filename, file.artifactType) };
  }

  collectOutputFiles(payload: Record<string, unknown>, rules: readonly MediaWorkflowOutputRule[]): ComfyUiOutputFile[] {
    const outputs = isRecord(payload.outputs)
      ? payload.outputs
      : findNestedOutputs(payload);
    if (!outputs) {
      return [];
    }
    const files: ComfyUiOutputFile[] = [];
    for (const rule of rules) {
      const output = outputs[rule.nodeId];
      const candidates = collectFileDescriptors(output, rule.artifactType);
      files.push(...(rule.collect === "first" ? candidates.slice(0, 1) : candidates));
    }
    return uniqueFiles(files);
  }

  private async pollJob(operationId: string): Promise<ComfyUiPollResult> {
    const response = await this.tryRequestJson(`/api/jobs/${encodeURIComponent(operationId)}`, { method: "GET" });
    if (!response.ok) {
      if (response.status === 404) return { status: "pending" };
      return { status: "failed", message: `ComfyUI 查询任务失败：HTTP ${response.status}。` };
    }
    return toPollResult(decodeComfyUiJobObservation(operationId, response.value));
  }

  private async pollLegacyHistory(operationId: string): Promise<ComfyUiPollResult> {
    const paths = [
      `/api/history_v2/${encodeURIComponent(operationId)}`,
      `/api/history/${encodeURIComponent(operationId)}`,
      `/history/${encodeURIComponent(operationId)}`,
    ];
    for (const path of paths) {
      const response = await this.tryRequestJson(path, { method: "GET" });
      if (!response.ok) {
        if (response.status === 404) continue;
        return { status: "failed", message: `ComfyUI 查询历史失败：HTTP ${response.status}。` };
      }
      return toPollResult(decodeComfyUiLegacyObservation(operationId, response.value));
    }
    return { status: "pending" };
  }

  private async tryRequestJson(path: string, init: RequestInit): Promise<{ readonly ok: boolean; readonly status: number; readonly value?: unknown }> {
    try {
      const response = await this.request(path, init, false);
      if (!response.ok) {
        await cancelResponseBody(response);
        return { ok: false, status: response.status };
      }
      return { ok: true, status: response.status, value: await response.json() };
    } catch (error) {
      if (error instanceof ComfyUiHttpError) return { ok: false, status: error.status };
      throw error;
    }
  }

  private async requestJson(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.request(path, init);
    return await response.json();
  }

  private async request(path: string, init: RequestInit, requireOk = true): Promise<Response> {
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl.origin) {
      throw new Error("ComfyUI 请求不能离开已配置的连接地址。");
    }
    const headers = new Headers(init.headers);
    if (this.connection.authMode === "bearer") {
      if (!this.apiKey) throw new Error("ComfyUI 连接缺少 API Key。");
      headers.set("authorization", `Bearer ${this.apiKey}`);
    }
    let response: Response;
    if (this.connection.networkPolicy === "trusted_private_network") {
      response = await this.fetchImpl(url, { ...init, headers, redirect: "manual" });
    } else {
      try {
        const prepared = await preparePinnedPublicHttpRequest(url, { ...init, headers, redirect: "manual" }, {
          timeoutMs: 30_000, resolveHostAddresses: this.resolveHostAddresses,
        });
        response = await prepared.fetch(this.fetchImpl);
      } catch (error) {
        if (error instanceof PublicHttpError && error.code === "local_or_private_host") {
          throw new PublicHttpError(error.code, "该地址位于本机或局域网，请显式启用可信自托管连接。", { cause: error });
        }
        throw error;
      }
    }
    if (response.status >= 300 && response.status < 400) {
      await cancelResponseBody(response);
      throw new Error("ComfyUI 返回了重定向，已为安全起见阻断。");
    }
    if (requireOk && !response.ok) {
      await cancelResponseBody(response);
      throw new ComfyUiHttpError(response.status, `ComfyUI 请求失败：HTTP ${response.status}。`);
    }
    return response;
  }
}

/**
 * Error/redirect bodies are not protocol status evidence. Await native cleanup
 * with a fixed deadline; a started, rejected or stalled cancel is not completion.
 * The original Promise remains observed even if the deadline wins.
 */
async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      response.body.cancel(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("ComfyUI 响应体清理超时，完成状态未知。")), 1_000);
      }),
    ]);
  } catch (error) {
    throw new Error("ComfyUI 响应体清理未确认，完成状态未知。", { cause: error });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

class ComfyUiHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function normalizeBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("ComfyUI 地址必须使用 HTTP 或 HTTPS。");
  if (url.username || url.password || url.search || url.hash) throw new Error("ComfyUI 地址不能包含账号、密码、查询参数或锚点。");
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url;
}

function toPollResult(observation: ComfyUiStatusObservation): ComfyUiPollResult {
  if (observation.kind === "nonterminal") {
    return { status: "pending", recovery: { observation: observation.reason,
      ...(observation.rawStatus ? { status: observation.rawStatus } : {}) } };
  }
  const { terminalObservation, payload } = observation;
  return terminalObservation.outcome === "completed"
    ? { status: "succeeded", payload, terminalObservation }
    : { status: "failed", message: readErrorMessage(payload), terminalObservation };
}

function readErrorMessage(value: Record<string, unknown>): string {
  for (const key of ["error", "error_message", "message"]) {
    if (typeof value[key] === "string" && value[key]) return String(value[key]);
  }
  return "ComfyUI 工作流执行失败。";
}

function findNestedOutputs(value: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(value.data) && isRecord(value.data.outputs)) return value.data.outputs;
  if (isRecord(value.result) && isRecord(value.result.outputs)) return value.result.outputs;
  return undefined;
}

function collectFileDescriptors(value: unknown, artifactType: "image" | "video"): ComfyUiOutputFile[] {
  if (Array.isArray(value)) return value.flatMap((item) => collectFileDescriptors(item, artifactType));
  if (!isRecord(value)) return [];
  const direct = typeof value.filename === "string"
    ? [{
        filename: value.filename,
        subfolder: typeof value.subfolder === "string" ? value.subfolder : undefined,
        type: typeof value.type === "string" ? value.type : undefined,
        artifactType,
      } satisfies ComfyUiOutputFile]
    : [];
  return [...direct, ...Object.values(value).flatMap((item) => collectFileDescriptors(item, artifactType))];
}

function uniqueFiles(files: readonly ComfyUiOutputFile[]): ComfyUiOutputFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = `${file.type ?? ""}:${file.subfolder ?? ""}:${file.filename}:${file.artifactType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inferContentType(filename: string, artifactType: "image" | "video"): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  return artifactType === "video" ? "video/mp4" : "image/png";
}
