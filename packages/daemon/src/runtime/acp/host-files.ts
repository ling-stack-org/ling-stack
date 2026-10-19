import { isAbsolute } from "node:path";
import { methods, type AnyMessage, type ClientCapabilities, type JsonRpcId,
  type ReadTextFileRequest, type ReadTextFileResponse, type WriteTextFileRequest, type WriteTextFileResponse } from "@agentclientprotocol/sdk";
import { AcpLifecycleError, record, text } from "./live-errors.js";
import { AcpHostRequests, copyHostHandler, type AcpHostHandler, type AcpHostScope } from "./host-requests.js";

export type { AcpHostRequest as AcpHostFileRequest, AcpHostHandler as AcpHostFileHandler, AcpHostScope as AcpHostFileScope } from "./host-requests.js";
export interface AcpHostFileHandlers {
  readonly readTextFile?: AcpHostHandler<ReadTextFileRequest, ReadTextFileResponse>;
  readonly writeTextFile?: AcpHostHandler<WriteTextFileRequest, WriteTextFileResponse>;
}

/** Prompt-scoped file protocol validation; shared registry owns cancellation and replies. */
export class AcpHostFiles extends AcpHostRequests {
  readonly #handlers: AcpHostFileHandlers;
  constructor(handlers: AcpHostFileHandlers | undefined, timeoutMs: number,
    fail: (error: AcpLifecycleError) => AcpLifecycleError, retireReply: (id: JsonRpcId) => void) {
    super(timeoutMs, fail, retireReply);
    this.#handlers = { readTextFile: copyHostHandler(handlers?.readTextFile), writeTextFile: copyHostHandler(handlers?.writeTextFile) };
  }

  get capabilities(): ClientCapabilities {
    if (!this.#handlers.readTextFile && !this.#handlers.writeTextFile) return {};
    return { fs: { readTextFile: Boolean(this.#handlers.readTextFile), writeTextFile: Boolean(this.#handlers.writeTextFile) } };
  }

  receive(message: AnyMessage, scope?: AcpHostScope): void {
    if (!("method" in message)) return;
    const read = message.method === methods.client.fs.readTextFile;
    if (!read && message.method !== methods.client.fs.writeTextFile) return;
    if (!("id" in message)) throw new AcpLifecycleError("protocol_error", "unknown");
    const handler = read ? this.#handlers.readTextFile : this.#handlers.writeTextFile;
    if (!handler) return;
    const params = message.params;
    if (!scope || !record(params) || params.sessionId !== scope.sessionId) throw new AcpLifecycleError("binding_mismatch", "unknown");
    // The SDK defaults malformed optional ranges to undefined; reject before that can broaden a read.
    if (!text(params.path) || !isAbsolute(params.path) || /[\x00-\x1f\x7f]/.test(params.path)
      || Object.keys(params).some(key => !(read ? ["sessionId", "path", "line", "limit", "_meta"] : ["sessionId", "path", "content", "_meta"]).includes(key))
      || (read ? !validRange(params.line, 1) || !validRange(params.limit, 0)
        : typeof params.content !== "string")
      || (params._meta != null && !record(params._meta))) throw new AcpLifecycleError("protocol_error", "unknown");
    const base = { sessionId: scope.sessionId, path: params.path };
    if (read) this.reserve(message.id, message.method, { ...base, ...(params.line != null ? { line: Number(params.line) } : {}),
      ...(params.limit != null ? { limit: Number(params.limit) } : {}) }, this.#handlers.readTextFile!, scope);
    else this.reserve(message.id, message.method, { ...base, content: params.content as string }, this.#handlers.writeTextFile!, scope);
  }

  async read(requestId: JsonRpcId, signal: AbortSignal): Promise<ReadTextFileResponse> {
    const result = await this.execute(requestId, methods.client.fs.readTextFile, signal);
    if (!record(result) || typeof result.content !== "string" || Object.keys(result).some(key => key !== "content")) {
      throw this.fail(new AcpLifecycleError("host_commit_failed", "unknown"));
    }
    return { content: result.content };
  }

  async write(requestId: JsonRpcId, signal: AbortSignal): Promise<WriteTextFileResponse> {
    const result = await this.execute(requestId, methods.client.fs.writeTextFile, signal);
    if (!record(result) || Object.keys(result).length) throw this.fail(new AcpLifecycleError("host_commit_failed", "unknown"));
    return {};
  }

}
function validRange(value: unknown, minimum: number): boolean {
  return value == null || typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= 4294967295;
}
