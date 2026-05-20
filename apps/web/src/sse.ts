import type { RunEventEnvelope } from "./types.js";

export type StreamMessage =
  | { readonly kind: "ready"; readonly runId: string }
  | { readonly kind: "event"; readonly event: RunEventEnvelope };

export async function streamRun(
  url: string,
  body: unknown,
  onMessage: (message: StreamMessage) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(await readErrorMessage(response));
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const parsed = parseSseBlock(block);
      if (!parsed) {
        continue;
      }
      if (parsed.event === "ready") {
        const data = JSON.parse(parsed.data) as { runId?: unknown };
        if (typeof data.runId === "string") {
          onMessage({ kind: "ready", runId: data.runId });
        }
        continue;
      }
      onMessage({ kind: "event", event: JSON.parse(parsed.data) as RunEventEnvelope });
    }
  }
}

function parseSseBlock(block: string): { event: string; data: string } | undefined {
  const lines = block.split("\n");
  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
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

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown };
    if (typeof body.message === "string") {
      return body.message;
    }
    if (typeof body.error === "string") {
      return body.error;
    }
  } catch {
    return `${response.status} ${response.statusText}`;
  }
  return `${response.status} ${response.statusText}`;
}
