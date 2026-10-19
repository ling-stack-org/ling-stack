import { isDeepStrictEqual } from "node:util";
import { NativeOutputError } from "../native-stream-redaction.js";
import type { CodexToolOutput } from "./tool-output.js";
import type { ThreadItem } from "./protocol/v2/ThreadItem.js";
import type { CollabAgentTool } from "./protocol/v2/CollabAgentTool.js";
import type { CollabAgentStatus } from "./protocol/v2/CollabAgentStatus.js";

type ObservedKind = Extract<ThreadItem, { type: "webSearch" | "imageView" | "sleep" | "collabAgentToolCall" }>["type"];
export const codexObservedTools: ReadonlySet<string> = new Set<ObservedKind>(["webSearch", "imageView", "sleep", "collabAgentToolCall"]);
const collabTools: ReadonlySet<string> = new Set<CollabAgentTool>(["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent", "sendMessage", "followupTask", "interruptAgent", "listAgents"]);
const agentStatuses: ReadonlySet<string> = new Set<CollabAgentStatus>(["pendingInit", "running", "interrupted", "completed", "errored", "shutdown", "notFound"]);

export function codexObservedTool(item: Record<string, unknown>, completed: boolean): CodexToolOutput {
  const status = completed ? "completed" : "inProgress";
  switch (item.type) {
    case "webSearch": {
      if (typeof item.query !== "string" || (item.results != null && !Array.isArray(item.results))) invalid();
      const action = searchAction(item.action);
      return { toolName: "web_search", args: { query: item.query, action }, isError: false,
        result: { status, query: item.query, action, results: item.results ?? null } };
    }
    case "imageView":
      if (!text(item.path)) invalid();
      return { toolName: "view_image", args: { path: item.path }, isError: false, result: { status, path: item.path } };
    case "sleep":
      if (typeof item.durationMs !== "number" || !Number.isSafeInteger(item.durationMs) || item.durationMs < 0) invalid();
      return { toolName: "clock.sleep", args: { durationMs: item.durationMs }, isError: false, result: { status } };
    case "collabAgentToolCall": {
      if (!text(item.tool) || !collabTools.has(item.tool) || !text(item.senderThreadId)
        || !text(item.status) || !(completed ? ["completed", "failed", "interrupted"] : ["inProgress"]).includes(item.status)
        || !Array.isArray(item.receiverThreadIds) || !item.receiverThreadIds.every(text) || !record(item.agentsStates)
        || ![item.prompt, item.model, item.reasoningEffort].every(value => value === null || typeof value === "string")) invalid();
      if (item.receiverThreadIds.length > 256 || Object.keys(item.agentsStates).length > 256) throw new NativeOutputError("capacity_exceeded");
      const agentsStates = Object.fromEntries(Object.entries(item.agentsStates).map(([id, state]) => {
        if (!text(id) || !record(state) || !text(state.status) || !agentStatuses.has(state.status)
          || !(state.message === null || typeof state.message === "string")) invalid();
        return [id, { status: state.status, message: state.message }];
      }));
      return { toolName: `codex.${item.tool}`,
        args: { senderThreadId: item.senderThreadId, prompt: item.prompt, model: item.model, reasoningEffort: item.reasoningEffort },
        isError: item.status === "failed" || item.status === "interrupted",
        result: { status: item.status, receiverThreadIds: item.receiverThreadIds, agentsStates } };
    }
    default: throw new NativeOutputError("unsupported_item");
  }
}

export function codexToolArgsMatch(type: string, before: unknown, after: unknown): boolean {
  if (type !== "webSearch" || !record(before) || !record(after)) return isDeepStrictEqual(before, after);
  // Native search may start before its query/action is available. Known input never changes.
  return (before.query === "" || before.query === after.query)
    && (before.action === null || isDeepStrictEqual(before.action, after.action));
}

function searchAction(value: unknown): unknown {
  if (value === null) return null;
  if (!record(value)) invalid();
  switch (value.type) {
    case "search":
      if (!(value.query === null || typeof value.query === "string")
        || !(value.queries === null || (Array.isArray(value.queries) && value.queries.every(query => typeof query === "string")))) invalid();
      return { type: "search", query: value.query, queries: value.queries };
    case "openPage":
      if (!(value.url === null || typeof value.url === "string")) invalid();
      return { type: "openPage", url: value.url };
    case "findInPage":
      if (!(value.url === null || typeof value.url === "string") || !(value.pattern === null || typeof value.pattern === "string")) invalid();
      return { type: "findInPage", url: value.url, pattern: value.pattern };
    case "other": return { type: "other" };
    default: invalid();
  }
}

function invalid(): never { throw new NativeOutputError("invalid_event"); }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
