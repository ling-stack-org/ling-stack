import type {
  CreateTaskRequest,
  ListTasksRequest,
  TaskListResponse,
  TaskMutationResponse,
  UpdateTaskRequest,
} from "@ling-stack/contracts";
import type { LingDaemonEndpointContext, PublicEndpointGroup } from "../transport.js";

export const taskEndpoints = {
  async listTasks(this: LingDaemonEndpointContext, cwd: string, options: ListTasksRequest = {}): Promise<TaskListResponse> {
      return this._get("/tasks", { cwd, channelId: options.channelId, status: options.status, limit: options.limit });
    },

  async createTask(this: LingDaemonEndpointContext, cwd: string, input: CreateTaskRequest): Promise<TaskMutationResponse> {
      return this._post("/tasks", { cwd }, input);
    },

  async updateTask(this: LingDaemonEndpointContext, cwd: string, taskId: string, input: UpdateTaskRequest): Promise<TaskMutationResponse> {
      return this._patch(`/tasks/${encodeURIComponent(taskId)}`, { cwd }, input);
    },

  async deleteTask(this: LingDaemonEndpointContext, cwd: string, taskId: string): Promise<void> {
      await this._request("DELETE", `/tasks/${encodeURIComponent(taskId)}`, { cwd });
    },
};

export type TaskEndpoints = PublicEndpointGroup<typeof taskEndpoints>;