import type { HostOfficeLocalDirectoryCloseClaimV2, HostOfficeLocalDirectoryCommittedPairV2,
  HostOfficeLocalSettlement } from "@ling-stack/core";
import type { OriginalOfficeDirectoryAuthorityV2 } from "@ling-stack/core/original-office-host-bridge";
import { officeLocalDirectoryWriteState, type OfficeLocalDirectoryWritePlan,
  type OfficeLocalDirectoryWriteState } from "./office-local-authority.js";
import { captureOriginalOfficeDirectoryAuthorityV2,
  releaseOriginalOfficeDirectoryLeaseV2 } from "./office-local-directory-core-authority.js";
import { bindOriginalAttemptHostOfficeDirectoryLeaseRequirementV2, closeOriginalAttemptHostOfficeLocalDirectoryWindowV2,
  settleOriginalAttemptHostOfficeLocalDirectoryFromStoreV2 } from "../../runtime/attempt-host-operation-tracker.js";

interface OriginalDirectorySettlement {
  readonly store: OfficeLocalDirectoryWriteState["store"];
  readonly tracker: OfficeLocalDirectoryWriteState["tracker"];
  readonly ticket: OfficeLocalDirectoryWriteState["ticket"];
  readonly authority: OriginalOfficeDirectoryAuthorityV2;
  closeClaim?: HostOfficeLocalDirectoryCloseClaimV2;
  grant?: HostOfficeLocalDirectoryCommittedPairV2;
  inProgress: boolean;
}
// Neither the public factual state nor a getter exposes this authority/custody.
const originals = new WeakMap<OfficeLocalDirectoryWritePlan, OriginalDirectorySettlement>();
const fail = (): never => { throw new Error("office_local_directory_original_authority_invalid"); };

/** Capture only a plan already minted by the private original preparation path. */
export function bindOriginalOfficeLocalDirectoryWriteAuthority(plan: OfficeLocalDirectoryWritePlan): void {
  if (originals.has(plan)) return fail();
  const state = officeLocalDirectoryWriteState(plan);
  const authority = captureOriginalOfficeDirectoryAuthorityV2(state.store, state.runtime, state.scope);
  state.store.bindHostOfficeLocalDirectoryScopeAuthorityV2(state.ticket, authority);
  bindOriginalAttemptHostOfficeDirectoryLeaseRequirementV2(state.tracker, state.ticket, authority);
  originals.set(plan, { store: state.store, tracker: state.tracker, ticket: state.ticket, authority, inProgress: false });
}

function original(plan: OfficeLocalDirectoryWritePlan): OriginalDirectorySettlement {
  // A DTO, cloned plan or another Store's state cannot supply the original frame.
  officeLocalDirectoryWriteState(plan);
  return originals.get(plan) ?? fail();
}

/** Owning Core close only, after the terminal seal; never the legacy stage close. */
export function closeOriginalOfficeLocalDirectoryWriteWindow(plan: OfficeLocalDirectoryWritePlan): void {
  const state = original(plan);
  if (state.inProgress) throw new Error("office_local_directory_settlement_in_progress");
  state.inProgress = true;
  try { state.closeClaim = closeOriginalAttemptHostOfficeLocalDirectoryWindowV2(state.tracker, state.ticket); }
  finally { state.inProgress = false; }
}

/** Commit the same pair, release its fixed lease, then close its original local barriers. */
export function settleOriginalOfficeLocalDirectoryWrite(plan: OfficeLocalDirectoryWritePlan): HostOfficeLocalSettlement {
  const state = original(plan);
  if (state.inProgress) throw new Error("office_local_directory_settlement_in_progress");
  if (!state.closeClaim) return fail();
  state.inProgress = true;
  try {
    let grant: HostOfficeLocalDirectoryCommittedPairV2;
    try { grant = state.store.settleHostOfficeLocalDirectoryExecutionV2(state.ticket); }
    catch { grant = state.store.settleHostOfficeLocalDirectoryExecutionV2(state.ticket); }
    if (state.grant && state.grant !== grant) return fail();
    state.grant = grant;
    releaseOriginalOfficeDirectoryLeaseV2(state.authority, grant, state.closeClaim);
    // The V2 Tracker rereads this same idempotent Core grant using its fixed
    // SQL verifier; producer and parent barriers cannot close before release.
    return settleOriginalAttemptHostOfficeLocalDirectoryFromStoreV2(state.tracker, state.ticket);
  } finally { state.inProgress = false; }
}
