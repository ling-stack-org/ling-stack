export type TaskStatus =
  | "todo"
  | "claimed"
  | "running"
  | "blocked"
  | "review"
  | "done"
  | "failed"
  | "cancelled";

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
}

export interface Channel {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly boundPath?: string;
}

export interface Task {
  readonly id: string;
  readonly channelId: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly assigneeId?: string;
}
