import type { PermissionPreset, SessionPermissionMode } from "../types.js";

export type ConversationAuthorizationMode = "ask" | "smart" | "always";

export interface ConversationAuthorizationSelection {
  readonly permissionMode: SessionPermissionMode;
  readonly permissionPreset: PermissionPreset;
}

export const defaultConversationAuthorizationMode: ConversationAuthorizationMode = "smart";

export function authorizationModeToPermission(mode: ConversationAuthorizationMode): ConversationAuthorizationSelection {
  if (mode === "ask") {
    return {
      permissionMode: "ask_everything",
      permissionPreset: "read_only",
    };
  }
  if (mode === "always") {
    return {
      permissionMode: "full_access",
      permissionPreset: "full_access",
    };
  }
  return {
    permissionMode: "workspace_write",
    permissionPreset: "workspace_collaboration",
  };
}

export function permissionToAuthorizationMode(
  permissionMode: SessionPermissionMode | undefined,
  permissionPreset: PermissionPreset | undefined,
): ConversationAuthorizationMode {
  if (permissionPreset === "full_access" || permissionMode === "full_access") {
    return "always";
  }
  if (permissionPreset === "read_only" || permissionMode === "ask_everything") {
    return "ask";
  }
  return "smart";
}
