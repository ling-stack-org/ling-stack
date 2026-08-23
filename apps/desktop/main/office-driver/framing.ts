import { OFFICE_DRIVER_MAX_FRAME_BYTES, OFFICE_DRIVER_MAX_RESULT_BYTES } from "@ling-stack/contracts";

export function encodeOfficeDriverFrame(value: unknown, maxBytes = OFFICE_DRIVER_MAX_FRAME_BYTES): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength === 0 || payload.byteLength > maxBytes) {
    throw new Error("office_driver_frame_too_large");
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

export class OfficeDriverFrameDecoder {
  private buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  constructor(private readonly maxBytes = OFFICE_DRIVER_MAX_RESULT_BYTES) {}

  push(chunk: Buffer): readonly unknown[] {
    if (chunk.byteLength === 0) return [];
    this.buffered = this.buffered.byteLength === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    const values: unknown[] = [];
    while (this.buffered.byteLength >= 4) {
      const size = this.buffered.readUInt32LE(0);
      if (size === 0 || size > this.maxBytes) throw new Error("office_driver_frame_length_invalid");
      if (this.buffered.byteLength < size + 4) break;
      const payload = this.buffered.subarray(4, size + 4);
      this.buffered = this.buffered.subarray(size + 4);
      try {
        values.push(JSON.parse(payload.toString("utf8")));
      } catch {
        throw new Error("office_driver_frame_json_invalid");
      }
    }
    if (this.buffered.byteLength > this.maxBytes + 4) {
      throw new Error("office_driver_frame_buffer_overflow");
    }
    return values;
  }

  finish(): void {
    if (this.buffered.byteLength !== 0) throw new Error("office_driver_frame_truncated");
  }
}
