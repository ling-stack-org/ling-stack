import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

import type {
  LingServerInstallationV1,
  LingServerCommandReceiptV1,
  LingServerPeerFrameV1,
  LingServerPeerBindingV1,
  LingServerPeerSessionV1,
  LingServerPairingMigrationPublicationV1,
  LingServerPairingMigrationV1,
  LingServerRouteAttemptV1,
} from "@ling-stack/contracts";

export interface LingServerStoreOptions {
  readonly databasePath?: string;
}

export class SqliteLingServerStore {
  readonly database: DatabaseSync;

  constructor(options: LingServerStoreOptions = {}) {
    const path = options.databasePath ?? ":memory:";
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS ling_server_installations (
        installation_id TEXT PRIMARY KEY NOT NULL,
        revision INTEGER NOT NULL,
        installation_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ling_server_bindings (
        binding_id TEXT PRIMARY KEY NOT NULL,
        installation_id TEXT NOT NULL,
        gateway_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        binding_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ling_server_bindings_gateway ON ling_server_bindings(gateway_id,revision);
      CREATE TABLE IF NOT EXISTS ling_server_routes (
        route_attempt_id TEXT PRIMARY KEY NOT NULL,
        binding_id TEXT NOT NULL,
        route_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ling_server_peer_sessions (
        session_id TEXT PRIMARY KEY NOT NULL,
        binding_id TEXT NOT NULL,
        transport_generation INTEGER NOT NULL,
        session_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ling_server_peer_frames (
        frame_id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        frame_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ling_server_peer_frame_lane ON ling_server_peer_frames (
        session_id, json_extract(frame_json,'$.transportGeneration'), json_extract(frame_json,'$.direction'), sequence
      );
      CREATE TABLE IF NOT EXISTS ling_server_command_receipts (
        command_id TEXT PRIMARY KEY NOT NULL,
        payload_digest TEXT NOT NULL,
        receipt_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ling_server_pairing_migrations (
        migration_id TEXT PRIMARY KEY NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','confirmed')),
        migration_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ling_server_pairing_publications (
        migration_id TEXT PRIMARY KEY NOT NULL,
        binding_id TEXT NOT NULL UNIQUE REFERENCES ling_server_bindings(binding_id),
        publication_json TEXT NOT NULL
      );
    `);
  }

  withWriteTransaction<T>(write: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = write();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getInstallation(installationId: string): LingServerInstallationV1 | undefined {
    const row = this.database.prepare("SELECT installation_json FROM ling_server_installations WHERE installation_id=?").get(installationId) as Row | undefined;
    return row ? parseJson<LingServerInstallationV1>(row.installation_json, "Ling Server installation") : undefined;
  }

  saveInstallation(installation: LingServerInstallationV1): void {
    this.database.prepare("INSERT INTO ling_server_installations(installation_id,revision,installation_json) VALUES(?,?,?) ON CONFLICT(installation_id) DO UPDATE SET revision=excluded.revision,installation_json=excluded.installation_json")
      .run(installation.installationId, installation.revision, JSON.stringify(installation));
  }

  getBinding(bindingId: string): LingServerPeerBindingV1 | undefined {
    const row = this.database.prepare("SELECT binding_json FROM ling_server_bindings WHERE binding_id=?").get(bindingId) as Row | undefined;
    return row ? parseJson<LingServerPeerBindingV1>(row.binding_json, "Ling Server peer binding") : undefined;
  }

  listBindings(): readonly LingServerPeerBindingV1[] {
    return (this.database.prepare("SELECT binding_json FROM ling_server_bindings ORDER BY binding_id").all() as Row[])
      .map(row => parseJson<LingServerPeerBindingV1>(row.binding_json, "Ling Server peer binding"));
  }

  saveBinding(binding: LingServerPeerBindingV1): void {
    this.database.prepare("INSERT INTO ling_server_bindings(binding_id,installation_id,gateway_id,revision,binding_json) VALUES(?,?,?,?,?) ON CONFLICT(binding_id) DO UPDATE SET installation_id=excluded.installation_id,gateway_id=excluded.gateway_id,revision=excluded.revision,binding_json=excluded.binding_json")
      .run(binding.bindingId, binding.installationId, binding.gatewayId, binding.revision, JSON.stringify(binding));
  }

  getRoute(routeAttemptId: string): LingServerRouteAttemptV1 | undefined {
    const row = this.database.prepare("SELECT route_json FROM ling_server_routes WHERE route_attempt_id=?").get(routeAttemptId) as Row | undefined;
    return row ? parseJson<LingServerRouteAttemptV1>(row.route_json, "Ling Server route") : undefined;
  }

  saveRoute(route: LingServerRouteAttemptV1): void {
    this.database.prepare("INSERT INTO ling_server_routes(route_attempt_id,binding_id,route_json) VALUES(?,?,?) ON CONFLICT(route_attempt_id) DO UPDATE SET binding_id=excluded.binding_id,route_json=excluded.route_json")
      .run(route.routeAttemptId, route.bindingId, JSON.stringify(route));
  }

  getSession(sessionId: string): LingServerPeerSessionV1 | undefined {
    const row = this.database.prepare("SELECT session_json FROM ling_server_peer_sessions WHERE session_id=?").get(sessionId) as Row | undefined;
    return row ? parseJson<LingServerPeerSessionV1>(row.session_json, "Ling Server peer session") : undefined;
  }

  saveSession(session: LingServerPeerSessionV1): void {
    this.database.prepare("INSERT INTO ling_server_peer_sessions(session_id,binding_id,transport_generation,session_json) VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET binding_id=excluded.binding_id,transport_generation=excluded.transport_generation,session_json=excluded.session_json")
      .run(session.sessionId, session.bindingId, session.transportGeneration, JSON.stringify(session));
  }

  getFrame(frameId: string): LingServerPeerFrameV1 | undefined {
    const row = this.database.prepare("SELECT frame_json FROM ling_server_peer_frames WHERE frame_id=?").get(frameId) as Row | undefined;
    return row ? parseJson<LingServerPeerFrameV1>(row.frame_json, "Ling Server peer frame") : undefined;
  }

  saveFrame(frame: LingServerPeerFrameV1): void {
    this.database.prepare("INSERT INTO ling_server_peer_frames(frame_id,session_id,sequence,frame_json) VALUES(?,?,?,?) ON CONFLICT(frame_id) DO NOTHING")
      .run(frame.frameId, frame.sessionId, frame.sequence, JSON.stringify(frame));
  }

  listFrames(
    sessionId: string, transportGeneration: number, direction: LingServerPeerFrameV1["direction"], afterSequence: number, limit = 100,
  ): readonly LingServerPeerFrameV1[] {
    return (this.database.prepare(`
      SELECT frame_json FROM ling_server_peer_frames
      WHERE session_id=? AND json_extract(frame_json,'$.transportGeneration')=?
        AND json_extract(frame_json,'$.direction')=? AND sequence>?
      ORDER BY sequence LIMIT ?
    `).all(sessionId, transportGeneration, direction, afterSequence, limit) as Row[])
      .map(row => parseJson<LingServerPeerFrameV1>(row.frame_json, "Ling Server peer frame"));
  }

  getReceipt(commandId: string): LingServerCommandReceiptV1 | undefined {
    const row = this.database.prepare("SELECT receipt_json FROM ling_server_command_receipts WHERE command_id=?").get(commandId) as Row | undefined;
    return row ? parseJson<LingServerCommandReceiptV1>(row.receipt_json, "Ling Server command receipt") : undefined;
  }

  saveReceipt(receipt: LingServerCommandReceiptV1): void {
    this.database.prepare("INSERT INTO ling_server_command_receipts(command_id,payload_digest,receipt_json) VALUES(?,?,?) ON CONFLICT(command_id) DO NOTHING")
      .run(receipt.commandId, receipt.payloadDigest, JSON.stringify(receipt));
  }

  getPairingMigration(migrationId: string): LingServerPairingMigrationV1 | undefined {
    const row = this.database.prepare("SELECT migration_json FROM ling_server_pairing_migrations WHERE migration_id=?").get(migrationId) as Row | undefined;
    return row ? parseJson<LingServerPairingMigrationV1>(row.migration_json, "Ling Server pairing migration") : undefined;
  }

  savePairingMigration(migration: LingServerPairingMigrationV1): void {
    const json = JSON.stringify(migration);
    if (migration.status === "pending") {
      this.database.prepare("INSERT INTO ling_server_pairing_migrations(migration_id,status,migration_json) VALUES(?,'pending',?)")
        .run(migration.migrationId, json);
    } else {
      const { changes } = this.database.prepare("UPDATE ling_server_pairing_migrations SET status='confirmed',migration_json=? WHERE migration_id=? AND status='pending'")
        .run(json, migration.migrationId);
      if (changes !== 1) throw new Error("Pairing migration confirmation did not match a pending record");
    }
  }

  getPairingPublication(migrationId: string): LingServerPairingMigrationPublicationV1 | undefined {
    const row = this.database.prepare("SELECT publication_json FROM ling_server_pairing_publications WHERE migration_id=?").get(migrationId) as Row | undefined;
    return row ? parseJson<LingServerPairingMigrationPublicationV1>(row.publication_json, "Ling Server pairing publication") : undefined;
  }

  savePairingPublication(publication: LingServerPairingMigrationPublicationV1): void {
    this.database.prepare("INSERT INTO ling_server_pairing_publications(migration_id,binding_id,publication_json) VALUES(?,?,?)")
      .run(publication.confirmation.migrationId, publication.binding.bindingId, JSON.stringify(publication));
  }

  close(): void { this.database.close(); }
}

type Row = Record<string, SQLOutputValue>;

function parseJson<T>(raw: SQLOutputValue, label: string): T {
  if (typeof raw !== "string") throw new Error(`Stored ${label} is not JSON`);
  return JSON.parse(raw) as T;
}
