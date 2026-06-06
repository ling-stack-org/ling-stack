import { CliError, errorMessage } from "../errors.js";

interface SseBlock {
  readonly event: string;
  readonly data: string;
}

export interface RunEventEnvelope {
  readonly id: string;
  readonly runId: string;
  readonly seq: number;
  readonly ts: string;
  readonly type: string;
  readonly data: unknown;
}

export type RunStreamRecord =
  | { readonly kind: "ready"; readonly runId: string }
  | { readonly kind: "event"; readonly envelope: RunEventEnvelope };

export function parseSseBlock(block: string): SseBlock | undefined {
  const lines = block.split("\n");
  let event = "message";
  const dataLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return undefined;
  }
  return { event, data: dataLines.join("\n") };
}

export function parseRunStreamRecord(block: string): RunStreamRecord | undefined {
  const parsed = parseSseBlock(block);
  if (!parsed) {
    return undefined;
  }
  const data = parseJson(parsed.data, `Invalid SSE JSON for event ${parsed.event}`);
  if (parsed.event === "ready") {
    const runId = readString(data, "runId");
    if (!runId) {
      throw new CliError(4, "bad_sse_event", "ready event did not include runId");
    }
    return { kind: "ready", runId };
  }
  if (!isRunEventEnvelope(data)) {
    throw new CliError(4, "bad_sse_event", `SSE event ${parsed.event} did not contain a run event envelope`);
  }
  return { kind: "event", envelope: data };
}

export function isRunEventEnvelope(value: unknown): value is RunEventEnvelope {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.runId === "string" &&
    typeof value.seq === "number" &&
    typeof value.ts === "string" &&
    typeof value.type === "string" &&
    "data" in value
  );
}

function parseJson(value: string, message: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new CliError(4, "bad_sse_event", `${message}: ${errorMessage(error)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  const field = readField(value, key);
  return typeof field === "string" ? field : undefined;
}
