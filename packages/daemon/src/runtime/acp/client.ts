import {
  createAcpInitializeRequest,
  createAcpRunRequest,
  type AcpInitializeResponse,
  type AcpInitializeResult,
  type AcpRunRequest,
  type AcpRunResponse,
  type AcpRunResult,
} from "./protocol.js";

export interface AcpClientOptions {
  readonly endpoint: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof globalThis.fetch;
}

export class AcpClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: AcpClientOptions) {
    this.endpoint = options.endpoint;
    this.timeoutMs = options.timeoutMs ?? 1_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async initialize(signal?: AbortSignal): Promise<AcpInitializeResult> {
    const body = await this.postJson(createAcpInitializeRequest(), signal) as AcpInitializeResponse;
    if (body.error) {
      throw new Error(body.error.message || "ACP initialize failed");
    }
    if (!body.result || typeof body.result.protocolVersion !== "string" || typeof body.result.capabilities !== "object" || body.result.capabilities === null) {
      throw new Error("ACP initialize response is malformed");
    }
    return body.result;
  }

  async runTask(params: AcpRunRequest["params"], signal?: AbortSignal): Promise<AcpRunResult> {
    const body = await this.postJson(createAcpRunRequest(params), signal) as AcpRunResponse;
    if (body.error) {
      throw new Error(body.error.message || "ACP run failed");
    }
    if (!body.result || typeof body.result !== "object" || Array.isArray(body.result)) {
      throw new Error("ACP run response is malformed");
    }
    return body.result;
  }

  private async postJson(payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`ACP endpoint returned ${response.status}`);
      }
      return await response.json() as unknown;
    } finally {
      signal?.removeEventListener("abort", abort);
      clearTimeout(timeout);
    }
  }
}
