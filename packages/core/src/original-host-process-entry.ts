/** Core-owned physical sources. These names never grant a native protection profile. */
export type CoreOriginalProcessSourceId = "official_skill_git" | "external_work_scheduler";
declare const recordBrand: unique symbol;
declare const entryBrand: unique symbol;

/** Opaque, source-owned single-use input; IDs or reconstructed objects cannot invoke a producer. */
export interface CoreOriginalProcessRecord { readonly [recordBrand]: true }
export interface CoreOriginalProcessEntry<Result = unknown> {
  readonly [entryBrand]: true;
  readonly sourceId: CoreOriginalProcessSourceId;
  readonly invoke: (record: CoreOriginalProcessRecord) => Result;
}
export interface CoreOriginalProcessGuard {
  readonly assertMayLaunch: () => void;
  readonly nativeEntryEntered: () => void;
}
interface CapturedGuard {
  readonly receiver: CoreOriginalProcessGuard;
  readonly assertMayLaunch: () => void;
  readonly nativeEntryEntered: () => void;
}
interface EntryState {
  readonly sourceId: CoreOriginalProcessSourceId;
  readonly invoke: CoreOriginalProcessEntry["invoke"];
  guard?: CapturedGuard;
  enteredBeforeBinding: boolean;
  nativeEntryEntered: boolean;
}
const entries = new WeakMap<object, EntryState>();
const originalRefusals = new WeakSet<object>();

/**
 * Internal source-module factory, deliberately not exported by the Core barrel.
 * Only the original module retains capture; public callers get the frozen entry,
 * never a producer, an input factory, or an ungated invokeOriginal method.
 */
export function createCoreOriginalProcessEntry<Input, Result>(
  sourceId: CoreOriginalProcessSourceId, producer: (input: Input) => Result,
): Readonly<{ readonly entry: CoreOriginalProcessEntry<Result>; readonly capture: (input: Input) => CoreOriginalProcessRecord }> {
  if (!["official_skill_git", "external_work_scheduler"].includes(sourceId) || typeof producer !== "function") {
    throw failure("core_original_process_entry_invalid");
  }
  const records = new WeakMap<CoreOriginalProcessRecord, { readonly input: Input; invoked: boolean }>();
  let entry: CoreOriginalProcessEntry<Result>;
  const invoke = (record: CoreOriginalProcessRecord): Result => {
    const state = requireEntry(entry), captured = records.get(record);
    if (!captured) throw failure("core_original_process_record_invalid");
    if (captured.invoked) throw failure("core_original_process_record_consumed");
    // Records are invocation capabilities, not retry handles. Consume before
    // callbacks so a refusing/reentrant guard cannot replay the same record.
    captured.invoked = true;
    const guard = state.guard;
    if (guard) {
      try {
        assertGuardCurrent(guard);
        invokeVoidGuard(guard.assertMayLaunch, guard.receiver);
      } catch (error) {
        // Mark only this actual source-owned refusal, never caller-provided codes.
        const refusal = isWeakKey(error) ? error : failure("core_original_process_launch_refused", error);
        originalRefusals.add(refusal);
        throw refusal;
      }
    }
    // This boundary is irreversible even if the notification or producer throws.
    // A failed entered observer cannot turn an uncertain effect into no-start.
    state.nativeEntryEntered = true;
    if (!guard) state.enteredBeforeBinding = true;
    try {
      if (guard) invokeVoidGuard(guard.nativeEntryEntered, guard.receiver);
      const result = producer(captured.input);
      // Keep the exact original result, while observing an async producer's
      // rejection before outer catches can borrow an earlier refusal marker.
      if (isWeakKey(result)) {
        try { void Promise.prototype.then.call(result, undefined, revokeOriginalRefusal); }
        catch { /* not a native Promise */ }
      }
      return result;
    } catch (error) {
      revokeOriginalRefusal(error);
      throw error;
    }
  };
  entry = Object.freeze({ sourceId, invoke }) as CoreOriginalProcessEntry<Result>;
  entries.set(entry, { sourceId, invoke: invoke as CoreOriginalProcessEntry["invoke"],
    enteredBeforeBinding: false, nativeEntryEntered: false });
  return Object.freeze({ entry, capture(input: Input): CoreOriginalProcessRecord {
    const record = Object.freeze({}) as CoreOriginalProcessRecord;
    records.set(record, { input, invoked: false });
    return record;
  } });
}

/** One-time synchronous dependency inversion. Installation never clears earlier native-entry history. */
export function bindCoreOriginalProcessGuard(entry: CoreOriginalProcessEntry, guard: CoreOriginalProcessGuard): void {
  const state = requireEntry(entry);
  if (state.guard) throw failure("core_original_process_guard_already_bound");
  const assertion = dataCallback(guard, "assertMayLaunch"), entered = dataCallback(guard, "nativeEntryEntered");
  assertSynchronousCallback(assertion); assertSynchronousCallback(entered);
  // A Proxy descriptor trap may have recursively installed a guard above.
  // Never replace its original binding when the outer installation resumes.
  if (state.guard) throw failure("core_original_process_guard_already_bound");
  state.guard = Object.freeze({ receiver: guard, assertMayLaunch: assertion, nativeEntryEntered: entered });
}

/** Exact identity plus sticky history; the Daemon must additionally compare each real source export. */
export function readCoreOriginalProcessEntry(entry: CoreOriginalProcessEntry): Readonly<{
  readonly sourceId: CoreOriginalProcessSourceId;
  readonly guardBound: boolean;
  readonly enteredBeforeBinding: boolean;
  readonly nativeEntryEntered: boolean;
}> {
  const state = requireEntry(entry);
  return Object.freeze({ sourceId: state.sourceId, guardBound: state.guard !== undefined,
    enteredBeforeBinding: state.enteredBeforeBinding, nativeEntryEntered: state.nativeEntryEntered });
}

/** Private source identity survives catches; matching public error text or codes cannot manufacture it. */
export function isCoreOriginalLaunchRefusal(error: unknown): boolean {
  return isWeakKey(error) && originalRefusals.has(error);
}
function revokeOriginalRefusal(error: unknown): void {
  // Reusing an Error across concurrent phases can conservatively lose its
  // refusal label, never acquire no-start authority. Sticky entry history is
  // the fact; this marker exists only to preserve the original denial in catches.
  if (isWeakKey(error)) originalRefusals.delete(error);
}

function requireEntry(entry: CoreOriginalProcessEntry): EntryState {
  const state = entries.get(entry);
  if (!state || !Object.isFrozen(entry)) throw failure("core_original_process_entry_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(entry);
  if (descriptors.sourceId?.value !== state.sourceId || !Object.hasOwn(descriptors.sourceId, "value")
    || descriptors.invoke?.value !== state.invoke || !Object.hasOwn(descriptors.invoke, "value")) {
    throw failure("core_original_process_entry_invalid");
  }
  return state;
}
function dataCallback(guard: CoreOriginalProcessGuard, key: keyof CoreOriginalProcessGuard): () => void {
  if (!isWeakKey(guard)) throw failure("core_original_process_guard_invalid");
  const descriptor = Object.getOwnPropertyDescriptor(guard, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
    throw failure("core_original_process_guard_invalid");
  }
  return descriptor.value as () => void;
}
function assertGuardCurrent(guard: CapturedGuard): void {
  if (dataCallback(guard.receiver, "assertMayLaunch") !== guard.assertMayLaunch
    || dataCallback(guard.receiver, "nativeEntryEntered") !== guard.nativeEntryEntered) {
    throw failure("core_original_process_guard_changed");
  }
}
function assertSynchronousCallback(callback: () => void): void {
  if (Object.prototype.toString.call(callback) === "[object AsyncFunction]") {
    throw failure("core_original_process_guard_must_be_synchronous");
  }
}
function invokeVoidGuard(callback: () => void, receiver: CoreOriginalProcessGuard): void {
  assertSynchronousCallback(callback);
  const result: unknown = Reflect.apply(callback, receiver, []);
  if (isWeakKey(result)) {
    // Use the intrinsic handler even if a Promise's own then/catch was changed.
    // Ordinary objects/thenables fail the native receiver check without executing them.
    try { void Promise.prototype.then.call(result, undefined, () => undefined); } catch { /* not a native Promise */ }
    if (typeof Reflect.get(result, "then") === "function") {
      void Promise.resolve(result as PromiseLike<unknown>).catch(() => undefined);
      throw failure("core_original_process_guard_must_be_synchronous");
    }
  }
  if (result !== undefined) throw failure("core_original_process_guard_must_return_undefined");
}
function isWeakKey(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function");
}
function failure(code: string, cause?: unknown): Error {
  return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), { code });
}
