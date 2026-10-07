import { StringDecoder } from "node:string_decoder";
import type { RunEventEmitter, UnifiedExecOutputChunk, UnifiedExecStreamSummary } from "@ling-stack/core";
import { redactTextWithSecrets } from "../../shared/redaction.js";

const STREAM_PREVIEW_BYTES = 8 * 1024;
const OUTPUT_CHUNK_BYTES = 4 * 1024;
const ARTIFACT_BYTES = 2 * 1024 * 1024;
const REDACTION_CARRY_CHARS = 256;

/** Decode OS byte chunks before redaction; bound previews independently of raw byte accounting. */
export function createStreamCapture(
  stream: "stdout" | "stderr",
  toolCallId: string,
  appendAndMaybeStream: RunEventEmitter,
  extraSecrets: readonly (string | undefined)[],
): {
  readonly ingest: (chunk: Buffer) => void;
  readonly flush: () => void;
  readonly snapshot: () => StreamCaptureSnapshot;
} {
  const decoder = new StringDecoder("utf8");
  let rawByteCount = 0;
  let sequence = 0;
  let carry = "";
  const lineFlushAllowed = !extraSecrets.some(secret => secret?.includes("\n") || secret?.includes("\r"));
  const capture = createMutableStreamCapture();
  return {
    ingest(chunk) {
      rawByteCount += chunk.byteLength;
      const text = carry + decoder.write(chunk);
      let emitLength = Math.max(0, text.length - REDACTION_CARRY_CHARS,
        lineFlushAllowed ? safeLineFlushLength(text) : 0);
      // The carry is measured in UTF-16 units, but events must contain whole scalars.
      if (emitLength > 0 && isHighSurrogate(text.charCodeAt(emitLength - 1))
        && isLowSurrogate(text.charCodeAt(emitLength))) emitLength -= 1;
      carry = text.slice(emitLength);
      appendRedactedText(text.slice(0, emitLength));
    },
    flush() {
      appendRedactedText(carry + decoder.end());
      carry = "";
    },
    snapshot() {
      return {
        ...capture,
        byteCount: rawByteCount,
        lineCount: countLines(capture.artifactContent),
      };
    },
  };

  function appendRedactedText(text: string): void {
    if (!text) {
      return;
    }
    const redacted = redactTextWithSecrets(text, extraSecrets);
    const wasRedacted = redacted !== text;
    capture.redacted = capture.redacted || wasRedacted;
    appendBounded(capture, redacted);
    for (const chunkText of splitByBytes(redacted, OUTPUT_CHUNK_BYTES)) {
      sequence += 1;
      const chunk: UnifiedExecOutputChunk = {
        toolCallId,
        stream,
        sequence,
        text: chunkText,
        byteCount: Buffer.byteLength(chunkText, "utf8"),
        redacted: wasRedacted,
        truncated: false,
        ts: new Date().toISOString(),
      };
      appendAndMaybeStream("tool_update", {
        toolCallId,
        toolName: "bash",
        partialResult: chunk,
      });
    }
  }
}

/** A completed line is safe to publish unless an authorization value continues across it. */
function safeLineFlushLength(text: string): number {
  const boundary = text.lastIndexOf("\n") + 1;
  if (boundary === 0) return 0;
  const authPrefix = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]*/gi;
  for (const match of text.matchAll(authPrefix)) {
    if (match.index < boundary && match.index + match[0].length >= boundary) return match.index;
  }
  return boundary;
}

export function createSyntheticStreamCapture(text: string, extraSecrets: readonly (string | undefined)[]): StreamCaptureSnapshot {
  const redacted = redactTextWithSecrets(text, extraSecrets);
  const capture = createMutableStreamCapture();
  capture.redacted = redacted !== text;
  appendBounded(capture, redacted);
  return {
    ...capture,
    byteCount: Buffer.byteLength(text, "utf8"),
    lineCount: countLines(redacted),
  };
}

function createMutableStreamCapture(): MutableStreamCapture {
  return {
    byteCount: 0,
    lineCount: 0,
    preview: "",
    artifactContent: "",
    previewBytes: 0,
    artifactBytes: 0,
    previewTruncated: false,
    artifactTruncated: false,
    redacted: false,
  };
}

function appendBounded(capture: MutableStreamCapture, text: string): void {
  const previewRemaining = STREAM_PREVIEW_BYTES - capture.previewBytes;
  if (!capture.previewTruncated && previewRemaining > 0) {
    const previewChunk = truncateToBytes(text, previewRemaining);
    capture.preview += previewChunk;
    capture.previewBytes += Buffer.byteLength(previewChunk, "utf8");
    if (previewChunk.length < text.length) {
      capture.previewTruncated = true;
    }
  } else if (text.length > 0) {
    capture.previewTruncated = true;
  }

  // Once a scalar does not fit, keep the exact prefix; never append later text into the gap.
  if (capture.artifactTruncated) return;
  const artifactRemaining = ARTIFACT_BYTES - capture.artifactBytes;
  if (artifactRemaining <= 0) {
    capture.artifactTruncated = capture.artifactTruncated || text.length > 0;
    return;
  }
  const artifactChunk = truncateToBytes(text, artifactRemaining);
  capture.artifactContent += artifactChunk;
  capture.artifactBytes += Buffer.byteLength(artifactChunk, "utf8");
  if (artifactChunk.length < text.length) {
    capture.artifactTruncated = true;
  }
}

export function toStreamSummary(capture: StreamCaptureSnapshot): UnifiedExecStreamSummary & { artifactId?: string } {
  return {
    byteCount: capture.byteCount,
    lineCount: capture.lineCount,
    preview: capture.preview,
    truncated: capture.previewTruncated || capture.artifactTruncated,
  };
}


/** Split once by encoded byte offsets; repeated rescans make large output quadratic. */
function splitByBytes(text: string, maxBytes: number): string[] {
  const bytes = Buffer.from(text, "utf8");
  const chunks: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    const end = utf8BoundaryBefore(bytes, Math.min(start + maxBytes, bytes.length));
    // All production limits exceed the maximum UTF-8 scalar size.
    if (end <= start) throw new RangeError("Output chunk budget cannot hold a UTF-8 character.");
    chunks.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
  }
  return chunks;
}

/** A byte cap may leave unused bytes, but it may not keep half a character. */
function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const bytes = Buffer.from(text, "utf8");
  const end = utf8BoundaryBefore(bytes, Math.max(0, maxBytes));
  return bytes.subarray(0, end).toString("utf8");
}

function utf8BoundaryBefore(bytes: Buffer, end: number): number {
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return end;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function countLines(text: string): number {
  if (!text) {
    return 0;
  }
  return text.split(/\r\n|\r|\n/).length;
}


interface MutableStreamCapture {
  byteCount: number;
  lineCount: number;
  preview: string;
  artifactContent: string;
  previewBytes: number;
  artifactBytes: number;
  previewTruncated: boolean;
  artifactTruncated: boolean;
  redacted: boolean;
}

export interface StreamCaptureSnapshot {
  readonly byteCount: number;
  readonly lineCount: number;
  readonly preview: string;
  readonly artifactContent: string;
  readonly previewBytes: number;
  readonly artifactBytes: number;
  readonly previewTruncated: boolean;
  readonly artifactTruncated: boolean;
  readonly redacted: boolean;
}
