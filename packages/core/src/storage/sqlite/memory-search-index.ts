import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { mapMemoryObject } from "./memory-mappers.js";
import { memoryObjectSelectSql } from "./select-sql.js";

export const MEMORY_SEARCH_INDEX_VERSION = 1;
const runtimeSupport = new WeakMap<DatabaseSync, boolean>();

function supportsMemorySearchIndex(database: DatabaseSync): boolean {
  const known = runtimeSupport.get(database);
  if (known !== undefined) return known;
  try {
    // A read-only capability check also handles an existing FTS table opened by a runtime without its module.
    database.prepare("SELECT fts5_source_id()").get();
    runtimeSupport.set(database, true);
    return true;
  } catch (error) {
    if (error instanceof Error && /no such (?:function: fts5_source_id|module: fts5)/i.test(error.message)) {
      runtimeSupport.set(database, false);
      return false;
    }
    throw error;
  }
}

/** The index only narrows candidates. SQLite ownership/health and lexical scoring remain authoritative. */
export function initializeMemorySearchIndex(database: DatabaseSync): void {
  const existed = database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memory_search_fts_v1'").get();
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_search_index_state (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_search_dirty (memory_id TEXT PRIMARY KEY, source_rowid INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS memory_search_insert AFTER INSERT ON memory_objects BEGIN
      INSERT OR REPLACE INTO memory_search_dirty VALUES (new.id, new.rowid);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_search_update AFTER UPDATE OF id, title, body, tags_json, source_refs_json ON memory_objects
    WHEN old.id IS NOT new.id OR old.title IS NOT new.title OR old.body IS NOT new.body
      OR old.tags_json IS NOT new.tags_json OR old.source_refs_json IS NOT new.source_refs_json BEGIN
      INSERT OR REPLACE INTO memory_search_dirty VALUES (new.id, new.rowid);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_search_delete AFTER DELETE ON memory_objects BEGIN
      INSERT OR REPLACE INTO memory_search_dirty VALUES (old.id, old.rowid);
    END;
  `);
  if (!supportsMemorySearchIndex(database)) return;
  try {
    database.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_search_fts_v1 USING fts5(tokens, tokenize = 'ascii')");
  } catch (error) {
    // A runtime without FTS5 must still open the source database. Never swallow IO/corruption failures.
    if (error instanceof Error && /no such module: fts5/i.test(error.message)) return;
    throw error;
  }
  const state = database.prepare("SELECT version FROM memory_search_index_state WHERE id = 1").get();
  if (!existed || state?.version !== MEMORY_SEARCH_INDEX_VERSION) rebuildMemorySearchIndex(database);
  else refreshMemorySearchIndex(database);
}

export function hasMemorySearchIndex(database: DatabaseSync): boolean {
  if (!supportsMemorySearchIndex(database)) return false;
  const row = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_search_fts_v1'").get();
  if (!row) return false;
  return database.prepare("SELECT version FROM memory_search_index_state WHERE id = 1").get()?.version === MEMORY_SEARCH_INDEX_VERSION;
}

export function rebuildMemorySearchIndex(database: DatabaseSync): void {
  database.exec("SAVEPOINT memory_search_rebuild");
  try {
    database.exec(`DELETE FROM memory_search_fts_v1;
      INSERT OR REPLACE INTO memory_search_dirty SELECT id, rowid FROM memory_objects;`);
    refreshMemorySearchIndex(database);
    database.prepare("INSERT OR REPLACE INTO memory_search_index_state VALUES (1, ?)").run(MEMORY_SEARCH_INDEX_VERSION);
    database.exec("RELEASE memory_search_rebuild");
  } catch (error) {
    database.exec("ROLLBACK TO memory_search_rebuild; RELEASE memory_search_rebuild");
    throw error;
  }
}

/** Runs on the writer, never on recall. Dirty IDs stay searchable if a writer uses raw SQL or stops mid-update. */
export function refreshMemorySearchIndex(database: DatabaseSync, memoryId?: string): void {
  if (!supportsMemorySearchIndex(database)) return;
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memory_search_fts_v1'").get()) return;
  database.exec("SAVEPOINT memory_search_refresh");
  try {
    const pending = database.prepare(`SELECT memory_id, source_rowid FROM memory_search_dirty${memoryId ? " WHERE memory_id = ?" : ""}`)
      .all(...(memoryId ? [memoryId] : []));
    const select = database.prepare(memoryObjectSelectSql("WHERE id = ?"));
    const remove = database.prepare("DELETE FROM memory_search_fts_v1 WHERE rowid = ?");
    const insert = database.prepare("INSERT INTO memory_search_fts_v1(rowid, tokens) VALUES (?, ?)");
    const clear = database.prepare("DELETE FROM memory_search_dirty WHERE memory_id = ?");
    for (const item of pending) {
      remove.run(item.source_rowid);
      const row = select.get(item.memory_id);
      if (row) {
        const memory = mapMemoryObject(row as Record<string, SQLOutputValue>);
        const text = [memory.id, memory.title, memory.body, ...memory.tags,
          ...memory.sourceRefs.flatMap(ref => [ref.type, ref.id, ref.label ?? "", ref.url ?? ""])].join(" ");
        insert.run(item.source_rowid, memorySearchGrams(text).join(" "));
      }
      clear.run(item.memory_id);
    }
    database.exec("RELEASE memory_search_refresh");
  } catch (error) {
    database.exec("ROLLBACK TO memory_search_refresh; RELEASE memory_search_refresh");
    throw error;
  }
}

/** Encoded Unicode bigrams preserve Chinese and arbitrary identifier substrings without MATCH syntax injection. */
function memorySearchGrams(text: string, limit = Infinity): string[] {
  const chars = Array.from(text.toLowerCase());
  const grams = new Set<string>();
  for (let index = 0; index + 1 < chars.length && grams.size < limit; index++) {
    grams.add(`g${Buffer.from(chars[index]! + chars[index + 1]!, "utf8").toString("hex")}`);
  }
  return [...grams];
}

export function memorySearchMatch(terms: readonly string[]): string | undefined {
  const expressions = terms.map(term => memorySearchGrams(term, 8)).filter(grams => grams.length > 0)
    .map(grams => `(${grams.map(gram => `"${gram}"`).join(" AND ")})`);
  return expressions.length ? expressions.join(" OR ") : undefined;
}

export function writeMemoryWithSearchIndex<T extends { readonly id: string } | undefined>(
  database: DatabaseSync, write: () => T,
): T {
  database.exec("SAVEPOINT memory_search_write");
  try {
    const result = write();
    if (result) refreshMemorySearchIndex(database, result.id);
    database.exec("RELEASE memory_search_write");
    return result;
  } catch (error) {
    database.exec("ROLLBACK TO memory_search_write; RELEASE memory_search_write");
    throw error;
  }
}
