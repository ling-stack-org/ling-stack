import type { SQLOutputValue } from "node:sqlite";
import type { DelegationMessageV1, DelegationStepV1 } from "@ling-stack/contracts";
import {
  DELEGATION_LEGACY_READ_LIMIT,
  DELEGATION_QUERY_DEFAULT_LIMIT,
  DELEGATION_QUERY_MAX_LIMIT,
  DelegationReadError,
  type DelegationQueryCursorV1,
  type DelegationQueryPage,
  type DelegationQueryPageInput,
} from "../../harness/delegations.js";
import type { DelegationQueryStore } from "../../harness/store-ports.js";
import { delegationMessageSelectSql, delegationStepSelectSql, mapDelegationMessage, mapDelegationStep } from "./delegation-mappers.js";
import type { SqliteStoreContext } from "./store-context.js";

type Row = Record<string, SQLOutputValue>;
type QueryKind = DelegationQueryCursorV1["kind"];

/** Metadata-only SELECTs: no execution authority, artifact body reads, writes or child creation. */
export class SqliteDelegationStore implements DelegationQueryStore {
  constructor(private readonly context: SqliteStoreContext) {}

  getDelegationStep(id: string): DelegationStepV1 | undefined {
    const identity = queryId(id);
    const statement = this.context.database.prepare(delegationStepSelectSql("WHERE id = ?"));
    statement.setReadBigInts(true);
    const row = statement.get(identity);
    return row ? mapDelegationStep(row as Row) : undefined;
  }

  listDelegationChildren(parentDelegationStepId: string): readonly DelegationStepV1[] {
    return this.completeList("children", queryId(parentDelegationStepId), mapDelegationStep);
  }

  listDelegationMessages(delegationStepId: string): readonly DelegationMessageV1[] {
    return this.completeList("messages", queryId(delegationStepId), mapDelegationMessage);
  }

  queryDelegationChildren(parentDelegationStepId: string, input?: DelegationQueryPageInput): DelegationQueryPage<DelegationStepV1> {
    return this.page("children", queryId(parentDelegationStepId), input, mapDelegationStep);
  }

  queryDelegationMessages(delegationStepId: string, input?: DelegationQueryPageInput): DelegationQueryPage<DelegationMessageV1> {
    return this.page("messages", queryId(delegationStepId), input, mapDelegationMessage);
  }

  private completeList<T>(kind: QueryKind, scopeId: string, map: (row: Row) => T): readonly T[] {
    const rows = this.rows(kind, scopeId, DELEGATION_LEGACY_READ_LIMIT + 1);
    if (rows.length > DELEGATION_LEGACY_READ_LIMIT) {
      throw new DelegationReadError("read_limit_exceeded", "Delegation list exceeds 1000 rows; use the explicit page query");
    }
    return rows.map(map);
  }

  private page<T extends { readonly createdAt: string; readonly id: string }>(
    kind: QueryKind, scopeId: string, input: DelegationQueryPageInput | undefined, map: (row: Row) => T,
  ): DelegationQueryPage<T> {
    const { limit, after } = pageInput(kind, scopeId, input);
    const rows = this.rows(kind, scopeId, limit + 1, after);
    // Validate the probe row too; malformed metadata must not be silently filtered away.
    const mapped = rows.map(map);
    const hasMore = mapped.length > limit;
    const items = mapped.slice(0, limit);
    const last = items.at(-1);
    return {
      items, hasMore,
      ...(hasMore && last ? { nextCursor: { schemaVersion: 1 as const, kind, scopeId, createdAt: last.createdAt, id: last.id } } : {}),
    };
  }

  private rows(kind: QueryKind, scopeId: string, limit: number, after?: DelegationQueryCursorV1): Row[] {
    const scope = kind === "children" ? "parent_delegation_step_id" : "delegation_step_id";
    const select = kind === "children" ? delegationStepSelectSql : delegationMessageSelectSql;
    const clause = `WHERE ${scope} = ? ${after ? "AND (created_at COLLATE BINARY, id COLLATE BINARY) > (?, ?)" : ""}
      ORDER BY created_at COLLATE BINARY ASC, id COLLATE BINARY ASC LIMIT ?`;
    const parameters = after ? [scopeId, after.createdAt, after.id, limit] : [scopeId, limit];
    const statement = this.context.database.prepare(select(clause));
    statement.setReadBigInts(true);
    return statement.all(...parameters) as Row[];
  }
}

function invalidInput(): never {
  throw new DelegationReadError("invalid_read_input", "Invalid delegation read input");
}

function queryId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) invalidInput();
  return value;
}

/** Do not execute caller getters while capturing read options or cursor identity. */
function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) invalidInput();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalidInput();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string" || !allowed.includes(key)) invalidInput();
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) invalidInput();
      captured[key] = descriptor.value;
    }
    return captured;
  } catch {
    return invalidInput();
  }
}

function pageInput(kind: QueryKind, scopeId: string, input: DelegationQueryPageInput | undefined): {
  readonly limit: number; readonly after?: DelegationQueryCursorV1;
} {
  const options = input === undefined ? {} : fields(input, ["limit", "after"]);
  const limit = options.limit === undefined ? DELEGATION_QUERY_DEFAULT_LIMIT : options.limit;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > DELEGATION_QUERY_MAX_LIMIT) invalidInput();
  if (options.after === undefined) return { limit };
  const cursor = fields(options.after, ["schemaVersion", "kind", "scopeId", "createdAt", "id"]);
  if (cursor.schemaVersion !== 1 || cursor.kind !== kind || cursor.scopeId !== scopeId
    || typeof cursor.createdAt !== "string" || cursor.createdAt.length === 0 || cursor.createdAt.startsWith("\0")) invalidInput();
  const id = queryId(cursor.id);
  return { limit, after: { schemaVersion: 1, kind, scopeId, createdAt: cursor.createdAt, id } };
}
