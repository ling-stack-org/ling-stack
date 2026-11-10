import type { SqliteRunStoreMigrationContext } from './migrations.js';
export function applyMemoryDerivativeMigration(context: SqliteRunStoreMigrationContext): void {
 if (context.hasMigration(187)) return;
 const db=context.database;
 // An outer UPSERT may override INSERT OR REPLACE inside a trigger. Delete/insert
 // coalesces transactionally while always advancing the AUTOINCREMENT cursor.
 db.exec('SAVEPOINT memory_derivative_migration');
 try {
 db.exec(`
 CREATE TABLE IF NOT EXISTS memory_semantic_policy (id INTEGER PRIMARY KEY CHECK(id=1), record_json TEXT NOT NULL CHECK(json_valid(record_json)));
 CREATE TABLE IF NOT EXISTS memory_semantic_generation (id INTEGER PRIMARY KEY CHECK(id=1), record_json TEXT NOT NULL CHECK(json_valid(record_json)));
 CREATE TABLE IF NOT EXISTS memory_derivative_revisions (memory_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, content_updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS memory_derivative_outbox (sequence INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL UNIQUE);
 CREATE INDEX IF NOT EXISTS memory_derivative_outbox_source ON memory_derivative_outbox(memory_id,sequence);
 INSERT INTO memory_derivative_revisions SELECT id,1,updated_at FROM memory_objects;
 INSERT OR REPLACE INTO memory_derivative_outbox(memory_id) SELECT id FROM memory_objects;
 CREATE TRIGGER IF NOT EXISTS memory_derivative_insert AFTER INSERT ON memory_objects BEGIN
  INSERT INTO memory_derivative_revisions VALUES(new.id,1,new.updated_at) ON CONFLICT(memory_id) DO UPDATE SET revision=revision+1,content_updated_at=new.updated_at;
  DELETE FROM memory_derivative_outbox WHERE memory_id=new.id;
  INSERT INTO memory_derivative_outbox(memory_id) VALUES(new.id);
 END;
 CREATE TRIGGER IF NOT EXISTS memory_derivative_update AFTER UPDATE ON memory_objects
 WHEN old.workspace_id IS NOT new.workspace_id OR old.scope_type IS NOT new.scope_type OR old.owner_id IS NOT new.owner_id
  OR old.title IS NOT new.title OR old.body IS NOT new.body OR old.tags_json IS NOT new.tags_json
  OR old.source_refs_json IS NOT new.source_refs_json OR old.review_state IS NOT new.review_state OR old.enabled IS NOT new.enabled
  OR old.sensitivity IS NOT new.sensitivity OR old.verify_before_use IS NOT new.verify_before_use BEGIN
  UPDATE memory_derivative_revisions SET revision=revision+1,content_updated_at=new.updated_at WHERE memory_id=new.id;
  DELETE FROM memory_derivative_outbox WHERE memory_id=new.id;
  INSERT INTO memory_derivative_outbox(memory_id) VALUES(new.id);
 END;
 CREATE TRIGGER IF NOT EXISTS memory_derivative_delete AFTER DELETE ON memory_objects BEGIN
  UPDATE memory_derivative_revisions SET revision=revision+1 WHERE memory_id=old.id;
  DELETE FROM memory_derivative_outbox WHERE memory_id=old.id;
  INSERT INTO memory_derivative_outbox(memory_id) VALUES(old.id);
 END;
 CREATE TRIGGER IF NOT EXISTS memory_derivative_health_insert AFTER INSERT ON memory_self_improving_metadata BEGIN
  UPDATE memory_derivative_revisions SET revision=revision+1,content_updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE memory_id=new.memory_id;
  DELETE FROM memory_derivative_outbox WHERE memory_id=new.memory_id;
  INSERT INTO memory_derivative_outbox(memory_id) VALUES(new.memory_id);
 END;
 CREATE TRIGGER IF NOT EXISTS memory_derivative_health_update AFTER UPDATE ON memory_self_improving_metadata
 WHEN old.valid_until IS NOT new.valid_until OR old.superseded_by IS NOT new.superseded_by BEGIN
  UPDATE memory_derivative_revisions SET revision=revision+1,content_updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE memory_id=new.memory_id;
  DELETE FROM memory_derivative_outbox WHERE memory_id=new.memory_id;
  INSERT INTO memory_derivative_outbox(memory_id) VALUES(new.memory_id);
 END;
 CREATE TRIGGER IF NOT EXISTS memory_derivative_health_delete AFTER DELETE ON memory_self_improving_metadata BEGIN
  UPDATE memory_derivative_revisions SET revision=revision+1,content_updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE memory_id=old.memory_id;
  DELETE FROM memory_derivative_outbox WHERE memory_id=old.memory_id;
  INSERT INTO memory_derivative_outbox(memory_id) VALUES(old.memory_id);
 END;
 `);
 context.recordMigration(187,'optional_memory_derivative_outbox_and_generation');
 db.exec('RELEASE memory_derivative_migration');
 } catch(error) { db.exec('ROLLBACK TO memory_derivative_migration; RELEASE memory_derivative_migration'); throw error; }
}
