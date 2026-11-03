import { deserializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/** Bounded SDK framing without copying and rescanning the entire partial frame on every chunk. */
export class BoundedMcpStdioReadBuffer {
  readonly #maxBufferSize: number;
  #buffer?: Buffer;
  #start = 0;
  #end = 0;
  #scan = 0;

  constructor(options: { readonly maxBufferSize: number }) {
    this.#maxBufferSize = options.maxBufferSize;
  }

  append(chunk: Buffer): void {
    const pendingBytes = this.#end - this.#start;
    const size = pendingBytes + chunk.length;
    if (size > this.#maxBufferSize) {
      this.clear();
      throw new Error("MCP stdio read buffer exceeded its byte limit.");
    }
    if (chunk.length === 0) return;
    if (!this.#buffer || this.#buffer.length - this.#end < chunk.length) {
      const previous = this.#buffer;
      if (previous && size <= previous.length) {
        previous.copy(previous, 0, this.#start, this.#end);
      } else {
        const capacity = Math.min(this.#maxBufferSize, Math.max(size, (previous?.length ?? 0) * 2));
        this.#buffer = Buffer.allocUnsafe(capacity);
        previous?.copy(this.#buffer, 0, this.#start, this.#end);
      }
      this.#scan -= this.#start;
      this.#start = 0;
      this.#end = pendingBytes;
    }
    chunk.copy(this.#buffer!, this.#end);
    this.#end += chunk.length;
  }

  readMessage(): JSONRPCMessage | null {
    if (!this.#buffer) return null;
    // Search only received, previously unscanned bytes, never unused capacity.
    const offset = this.#buffer.subarray(this.#scan, this.#end).indexOf(0x0a);
    if (offset === -1) {
      this.#scan = this.#end;
      return null;
    }
    const newline = this.#scan + offset;
    const line = this.#buffer.toString("utf8", this.#start, newline).replace(/\r$/u, "");
    this.#start = newline + 1;
    this.#scan = this.#start;
    if (this.#start === this.#end) this.clear();
    return deserializeMessage(line);
  }

  clear(): void {
    this.#buffer = undefined;
    this.#start = this.#end = this.#scan = 0;
  }
}
