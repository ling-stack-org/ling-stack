import { randomUUID } from "node:crypto";
import type { RunTool } from "./approval-policy.js";

export const DEFAULT_WORKSPACE_ID = "workspace_default";

export type TaskStatus =
  | "todo"
  | "claimed"
  | "running"
  | "blocked"
  | "review"
  | "done"
  | "failed"
  | "cancelled";

export const taskStatuses: readonly TaskStatus[] = [
  "todo",
  "claimed",
  "running",
  "blocked",
  "review",
  "done",
  "failed",
  "cancelled",
];

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly defaultProviderPresetId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Channel {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly boundPath?: string;
  readonly defaultProviderPresetId?: string;
  readonly defaultTeammateId?: string;
  readonly allowedTools: readonly RunTool[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelInput {
  readonly name: string;
  readonly boundPath?: string;
  readonly defaultProviderPresetId?: string;
  readonly defaultTeammateId?: string;
  readonly allowedTools?: readonly RunTool[];
}

export interface ChannelUpdateInput {
  readonly name?: string;
  readonly boundPath?: string | null;
  readonly defaultProviderPresetId?: string | null;
  readonly defaultTeammateId?: string | null;
  readonly allowedTools?: readonly RunTool[];
}

export interface ListChannelsOptions {
  readonly limit?: number;
}

export interface Task {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly title: string;
  readonly prompt: string;
  readonly status: TaskStatus;
  readonly assigneeTeammateId?: string;
  readonly currentRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateTaskInput {
  readonly channelId: string;
  readonly title: string;
  readonly prompt: string;
  readonly status?: TaskStatus;
  readonly assigneeTeammateId?: string;
}

export interface TaskUpdateInput {
  readonly channelId?: string;
  readonly title?: string;
  readonly prompt?: string;
  readonly status?: TaskStatus;
  readonly assigneeTeammateId?: string | null;
  readonly currentRunId?: string | null;
}

export interface ListTasksOptions {
  readonly channelId?: string;
  readonly status?: TaskStatus;
  readonly limit?: number;
}

export function createChannelId(): string {
  return `channel_${randomUUID()}`;
}

export function createTaskId(): string {
  return `task_${randomUUID()}`;
}
