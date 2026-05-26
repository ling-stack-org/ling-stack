import type { TaskStatus, ToolName } from "../types.js";

export const defaultTools: readonly ToolName[] = ["read", "grep", "find", "ls"];
export const allTools: readonly ToolName[] = ["read", "grep", "find", "ls", "bash", "edit", "write"];
export const riskyTools: readonly ToolName[] = ["bash", "edit", "write"];
export const taskStatuses: readonly TaskStatus[] = ["todo", "claimed", "running", "blocked", "review", "done", "failed", "cancelled"];
