import { approvalToolDecisions, readOnlyRunTools, riskyRunTools } from "../../approval-policy.js";
import { authorizationModes, sessionPermissionModes, workspaceAccessModes,
  type EffectiveRunPolicySnapshot } from "../../session-permissions.js";
import { UserInputStoreError } from "../../user-input-store-types.js";

/** Validate the persisted non-secret policy DTO. Current authorization is still resolved by the Host. */
export function assertUserInputAdmissionPolicy(value: unknown): asserts value is EffectiveRunPolicySnapshot {
  const reject = (): never => { throw new UserInputStoreError("invalid_input"); };
  if (!record(value)) return reject();
  const keys = ["mode", "authorizationMode", "workspaceAccessMode", "conversationMode", "planModeMutationPolicy",
    "toolDecisions", "allowedWritePaths", "workspacePolicyUpdatedAt", "riskNotes"];
  const tools = [...readOnlyRunTools, ...riskyRunTools];
  if (Object.keys(value).some(key => !keys.includes(key))
    || !member(sessionPermissionModes, value.mode)
    || value.authorizationMode !== undefined && !member(authorizationModes, value.authorizationMode)
    || value.workspaceAccessMode !== undefined && !member(workspaceAccessModes, value.workspaceAccessMode)
    || value.conversationMode !== undefined && !member(["default", "plan"], value.conversationMode)
    || value.planModeMutationPolicy !== undefined && value.planModeMutationPolicy !== "deny_repo_tracked_mutation"
    || typeof value.workspacePolicyUpdatedAt !== "string" || !Number.isFinite(Date.parse(value.workspacePolicyUpdatedAt))
    || !record(value.toolDecisions) || Object.keys(value.toolDecisions).length !== tools.length
    || !tools.every(tool => member(approvalToolDecisions, (value.toolDecisions as Record<string, unknown>)[tool]))
    || !Array.isArray(value.allowedWritePaths) || !value.allowedWritePaths.every(path => typeof path === "string")
    || !Array.isArray(value.riskNotes) || !value.riskNotes.every(note => record(note)
      && Object.keys(note).every(key => ["code", "message", "tool"].includes(key))
      && typeof note.code === "string" && typeof note.message === "string"
      && (note.tool === undefined || member(tools, note.tool)))) return reject();
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function member(values: readonly string[], value: unknown): boolean {
  return typeof value === "string" && values.includes(value);
}
