import { isDeepStrictEqual } from "node:util";
import { authorizationModes, workspaceAccessModes, permissionPresets, sessionPermissionModes,
  type ResolveSessionRunPolicyInput } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { isRecord } from "../../shared/validation.js";
import { parseApprovalProfileObject } from "../../shared/approval-profile.js";

/** Requested constraints only. Not a grant, approval receipt, current policy or executable decision. */
export type UserInputSourcePolicyIntent = Pick<ResolveSessionRunPolicyInput,
  "authorizationMode" | "workspaceAccessMode" | "permissionPreset" | "permissionMode" | "approvalProfile">;

export function readUserInputSourcePolicyIntent(snapshot: Record<string, unknown>): UserInputSourcePolicyIntent {
  const result: Record<string, unknown> = {};
  for (const [key, choices] of [["authorizationMode", authorizationModes], ["workspaceAccessMode", workspaceAccessModes],
    ["permissionPreset", permissionPresets], ["permissionMode", sessionPermissionModes]] as const) {
    if (snapshot[key] === undefined) continue;
    if (typeof snapshot[key] !== "string" || !(choices as readonly string[]).includes(snapshot[key])) throw invalidPolicy();
    result[key] = snapshot[key];
  }
  if (snapshot.approvalProfile !== undefined) {
    if (!isRecord(snapshot.approvalProfile)) throw invalidPolicy();
    try {
      const parsed = parseApprovalProfileObject(snapshot.approvalProfile, "sourcePolicyIntent.approvalProfile");
      if (!isDeepStrictEqual(parsed, snapshot.approvalProfile)) throw invalidPolicy();
      result.approvalProfile = parsed;
    } catch { throw invalidPolicy(); }
  }
  return result;
}
function invalidPolicy(): HttpError { return new HttpError(409, "user_input_source_request_invalid", "The original permission intent is invalid; it cannot be replaced by default permissions."); }
