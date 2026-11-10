import type { MediaRemoteTerminalObservation } from "@ling-stack/contracts";
import { isRecord } from "../../../shared/validation.js";

export type ComfyUiTerminalObservation = Extract<MediaRemoteTerminalObservation,
  { readonly protocol: "comfy_jobs_v1" | "comfy_prompt_legacy_v1" }>;

export type ComfyUiStatusObservation =
  | { readonly kind: "nonterminal"; readonly reason: "malformed_response" | "identity_mismatch"
      | "unknown_status" | "contradictory_status" | "pending"; readonly rawStatus?: string }
  | { readonly kind: "terminal"; readonly terminalObservation: ComfyUiTerminalObservation;
      readonly payload: Record<string, unknown> };

/**
 * Decode the closed jobs_v1 status contract, not a generic success heuristic.
 * This is a remote observation only. It does not prove local completion,
 * artifact collection, source lineage, or whole-operation cancellation.
 */
export function decodeComfyUiJobObservation(operationId: string, value: unknown): ComfyUiStatusObservation {
  if (!isRecord(value)) return { kind: "nonterminal", reason: "malformed_response" };
  if (!operationId || value.id !== operationId || !hasMatchingEchoedIds(value, operationId)) {
    return { kind: "nonterminal", reason: "identity_mismatch" };
  }
  const status = typeof value.status === "string" ? value.status : undefined;
  if (status === "pending" || status === "in_progress") return { kind: "nonterminal", reason: "pending", rawStatus: status };
  if (status !== "completed" && status !== "failed" && status !== "cancelled") {
    return { kind: "nonterminal", reason: "unknown_status", rawStatus: status };
  }
  if (Object.hasOwn(value, "execution_status") && !matchesLegacyFinalStatus(value.execution_status, status === "completed")) {
    return { kind: "nonterminal", reason: "contradictory_status", rawStatus: status };
  }
  return {
    kind: "terminal", payload: value,
    terminalObservation: Object.freeze({ protocol: "comfy_jobs_v1", externalOperationId: operationId,
      identitySource: "echoed_id", rawStatus: status, outcome: status }),
  };
}

/**
 * Legacy history identity is the exact own history key. Optional echoed
 * prompt identity may strengthen it, but must never contradict that key.
 * Upstream task_done records success/true or error/false; outputs are not
 * a final-status marker and arbitrary top-level records are not history.
 */
export function decodeComfyUiLegacyObservation(operationId: string, value: unknown): ComfyUiStatusObservation {
  if (!isRecord(value)) return { kind: "nonterminal", reason: "malformed_response" };
  if (!operationId || !Object.hasOwn(value, operationId) || !isRecord(value[operationId])) {
    return { kind: "nonterminal", reason: "identity_mismatch" };
  }
  const entry = value[operationId];
  if (!hasMatchingEchoedIds(entry, operationId) ||
      (Object.hasOwn(entry, "prompt") && (!Array.isArray(entry.prompt) || entry.prompt[1] !== operationId))) {
    return { kind: "nonterminal", reason: "identity_mismatch" };
  }
  if (!isRecord(entry.status)) return { kind: "nonterminal", reason: "unknown_status" };
  const status = typeof entry.status.status_str === "string" ? entry.status.status_str : undefined;
  if (status !== "success" && status !== "error") {
    return { kind: "nonterminal", reason: "unknown_status", rawStatus: status };
  }
  if (!matchesLegacyFinalStatus(entry.status, status === "success")) {
    return { kind: "nonterminal", reason: "contradictory_status", rawStatus: status };
  }
  return {
    kind: "terminal", payload: entry,
    terminalObservation: Object.freeze({ protocol: "comfy_prompt_legacy_v1", externalOperationId: operationId,
      identitySource: "exact_history_key", rawStatus: status, outcome: status === "success" ? "completed" : "failed" }),
  };
}

function hasMatchingEchoedIds(value: Record<string, unknown>, operationId: string): boolean {
  return ["id", "prompt_id"].every(key => !Object.hasOwn(value, key) || value[key] === operationId);
}

function matchesLegacyFinalStatus(value: unknown, completed: boolean): boolean {
  return isRecord(value) && value.completed === completed && value.status_str === (completed ? "success" : "error");
}
