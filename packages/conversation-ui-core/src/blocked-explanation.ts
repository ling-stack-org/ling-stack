/** Model text retained for disclosure, never a Host outcome or execution fact. */
export interface UnverifiedBlockedNarration {
  readonly agentReason: string;
  readonly rawJson: string;
}

/** Display-only join. The adapter must validate Host outcome and lineage first. */
export interface ConversationBlockedExplanation extends UnverifiedBlockedNarration {
  readonly hostCode: "required_operation_evidence_missing";
  readonly hostReason: string;
}

/**
 * Recognize only the complete old blocked-response shape. This parser has no
 * authority to classify a task: examples, partial streams and general JSON stay
 * ordinary narration unless a caller also validates the owning Host outcome.
 */
export function parseUnverifiedBlockedNarration(rawJson: string): UnverifiedBlockedNarration | undefined {
  if (rawJson.length > 32_768) return undefined;
  let value: unknown;
  try { value = JSON.parse(rawJson); } catch { return undefined; }
  if (!hasExactKeys(value, ["status", "task", "proposal", "reason", "missingCapabilities", "verification", "decision"])
    || value.status !== "blocked" || !isText(value.task) || !isText(value.reason) || !isText(value.decision)
    || !isTextArray(value.missingCapabilities) || value.missingCapabilities.length === 0
    || !hasExactKeys(value.proposal, ["command", "cwd", "readPaths", "writePaths", "network"])
    || !isText(value.proposal.command) || !isText(value.proposal.cwd)
    || !isTextArray(value.proposal.readPaths) || !isTextArray(value.proposal.writePaths)
    || typeof value.proposal.network !== "boolean"
    || !hasExactKeys(value.verification, ["entryFileRead", "commandExecuted", "toolsCalled", "dependencyRequirement"])
    || typeof value.verification.entryFileRead !== "boolean" || typeof value.verification.commandExecuted !== "boolean"
    || typeof value.verification.toolsCalled !== "boolean" || !isText(value.verification.dependencyRequirement)) return undefined;
  return { agentReason: value.reason, rawJson };
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function isTextArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isText);
}
