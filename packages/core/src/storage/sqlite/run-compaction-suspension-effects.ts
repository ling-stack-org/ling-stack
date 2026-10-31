import { isDeepStrictEqual as same } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { readRunProgressFrozenExecution } from "../../run-progress-checkpoint-lineage.js";
import { RunProgressCheckpointError } from "../../run-progress-checkpoint-types.js";
import type { RunEventEnvelope, RunSession } from "../../run-types.js";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { validateRunProgressEffects, type RunProgressEffectStore } from "./run-progress-checkpoint-effects.js";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function fail(): never { throw new RunProgressCheckpointError("checkpoint.effect_unknown"); }

/** Reuse ordinary receipt validation without pretending the SDK compacted view is ordinary.
 * This projection exists only on the stack: all tool input/output comes from canonical
 * facts, every kept SDK pair must match them, and nothing is persisted or installed. */
export function verifyCompactionSuspensionEffects(database: DatabaseSync, ports: RunProgressEffectStore, run: RunSession,
  events: readonly RunEventEnvelope[], modelView: readonly unknown[], sourceFence: RuntimeAttemptFenceV1): void {
  const prepared = readRunProgressFrozenExecution(run).preparedInput;
  if (!record(prepared) || typeof prepared.userPrompt !== "string") fail();
  const validationView: unknown[] = [{ role: "user", content: prepared.userPrompt }];
  const starts = new Map<string, Extract<RunEventEnvelope, { type: "tool_start" }>>();
  const ends = new Map<string, Extract<RunEventEnvelope, { type: "tool_end" }>>();
  for (const event of events) {
    if (event.type === "tool_start") {
      const id = event.data.toolCallId;
      if (typeof id !== "string" || starts.has(id)) fail();
      starts.set(id, event);
      validationView.push({ role: "assistant", content: [{ type: "toolCall", id, name: event.data.toolName, arguments: event.data.args }] });
    } else if (event.type === "tool_end") {
      const id = event.data.toolCallId;
      if (typeof id !== "string" || ends.has(id) || !record(event.data.result)) fail();
      ends.set(id, event);
      validationView.push({ role: "toolResult", toolCallId: id, toolName: event.data.toolName,
        content: event.data.result.content, isError: event.data.isError });
    }
  }
  for (const message of modelView) {
    if (!record(message)) fail();
    if (message.role === "user") {
      const content = message.content;
      if (typeof content === "string" ? content !== prepared.userPrompt
        : !Array.isArray(content) || !content.length || content.some(block => !record(block) || block.type !== "text" || typeof block.text !== "string")
          || content.map(block => (block as Record<string, unknown>).text).join("") !== prepared.userPrompt) fail();
    }
    if (message.role === "assistant" && Array.isArray(message.content)) for (const block of message.content) {
      if (!record(block) || block.type !== "toolCall") continue;
      const start = typeof block.id === "string" ? starts.get(block.id) : undefined;
      if (!start || block.name !== start.data.toolName || !same(block.arguments, start.data.args)) fail();
    }
    if (message.role === "toolResult") {
      const end = typeof message.toolCallId === "string" ? ends.get(message.toolCallId) : undefined;
      if (!end || !record(end.data.result) || end.data.toolName !== message.toolName || end.data.isError !== message.isError
        || !same(end.data.result.content, message.content)) fail();
    }
  }
  validateRunProgressEffects(ports, run, events.filter(event => !["context_compaction_start", "context_compaction_end"].includes(event.type)),
    validationView, sourceFence, database);
}
