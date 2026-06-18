import {
  createDefaultApprovalPolicy,
  type ApprovalPolicy,
  type ApprovalPolicyUpdateInput,
} from "../../approval-policy.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { stringifyJson } from "./helpers.js";
import { mapApprovalPolicy } from "./approval-media-mappers.js";
import { approvalPolicySelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export class SqliteApprovalPolicyStore {
  private readonly context: SqliteStoreContext;

  constructor(context: SqliteStoreContext) {
    this.context = context;
  }

  ensureDefaultApprovalPolicy(): void {
    const now = new Date().toISOString();
    const policy = createDefaultApprovalPolicy(DEFAULT_WORKSPACE_ID, now);
    this.context.database
      .prepare(`
        INSERT INTO approval_policies (
          workspace_id,
          tool_decisions_json,
          allowed_write_paths_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO NOTHING
      `)
      .run(
        policy.workspaceId,
        stringifyJson(policy.toolDecisions),
        stringifyJson(policy.allowedWritePaths),
        policy.createdAt,
        policy.updatedAt,
      );
  }

  getApprovalPolicy(): ApprovalPolicy {
    const row = this.context.database.prepare(approvalPolicySelectSql("WHERE workspace_id = ?")).get(DEFAULT_WORKSPACE_ID);
    if (row) {
      return mapApprovalPolicy(row);
    }
    this.ensureDefaultApprovalPolicy();
    const created = this.context.database.prepare(approvalPolicySelectSql("WHERE workspace_id = ?")).get(DEFAULT_WORKSPACE_ID);
    if (!created) {
      throw new Error(`Approval policy not found: ${DEFAULT_WORKSPACE_ID}`);
    }
    return mapApprovalPolicy(created);
  }

  updateApprovalPolicy(input: ApprovalPolicyUpdateInput, now: string): ApprovalPolicy {
    const existing = this.getApprovalPolicy();
    const next: ApprovalPolicy = {
      ...existing,
      toolDecisions: {
        ...existing.toolDecisions,
        ...(input.toolDecisions ?? {}),
      },
      allowedWritePaths: input.allowedWritePaths ?? existing.allowedWritePaths,
      updatedAt: now,
    };

    this.context.database
      .prepare(`
        UPDATE approval_policies
        SET
          tool_decisions_json = ?,
          allowed_write_paths_json = ?,
          updated_at = ?
        WHERE workspace_id = ?
      `)
      .run(
        stringifyJson(next.toolDecisions),
        stringifyJson(next.allowedWritePaths),
        next.updatedAt,
        next.workspaceId,
      );

    return this.getApprovalPolicy();
  }
}
