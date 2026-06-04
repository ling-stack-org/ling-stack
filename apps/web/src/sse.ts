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

  await readSseResponse(response, (parsed) => {
    if (parsed.event === "ready") {
      const data = JSON.parse(parsed.data) as { runId?: unknown };
      if (typeof data.runId === "string") {
        onMessage({ kind: "ready", runId: data.runId });
      }
      return;
    }
    onMessage({ kind: "event", event: JSON.parse(parsed.data) as RunEventEnvelope });
  });
}

export async function readSseResponse(response: Response, onMessage: (message: { readonly event: string; readonly data: string }) => void): Promise<void> {
  if (!response.body) {
    throw new Error("Response did not include a stream body.");
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      const parsed = parseSseBlock(buffer);
      if (parsed) {
        onMessage(parsed);
      }
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const parsed = parseSseBlock(block);
      if (parsed) {
        onMessage(parsed);
      }
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
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown };
    if (typeof body.message === "string") {
      message = body.message;
    } else if (typeof body.error === "string") {
      message = body.error;
    }
  } catch {
    return friendlyErrorMessage(message);
  }
  return friendlyErrorMessage(message);
}

function friendlyErrorMessage(message: string): string {
  if ((message.includes("EACCES") || message.includes("ENOENT")) && message.includes(".ling-stack")) {
    return `Workspace path does not exist or is not writable. Use the absolute path to your local checkout. ${message}`;
  }
  return message;
}
