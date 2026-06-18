import type { DatabaseSync } from "node:sqlite";

export interface SqliteStoreContext {
  readonly database: DatabaseSync;
}
