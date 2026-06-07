export type TaskStatus = "todo" | "claimed" | "running" | "blocked" | "review" | "done" | "failed" | "cancelled";

export interface Task {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly title: string;
  readonly prompt: string;
  readonly status: TaskStatus;
  readonly assigneeTeammateId?: string;
  readonly requestedSkillId?: string;
  readonly currentRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskListResponse {
  readonly cwd: string;
  readonly tasks: readonly Task[];
}

export interface TaskMutationResponse {
  readonly task: Task;
}

export interface CreateTaskRequest {
  readonly channelId: string;
  readonly title: string;
  readonly prompt: string;
  readonly assigneeTeammateId?: string;
  readonly requestedSkillId?: string;
}

export interface UpdateTaskRequest {
  readonly channelId?: string;
  readonly title?: string;
  readonly prompt?: string;
  readonly status?: TaskStatus;
  readonly assigneeTeammateId?: string | null;
  readonly requestedSkillId?: string | null;
}

export interface ListTasksRequest {
  readonly channelId?: string;
  readonly assigneeTeammateId?: string;
  readonly status?: TaskStatus;
  readonly limit?: number;
}
