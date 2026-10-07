import type { HostOfficeNativeCallV2, HostOfficeNativeSyscallV2 } from "../../host-office-local-native-v2-types.js";
import type { CompleteOfficeDirectoryEntryV2 } from "./host-office-local-directory-v2-replay-integrity.js";
import { directoryV2Failure } from "./host-office-local-directory-v2-validation.js";

export type ReturnedOfficeDirectoryCallV2 = Extract<HostOfficeNativeCallV2, { readonly nativeReturnState: "returned" }>;
/** Every call is consumed once by a fixed phase; nested read histories are references, not new calls. */
export class OfficeDirectoryCallCursorV2 {
  private next = 0;
  constructor(readonly entry: CompleteOfficeDirectoryEntryV2) {}
  get ordinal(): number { return this.next; }
  get done(): boolean { return this.next === this.entry.result.calls.length; }
  take(syscall: HostOfficeNativeSyscallV2, lifetime: string, parent: string, allowEintr = false): ReturnedOfficeDirectoryCallV2 {
    const call = this.entry.result.calls[this.next++];
    if (!call || call.syscall !== syscall || call.resourceLifetimeId !== lifetime || call.parentLifetimeId !== parent
      || call.nativeReturnState !== "returned" || !call.success && (!allowEintr || call.errno !== 4 || call.returned !== -1)) return directoryV2Failure();
    return call;
  }
  finish(): void { if (!this.done) directoryV2Failure(); }
}
