import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { CONVERSATION_VISUALIZATION_MAX_BYTES, conversationVisualizationMarkdown, normalizeConversationVisualization } from "@ling-stack/contracts";
import type { RunSession, RunStore, RuntimeAttemptFenceV1 } from "@ling-stack/core";
import type { PiRunnerToolHandledResult } from "@ling-stack/runner-pi";
import { isRecord } from "../../shared/validation.js";

type VisualizationWriter = Pick<RunStore, "saveConversationVisualization">;

export function publishConversationVisualization(store: VisualizationWriter,
  run: Pick<RunSession, "id" | "cwd">, fence: RuntimeAttemptFenceV1, callId: string, input: unknown, now: string): PiRunnerToolHandledResult {
  if (isRecord(input) && "sourceFile" in input) {
    const { sourceFile, ...metadata } = input;
    if ("html" in metadata || typeof sourceFile !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}\.html$/iu.test(sourceFile)) {
      return failure("visualization_invalid", "Provide either HTML or a simple .html filename from the current run's workspace staging directory.");
    }
    const sourceDirectory = join(".ling", "artifacts", "visualizations", run.id);
    const directory = join(run.cwd, sourceDirectory);
    try {
      const html = readVisualizationFile(join(realpathSync(run.cwd), sourceDirectory), sourceFile);
      input = { ...metadata, html };
    } catch {
      return failure("visualization_source_unavailable", `Place a regular UTF-8 HTML file of at most ${CONVERSATION_VISUALIZATION_MAX_BYTES} bytes in ${directory} and retry with its filename.`);
    }
  }
  const document = normalizeConversationVisualization(input);
  if (!document) return failure("visualization_invalid", "Provide a title, a summary, and self-contained HTML within the visualization limits.");
  try {
    const result = store.saveConversationVisualization({ runId: run.id, fence, toolCallId: callId, document, now });
    if (!result.ok) {
      const messages = {
        visualization_invalid: "The visualization input is invalid.",
        visualization_owner_changed: "The run no longer owns the assistant reply.",
        visualization_conflict: "The tool call already published a different visualization.",
        visualization_limit: "This reply has reached its visualization limit.",
      };
      return failure(result.code, messages[result.code]);
    }
    const markdown = conversationVisualizationMarkdown({ artifactId: result.artifactId, label: document.title });
    return { content: [{ type: "text", text: markdown }], details: { artifactId: result.artifactId } };
  } catch {
    return failure("visualization_storage_error", "The visualization could not be saved. Continue with a text explanation if the problem persists.");
  }
}

function readVisualizationFile(directory: string, name: string): string {
  const path = join(directory, name);
  const parent = lstatSync(directory, { bigint: true });
  const original = lstatSync(path, { bigint: true });
  if (!parent.isDirectory() || realpathSync(directory) !== directory || !original.isFile() || original.nlink !== 1n
    || original.size < 1n || original.size > CONVERSATION_VISUALIZATION_MAX_BYTES) {
    throw new Error("Invalid visualization source file.");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameRevision(original, fstatSync(fd, { bigint: true }))) throw new Error("Visualization source changed.");
    const bytes = Buffer.alloc(Number(original.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("Visualization source ended early.");
      offset += count;
    }
    if (!sameRevision(original, fstatSync(fd, { bigint: true })) || !sameRevision(original, lstatSync(path, { bigint: true }))
      || !sameRevision(parent, lstatSync(directory, { bigint: true })) || realpathSync(directory) !== directory) {
      throw new Error("Visualization source changed during the read.");
    }
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } finally {
    closeSync(fd);
  }
}

function sameRevision(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function failure(code: string, message: string): PiRunnerToolHandledResult {
  return { isError: true, content: [{ type: "text", text: message }], details: { code } };
}
