import type { DatabaseSync } from "node:sqlite";
import type { ProviderCheckResult } from "../../provider-types.js";
import type {
  ProviderCheckAdmission, ProviderCheckAuthority, ProviderCheckPublicationResult,
  ProviderCheckRequestTicket, ProviderCheckSource,
} from "../../provider-check-publication-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import type { SqliteProviderStore } from "./provider-store.js";
import type { SqliteControlPlaneStore } from "./control-plane-store.js";
import { readNumber, rollbackOwnedSqliteTransaction, stringifyJson } from "./helpers.js";

/** Synchronous admission/publication only; no network, secrets or notifications in a transaction. */
export class SqliteProviderCheckPublicationStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly providers: SqliteProviderStore,
    private readonly events: SqliteControlPlaneStore,
  ) {}

  getProviderCheckAuthority(providerId: string): ProviderCheckAuthority | undefined {
    if (!this.providers.getProviderPreset(providerId)) return undefined;
    const statement = this.database.prepare(`SELECT config_revision, request_revision, published_revision
      FROM provider_check_authorities WHERE provider_id=?`);
    statement.setReadBigInts(true);
    const row = statement.get(providerId);
    if (!row) throw new Error("Provider check authority is missing.");
    const authority = {
      configRevision: readNumber(row, "config_revision"),
      requestRevision: readNumber(row, "request_revision"),
      publishedRevision: readNumber(row, "published_revision"),
    };
    if (Object.values(authority).some(value => !Number.isSafeInteger(value) || value < 0)
      || authority.configRevision < 1 || authority.publishedRevision > authority.requestRevision) {
      throw new Error("Invalid provider check authority.");
    }
    return authority;
  }

  beginProviderCheckRequest(providerId: string, source: ProviderCheckSource, pendingCheck?: ProviderCheckResult): ProviderCheckAdmission | undefined {
    if (!providerId || !validSource(source)) throw new TypeError("Invalid provider check admission.");
    if (pendingCheck) assertResult(pendingCheck);
    return this.write(() => {
      const provider = this.providers.getProviderPreset(providerId);
      if (!provider) return undefined;
      const authority = this.getProviderCheckAuthority(providerId)!;
      if (authority.requestRevision === Number.MAX_SAFE_INTEGER) throw new Error("Provider check request revision exhausted.");
      const requestRevision = authority.requestRevision + 1;
      this.database.prepare("UPDATE provider_check_authorities SET request_revision=?, request_source=? WHERE provider_id=?")
        .run(requestRevision, source, providerId);
      if (pendingCheck) this.providers.recordProviderCheckResult(providerId, pendingCheck);
      return {
        provider: this.providers.getProviderPreset(providerId)!,
        ticket: { providerId, configRevision: authority.configRevision, requestRevision, source },
      };
    });
  }

  commitProviderCheckResult(ticket: ProviderCheckRequestTicket, result: ProviderCheckResult, cwd: string): ProviderCheckPublicationResult {
    if (!ticket?.providerId || !validSource(ticket.source) || !cwd
      || !Number.isSafeInteger(ticket.configRevision) || ticket.configRevision < 1
      || !Number.isSafeInteger(ticket.requestRevision) || ticket.requestRevision < 1) {
      throw new TypeError("Invalid provider check publication.");
    }
    assertResult(result);
    return this.write(() => {
      const authority = this.getProviderCheckAuthority(ticket.providerId);
      if (!authority) return { status: "deleted" };
      if (authority.configRevision !== ticket.configRevision) return { status: "config_changed" };
      if (authority.requestRevision !== ticket.requestRevision) return { status: "superseded" };
      if (authority.publishedRevision >= ticket.requestRevision) return { status: "already_published" };
      const admitted = this.database.prepare("SELECT request_source FROM provider_check_authorities WHERE provider_id=?").get(ticket.providerId);
      if (admitted?.request_source !== ticket.source) throw new TypeError("Provider check ticket source does not match admission.");
      this.providers.recordProviderCheckResult(ticket.providerId, result);
      this.database.prepare("UPDATE provider_check_authorities SET published_revision=? WHERE provider_id=?")
        .run(ticket.requestRevision, ticket.providerId);
      const event = this.events.appendControlPlaneEventWithinTransaction({
        workspaceId: DEFAULT_WORKSPACE_ID, cwd, domain: "providers", entityType: "provider",
        entityId: ticket.providerId, action: "provider.preflight_checked",
        data: { providerId: ticket.providerId, ok: result.ok, code: result.code ?? (result.ok ? "ok" : "failed"),
          checkedAt: result.checkedAt, source: ticket.source },
      }, new Date().toISOString());
      return { status: "published", provider: this.providers.getProviderPreset(ticket.providerId)!, event };
    });
  }

  private write<T>(operation: () => T): T {
    let owned = false;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      owned = true;
      const result = operation();
      this.database.exec("COMMIT");
      owned = false;
      return result;
    } catch (error) {
      if (owned) rollbackOwnedSqliteTransaction(this.database);
      throw error;
    }
  }
}

function validSource(source: unknown): source is ProviderCheckSource {
  return source === "manual" || source === "startup" || source === "model_import";
}

function assertResult(result: ProviderCheckResult): void {
  if (!result || typeof result.ok !== "boolean" || typeof result.message !== "string"
    || typeof result.checkedAt !== "string" || !Number.isFinite(Date.parse(result.checkedAt))
    || (result.code !== undefined && typeof result.code !== "string")) {
    throw new TypeError("Invalid provider check result.");
  }
  // Only public result fields are persisted; adapter extras are not evidence.
  if (Object.keys(result).some(key => !["ok", "message", "checkedAt", "code"].includes(key))) {
    throw new TypeError("Unexpected provider check result field.");
  }
  stringifyJson(result);
}
