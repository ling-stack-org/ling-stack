import type { SQLOutputValue } from "node:sqlite";
import {
  DEFAULT_WORKSPACE_ID,
  createTaskId,
  type CreateTaskInput,
  type ListTasksOptions,
  type Task,
  type TaskUpdateInput,
} from "../../workspace-types.js";
import { nullableUpdate } from "./helpers.js";
import { taskSelectSql } from "./select-sql.js";
import { mapTask } from "./task-skill-mappers.js";
import type { SqliteStoreContext } from "./store-context.js";

export class SqliteTaskStore {
  constructor(private readonly context: SqliteStoreContext) {}

  createTask(input: CreateTaskInput, now: string): Task {
    const task: Task = {
      id: createTaskId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      title: input.title,
      prompt: input.prompt,
      status: input.status ?? "todo",
      assigneeTeammateId: input.assigneeTeammateId,
      requestedSkillId: input.requestedSkillId,
      createdAt: now,
      updatedAt: now,
    };

    this.context.database
      .prepare(`
        INSERT INTO tasks (
          id,
          workspace_id,
          channel_id,
          title,
          prompt,
          status,
          assignee_teammate_id,
          requested_skill_id,
          current_run_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        task.id,
        task.workspaceId,
        task.channelId,
        task.title,
        task.prompt,
        task.status,
        task.assigneeTeammateId ?? null,
        task.requestedSkillId ?? null,
        task.currentRunId ?? null,
        task.createdAt,
        task.updatedAt,
      );

    const created = this.getTask(task.id);
    if (!created) {
      throw new Error(`Failed to create task: ${task.id}`);
    }
    return created;
  }

  getTask(id: string): Task | undefined {
    const row = this.context.database.prepare(taskSelectSql("WHERE id = ?")).get(id);
    return row ? mapTask(row as Record<string, SQLOutputValue>) : undefined;
  }

  listTasks(options: ListTasksOptions = {}): Task[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.assigneeTeammateId) {
      clauses.push("assignee_teammate_id = ?");
      params.push(options.assigneeTeammateId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${taskSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC LIMIT ?`)
      .all(...params)
      .map(mapTask);
  }

  updateTask(id: string, input: TaskUpdateInput, now: string): Task | undefined {
    const existing = this.getTask(id);
    if (!existing) {
      return undefined;
    }

    const next: Task = {
      ...existing,
      channelId: input.channelId ?? existing.channelId,
      title: input.title ?? existing.title,
      prompt: input.prompt ?? existing.prompt,
      status: input.status ?? existing.status,
      assigneeTeammateId: nullableUpdate(input.assigneeTeammateId, existing.assigneeTeammateId),
      requestedSkillId: nullableUpdate(input.requestedSkillId, existing.requestedSkillId),
      currentRunId: nullableUpdate(input.currentRunId, existing.currentRunId),
      updatedAt: now,
    };

    this.context.database
      .prepare(`
        UPDATE tasks
        SET
          channel_id = ?,
          title = ?,
          prompt = ?,
          status = ?,
          assignee_teammate_id = ?,
          requested_skill_id = ?,
          current_run_id = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.channelId,
        next.title,
        next.prompt,
        next.status,
        next.assigneeTeammateId ?? null,
        next.requestedSkillId ?? null,
        next.currentRunId ?? null,
        next.updatedAt,
        id,
      );

    return this.getTask(id);
  }

  deleteTask(id: string): boolean {
    const result = this.context.database.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }
}
