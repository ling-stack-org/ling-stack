import type { ServerResponse } from "node:http";
import type { ConversationExecutionSelectionQuery } from "@ling-stack/contracts";
import { isAuthorizationMode, isWorkspaceAccessMode, permissionPresets, sessionPermissionModes } from "@ling-stack/core";
import type { NativeRunDispatcher } from "../features/runs/native-run-dispatcher.js";
import { writeJson } from "../shared/response.js";

export async function handleConversationExecutionSelection(response: ServerResponse, url: URL, dispatcher: NativeRunDispatcher | undefined): Promise<void> {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) { writeJson(response, 400, { error: "bad_request", message: "cwd is required" }); return; }
  if (!dispatcher?.inspectConversationSelection) {
    writeJson(response, 200, { cwd, status: "blocked", defaultRunnerId: "pi", reason: "native_execution_unavailable" }); return;
  }
  try {
    const values = Object.fromEntries(["threadId", "projectPath", "authorizationMode", "workspaceAccessMode", "permissionPreset", "permissionMode"]
      .flatMap(key => url.searchParams.get(key) ? [[key, url.searchParams.get(key)!]] : []));
    if (values.authorizationMode && !isAuthorizationMode(values.authorizationMode)
      || values.workspaceAccessMode && !isWorkspaceAccessMode(values.workspaceAccessMode)
      || values.permissionPreset && !permissionPresets.some(mode => mode === values.permissionPreset)
      || values.permissionMode && !sessionPermissionModes.some(mode => mode === values.permissionMode)) throw new Error("Invalid conversation permissions");
    writeJson(response, 200, await dispatcher.inspectConversationSelection(cwd, values as ConversationExecutionSelectionQuery));
  } catch { writeJson(response, 400, { error: "bad_request", message: "Could not inspect conversation execution." }); }
}
