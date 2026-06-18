import {
  createStateTransitionEventId,
  type CreateStateTransitionEventInput,
  type ListStateTransitionEventsOptions,
  type StateTransitionEvent,
} from "../../channel-runtime-types.js";
import { mapStateTransitionEvent } from "./runtime-work-mappers.js";
import { stateTransitionSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export class SqliteStateTransitionStore {
  private readonly context: SqliteStoreContext;

  constructor(context: SqliteStoreContext) {
    this.context = context;
  }

  listStateTransitionEvents(options: ListStateTransitionEventsOptions = {}): StateTransitionEvent[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.entityType) {
      clauses.push("entity_type = ?");
      params.push(options.entityType);
    }
    if (options.entityId) {
      clauses.push("entity_id = ?");
      params.push(options.entityId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.context.database
      .prepare(`${stateTransitionSelectSql(whereClause)} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapStateTransitionEvent);
  }

  recordStateTransitionEvent(input: CreateStateTransitionEventInput): StateTransitionEvent {
    const event: StateTransitionEvent = {
      id: createStateTransitionEventId(),
      workspaceId: input.workspaceId,
      entityType: input.entityType,
      entityId: input.entityId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.createdAt,
    };
    this.context.database
      .prepare(`
        INSERT INTO state_transition_events (
          id,
          workspace_id,
          entity_type,
          entity_id,
          from_status,
          to_status,
          event,
          actor,
          reason,
          idempotency_key,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.id,
        event.workspaceId,
        event.entityType,
        event.entityId,
        event.fromStatus,
        event.toStatus,
        event.event,
        event.actor,
        event.reason ?? null,
        event.idempotencyKey ?? null,
        event.createdAt,
      );
    return event;
  }

  findStateTransitionByIdempotency(
    entityType: StateTransitionEvent["entityType"],
    entityId: string,
    idempotencyKey: string,
  ): StateTransitionEvent | undefined {
    const row = this.context.database
      .prepare(stateTransitionSelectSql("WHERE entity_type = ? AND entity_id = ? AND idempotency_key = ?"))
      .get(entityType, entityId, idempotencyKey);
    return row ? mapStateTransitionEvent(row) : undefined;
  }
}
