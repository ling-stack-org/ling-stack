import {
  type AppendControlPlaneEventInput,
  type ControlPlaneEvent,
  type ListControlPlaneEventsOptions,
} from "../../run-types.js";
import { redactSecrets } from "../../redaction.js";
import { readNumber, stringifyJson } from "./helpers.js";
import { mapControlPlaneEvent } from "./control-plane-mappers.js";
import { controlPlaneEventSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export class SqliteControlPlaneStore {
  private readonly context: SqliteStoreContext;

  constructor(context: SqliteStoreContext) {
    this.context = context;
  }

  appendControlPlaneEvent(input: AppendControlPlaneEventInput, now: string): ControlPlaneEvent {
    const redactedData = redactSecrets(input.data ?? {}) as Record<string, unknown>;
    this.context.database
      .prepare(`
        INSERT INTO control_plane_events (
          workspace_id,
          cwd,
          ts,
          domain,
          entity_type,
          entity_id,
          action,
          data_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.workspaceId,
        input.cwd,
        now,
        input.domain,
        input.entityType,
        input.entityId,
        input.action,
        stringifyJson(redactedData),
      );
    const seq = readNumber(this.context.database.prepare("SELECT last_insert_rowid() AS seq").get(), "seq");
    const event = this.getControlPlaneEvent(seq);
    if (!event) {
      throw new Error(`Failed to append control-plane event: ${seq}`);
    }
    return event;
  }

  listControlPlaneEvents(options: ListControlPlaneEventsOptions): ControlPlaneEvent[] {
    const clauses = ["workspace_id = ?", "seq > ?"];
    const params: (string | number)[] = [options.workspaceId, Math.max(options.afterSeq ?? 0, 0)];
    if (options.domains && options.domains.length > 0) {
      clauses.push(`domain IN (${options.domains.map(() => "?").join(", ")})`);
      params.push(...options.domains);
    }
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
    params.push(limit);
    return this.context.database
      .prepare(`${controlPlaneEventSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY seq ASC LIMIT ?`)
      .all(...params)
      .map(mapControlPlaneEvent);
  }

  getLatestControlPlaneEventSeq(workspaceId: string): number {
    const row = this.context.database
      .prepare("SELECT COALESCE(MAX(seq), 0) AS latest_seq FROM control_plane_events WHERE workspace_id = ?")
      .get(workspaceId);
    return readNumber(row, "latest_seq");
  }

  private getControlPlaneEvent(seq: number): ControlPlaneEvent | undefined {
    const row = this.context.database.prepare(controlPlaneEventSelectSql("WHERE seq = ?")).get(seq);
    return row ? mapControlPlaneEvent(row) : undefined;
  }
}
