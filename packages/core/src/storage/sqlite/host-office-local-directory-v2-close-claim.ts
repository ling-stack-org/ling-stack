import type { DatabaseSync } from "node:sqlite";
import type { HostOfficeLocalDirectoryCloseClaimV2, HostOfficeLocalDirectoryExecutionRecordV2 } from "../../host-office-local-directory-v2-types.js";
import type { SealHostOfficeLocalTerminalInput } from "../../host-office-local-terminal-types.js";
import type { CapturedOriginalOfficeHostBridge, OriginalOfficeDirectoryAuthorityV2 } from "../../original-office-host-bridge.js";
import { hostOperationFailure } from "./host-operation-journal-evidence.js";
import { readOfficeLocalDirectoryEffectsV2, validateOfficeLocalDirectoryObservationV2 } from "./host-office-local-directory-v2-records.js";
import { readOfficeLocalDirectoryTerminalV2 } from "./host-office-local-directory-v2-terminal.js";

/** Pure owning-row preflight. A failed preflight consumes no admission latch or physical close. */
export function assertOfficeDirectoryNativeCloseReadyV2(database: DatabaseSync,
  execution: HostOfficeLocalDirectoryExecutionRecordV2, entered: ReadonlyMap<string, string>,
  sealClaim?: SealHostOfficeLocalTerminalInput): void {
  const effects = readOfficeLocalDirectoryEffectsV2(database, execution), nativeEntered = effects.filter(effect => effect.enteredAt);
  if (entered.size === 0 && nativeEntered.length === 0) return;
  const fail = (): never => hostOperationFailure("host_office_local_native_close_not_ready");
  if (entered.size !== nativeEntered.length || nativeEntered.some(effect => entered.get(effect.effectId) !== effect.enteredAt)) return fail();
  const entries = effects.map(effect => ({ effect, observation: effect.observationArtifactId
    ? validateOfficeLocalDirectoryObservationV2(database, execution, effect, effect.observationArtifactId) : undefined }));
  if (entries.some(({ effect, observation }) => effect.enteredAt
    && (!observation || observation.native.state !== "returned" || observation.host.state !== "returned"))) return fail();
  const last = entries.at(-1), terminal = readOfficeLocalDirectoryTerminalV2(database, execution);
  if (!last || last.effect.kind !== "close_session" || !last.effect.enteredAt || last.observation?.native.state !== "returned"
    || last.observation.host.state !== "returned" || !last.observation.native.result.success
    || last.observation.native.result.snapshot.phase !== "closed" || !terminal || !sealClaim
    || terminal.terminalArtifactId !== sealClaim.terminalArtifactId || terminal.terminalDigest !== sealClaim.terminalDigest
    || terminal.resources.some(resource => resource.state !== "closed" && resource.state !== "not_acquired")) return fail();
}

/** Memory-only original close intent. SQL rollback or lost replies never recreate the one physical close. */
export class OfficeDirectoryWindowCloseClaimV2 {
  private phase: "open" | "close_entered" | "closed_pending" | "unknown" = "open";
  private original?: { readonly authority: OriginalOfficeDirectoryAuthorityV2; readonly expected: HostOfficeLocalDirectoryExecutionRecordV2 };
  private claim?: HostOfficeLocalDirectoryCloseClaimV2;
  constructor(private readonly bridge?: CapturedOriginalOfficeHostBridge) {}
  get entered(): boolean { return this.phase !== "open"; }
  assertNotReenter(): void {
    if (this.phase === "close_entered") return hostOperationFailure("host_office_local_window_close_reentry");
  }

  close(execution: HostOfficeLocalDirectoryExecutionRecordV2, authority: OriginalOfficeDirectoryAuthorityV2): HostOfficeLocalDirectoryCloseClaimV2 {
    if (!this.bridge) return hostOperationFailure("host_office_local_bridge_unavailable");
    if (this.original && (this.original.authority !== authority || this.original.expected.identityDigest !== execution.identityDigest)) {
      return hostOperationFailure("host_office_local_close_claim_conflict");
    }
    this.assertNotReenter();
    const first = this.phase === "open";
    this.original ??= Object.freeze({ authority, expected: freeze(JSON.parse(JSON.stringify(execution))) as HostOfficeLocalDirectoryExecutionRecordV2 });
    this.phase = "close_entered"; // Before either endpoint; all subsequent calls only assert this original closure.
    try {
      if (first) this.bridge.closeAuthority(this.original.authority, this.original.expected);
      this.bridge.assertAuthorityClosed(this.original.authority, this.original.expected);
      this.phase = "closed_pending";
      this.claim ??= Object.freeze({}) as HostOfficeLocalDirectoryCloseClaimV2;
      return this.claim;
    } catch (error) { this.phase = "unknown"; throw error; }
  }
}
function freeze(value: unknown): unknown {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
