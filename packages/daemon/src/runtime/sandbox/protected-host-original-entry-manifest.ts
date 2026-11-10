import type { ProtectedHostActorEntry } from "./protected-host-actor-inventory.js";
import { MACOS_NATIVE_COMMAND_ACTOR_ENTRY } from "./macos-native-command.js";
import { UNIFIED_EXEC_RAW_ACTOR_ENTRY, UNIFIED_EXEC_FULL_ACCESS_ACTOR_ENTRY } from "../../features/runs/unified-exec-raw-source.js";
import { NATIVE_INPUT_CAPTURE_ACTOR_ENTRY } from "./native-input-capture.js";
import { MCP_HOST_STDIO_ACTOR_ENTRY } from "../../features/mcp/host-stdio-transport.js";
import { MCP_SDK_STDIO_ACTOR_ENTRY } from "../../features/mcp/stdio-launcher.js";
import { WORKSPACE_CHANGES_GIT_ACTOR_ENTRY } from "../../features/previews/workspace-changes.js";
import { MANAGED_WORKTREES_GIT_ACTOR_ENTRY } from "../../features/workspaces/managed-worktrees.js";
import { ACTION_CLASSIFIER_GIT_ACTOR_ENTRY } from "../../features/runs/action-classifier.js";
import { workspaceTerminalActorEntry } from "../../features/workspace-directory/terminal-runner.js";
import { workspaceDirectoryPickerActorEntry } from "../../features/workspace-directory/directory-picker.js";
import { CORE_EXTERNAL_WORK_SCHEDULER_ACTOR_ENTRY, CORE_OFFICIAL_SKILL_GIT_ACTOR_ENTRY } from "./core-original-process-bridge.js";
import { WORKSPACE_FILE_LAUNCH_ACTOR_ENTRY, WORKSPACE_FILE_PROBE_ACTOR_ENTRY } from "../../features/previews/workspace-file-actions.js";
import { LOCAL_PATH_OPEN_ACTOR_ENTRY } from "../../shared/local-path-open.js";
import { WORKSPACE_ICON_PROBE_ACTOR_ENTRY } from "../../features/previews/workspace-file-open-icons.js";
import { KEYCHAIN_SECURITY_ACTOR_ENTRY } from "../../features/providers/keychain-secret-store.js";
import { PACKAGED_CODESIGN_ACTOR_ENTRY } from "./packaged-restricted-command-bootstrap.js";
import { DOCKER_PROBE_ACTOR_ENTRY } from "./docker.js";
import { EXTERNAL_WORKFLOW_REQUEST_ACTOR_ENTRY } from "./external-workflow-request-source.js";

/**
 * Exact source-owned physical launch wrappers, never caller arrays, names,
 * flags or fixture producers. Capture only on first read: native command and
 * staging import one another through this module, so a top-level value read
 * could enter an uninitialized owner binding. Imports create no native work;
 * this immutable list neither clears launch history nor certifies isolation.
 */
let originalEntries: readonly ProtectedHostActorEntry[] | undefined;
export function readOriginalProtectedHostActorEntries(): readonly ProtectedHostActorEntry[] {
  return originalEntries ??= Object.freeze([
    MACOS_NATIVE_COMMAND_ACTOR_ENTRY,
    UNIFIED_EXEC_RAW_ACTOR_ENTRY,
    UNIFIED_EXEC_FULL_ACCESS_ACTOR_ENTRY,
    NATIVE_INPUT_CAPTURE_ACTOR_ENTRY,
    MCP_HOST_STDIO_ACTOR_ENTRY,
    MCP_SDK_STDIO_ACTOR_ENTRY,
    WORKSPACE_CHANGES_GIT_ACTOR_ENTRY,
    MANAGED_WORKTREES_GIT_ACTOR_ENTRY,
    ACTION_CLASSIFIER_GIT_ACTOR_ENTRY,
    workspaceTerminalActorEntry,
    workspaceDirectoryPickerActorEntry,
    CORE_EXTERNAL_WORK_SCHEDULER_ACTOR_ENTRY,
    CORE_OFFICIAL_SKILL_GIT_ACTOR_ENTRY,
    WORKSPACE_FILE_LAUNCH_ACTOR_ENTRY,
    LOCAL_PATH_OPEN_ACTOR_ENTRY,
    WORKSPACE_FILE_PROBE_ACTOR_ENTRY,
    WORKSPACE_ICON_PROBE_ACTOR_ENTRY,
    KEYCHAIN_SECURITY_ACTOR_ENTRY,
    PACKAGED_CODESIGN_ACTOR_ENTRY,
    DOCKER_PROBE_ACTOR_ENTRY,
    EXTERNAL_WORKFLOW_REQUEST_ACTOR_ENTRY,
  ]);
}
