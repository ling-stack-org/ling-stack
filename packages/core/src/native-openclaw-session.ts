import { NativeExecutionJournalError, type NativeOpenClawSessionRoute } from "./native-execution-types.js";

export function normalizeOpenClawAgentId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value)) {
    throw new NativeExecutionJournalError("native_journal_invalid");
  }
  return value.toLowerCase();
}

/** Validates only Ling's dedicated namespace, never a caller-selected Gateway key. */
export function validateNativeOpenClawSessionRoute(value: unknown): asserts value is NativeOpenClawSessionRoute {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NativeExecutionJournalError("native_journal_invalid");
  const route = value as Record<string, unknown>;
  const agentId = normalizeOpenClawAgentId(route.agentId);
  if (route.agentId !== agentId || typeof route.sessionKey !== "string"
    || !route.sessionKey.startsWith(`agent:${agentId}:ling:`)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(route.sessionKey.slice(`agent:${agentId}:ling:`.length))
    || typeof route.requireExistingSession !== "boolean"
    || Object.keys(route).some(key => !["agentId", "sessionKey", "requireExistingSession"].includes(key))) {
    throw new NativeExecutionJournalError("native_journal_invalid");
  }
}
