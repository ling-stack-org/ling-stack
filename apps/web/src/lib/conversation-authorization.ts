import {
  authorizationAndAccessFromLegacyPermission,
  legacyPermissionFromAuthorizationAndAccess,
} from "@ling-stack/core/session-permissions";
import type { AuthorizationMode, PermissionPreset, SessionPermissionMode, WorkspaceAccessMode } from "../types.js";

export type ConversationAuthorizationMode = AuthorizationMode;

export interface ConversationAuthorizationSelection {
  readonly permissionMode: SessionPermissionMode;
  readonly permissionPreset: PermissionPreset;
}

export const defaultConversationAuthorizationMode: ConversationAuthorizationMode = "smart";

export function authorizationModeToPermission(mode: ConversationAuthorizationMode): ConversationAuthorizationSelection {
  return legacyPermissionFromAuthorizationAndAccess(
    mode,
    mode === "ask" ? "read_only" : mode === "always" ? "full_access" : "workspace_write",
  );
}

export function permissionToAuthorizationMode(
  permissionMode: SessionPermissionMode | undefined,
  permissionPreset: PermissionPreset | undefined,
): ConversationAuthorizationMode {
  return authorizationAndAccessFromLegacyPermission(permissionMode, permissionPreset).authorizationMode;
}

export function resolveAuthorizationMode(
  authorizationMode: AuthorizationMode | undefined,
  permissionMode: SessionPermissionMode | undefined,
  permissionPreset: PermissionPreset | undefined,
): AuthorizationMode {
  return authorizationMode ?? authorizationAndAccessFromLegacyPermission(permissionMode, permissionPreset).authorizationMode;
}

export function resolveWorkspaceAccessMode(
  workspaceAccessMode: WorkspaceAccessMode | undefined,
  permissionMode: SessionPermissionMode | undefined,
  permissionPreset: PermissionPreset | undefined,
): WorkspaceAccessMode {
  return workspaceAccessMode ?? authorizationAndAccessFromLegacyPermission(permissionMode, permissionPreset).workspaceAccessMode;
}

export function authorizationAndAccessToLegacyPermission(
  authorizationMode: AuthorizationMode,
  workspaceAccessMode: WorkspaceAccessMode,
): ConversationAuthorizationSelection {
  return legacyPermissionFromAuthorizationAndAccess(authorizationMode, workspaceAccessMode);
}
