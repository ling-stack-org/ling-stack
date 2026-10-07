import type { HostOfficeLocalDirectoryExecutionRecordV2 } from "../../host-office-local-directory-v2-types.js";
import type { CapturedOriginalOfficeHostBridge, OriginalOfficeDirectoryAuthorityV2 } from "../../original-office-host-bridge.js";
import { hostOperationFailure } from "./host-operation-journal-evidence.js";
import { readSqliteWithinTransaction } from "./read-snapshot.js";
import type { SqliteStoreContext } from "./store-context.js";

/** Original live-ticket binding only. No Core certificate or safe settlement is issued here. */
export class OfficeDirectoryScopeBindingV2 {
  private phase: "unbound" | "binding_entered" | "bound" | "invalid" = "unbound";
  private bound?: { readonly authority: OriginalOfficeDirectoryAuthorityV2; readonly identityDigest: string };
  constructor(private readonly context: SqliteStoreContext, private readonly bridge?: CapturedOriginalOfficeHostBridge) {}

  assertAuthorityOwned(authority: OriginalOfficeDirectoryAuthorityV2): void {
    if (!this.bridge) return hostOperationFailure("host_office_local_bridge_unavailable");
    this.bridge.assertAuthorityOwned(authority);
  }
  assertUnbound(): void {
    if (this.phase !== "unbound") return hostOperationFailure("host_office_local_scope_binding_closed");
  }
  /** Legacy native-only facts still work, but an entered/failed binding cannot reopen effect admission. */
  assertMutable(): void {
    if (this.phase === "binding_entered" || this.phase === "invalid") return hostOperationFailure("host_office_local_scope_binding_closed");
    if (this.phase === "bound") this.assertAuthorityOwned(this.bound!.authority);
  }
  /** The outer journal COMMIT can fail after Host returned; no rollback revives that binding. */
  invalidateIfEntered(): void {
    if (this.phase !== "unbound") { this.phase = "invalid"; this.bound = undefined; }
  }
  bind(authority: OriginalOfficeDirectoryAuthorityV2, execution: HostOfficeLocalDirectoryExecutionRecordV2): void {
    this.assertAuthorityOwned(authority); this.assertUnbound();
    this.phase = "binding_entered"; // Survives reentry, SQL rollback and validation-return loss.
    try {
      // Input comes only from the owning Core row. Freeze a separate snapshot so the
      // fixed endpoint cannot mutate the execution retained by this original ticket.
      const expected = freeze(JSON.parse(JSON.stringify(execution))) as HostOfficeLocalDirectoryExecutionRecordV2;
      readSqliteWithinTransaction(this.context.database, () => this.bridge!.bindAuthority(authority, expected));
      this.bound = Object.freeze({ authority, identityDigest: execution.identityDigest });
      this.phase = "bound";
    } catch (error) { this.phase = "invalid"; throw error; }
  }
  requireBound(execution: HostOfficeLocalDirectoryExecutionRecordV2): OriginalOfficeDirectoryAuthorityV2 {
    if (this.phase !== "bound" || !this.bound || this.bound.identityDigest !== execution.identityDigest) {
      return hostOperationFailure("host_office_local_scope_binding_closed");
    }
    this.assertAuthorityOwned(this.bound.authority);
    return this.bound.authority;
  }
}
function freeze(value: unknown): unknown {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
