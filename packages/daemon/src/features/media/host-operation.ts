import type { AttemptHostOperationHandle, AttemptHostOperationTracker } from "../../runtime/attempt-host-operation-tracker.js";
import type { MediaLocalExecutionHandle } from "../../runtime/media-local-executions.js";
import { HostMediaReceiptProducer, type HostMediaReceiptPreparation } from "./host-receipt-producer.js";
import type { HostMediaWireRequest } from "./native-http-transport.js";

const issuedOperations = new WeakSet<HostMediaOperation>();
const localOperations = new WeakMap<MediaLocalExecutionHandle, HostMediaOperation>();

/** Captured Host admission, not a remote completion receipt or a tool-result heuristic. */
export interface HostMediaOperation {
  assertMayPrepare(): void;
  launchEffect(mode: "forward" | "observation", effect: () => void): void;
  prepareReceipt(input: HostMediaReceiptPreparation): HostMediaReceiptProducer;
  launchNativeEffect(request: HostMediaWireRequest, send: () => void): void;
  readonly receiptProducer: HostMediaReceiptProducer | undefined;
  finish(): void;
}

/** Reserve before the first job write; one transport producer covers uploads, submit and collection. */
export function reserveHostMediaOperation(tracker: AttemptHostOperationTracker, toolCallId: string): HostMediaOperation {
  const parent = tracker.beginHostCall("media", toolCallId);
  let transport: AttemptHostOperationHandle;
  try { transport = tracker.registerProducer(parent, "media", "media-http-chain"); }
  catch (error) {
    try { tracker.settleNoStart(parent); }
    catch { tracker.markUnknown(parent, "media_admission_unconfirmed"); }
    throw error;
  }
  let entered = false;
  let finished = false;
  let receiptProducer: HostMediaReceiptProducer | undefined;
  let preparationAttempted = false;
  const assertLive = (): void => {
    if (finished) throw new Error("media_host_operation_finished");
  };
  const operation: HostMediaOperation = Object.freeze({
    assertMayPrepare: () => { assertLive(); tracker.executorGroup.assertAdmissionOpen(); },
    get receiptProducer() { return receiptProducer; },
    prepareReceipt: (input: HostMediaReceiptPreparation): HostMediaReceiptProducer => {
      assertLive();
      if (receiptProducer) { receiptProducer.assertPreparation(input); return receiptProducer; }
      if (preparationAttempted || entered) throw new Error("media_host_receipt_preparation_unconfirmed");
      preparationAttempted = true;
      receiptProducer = new HostMediaReceiptProducer(input, tracker, parent, transport);
      return receiptProducer;
    },
    launchNativeEffect: (request: HostMediaWireRequest, send: () => void): void => {
      assertLive();
      if (!receiptProducer) throw new Error("media_host_receipt_not_prepared");
      if (typeof send !== "function" || Object.prototype.toString.call(send) === "[object AsyncFunction]") {
        throw new Error("media_host_effect_must_be_synchronous");
      }
      receiptProducer.launch(request, () => { entered = true; return send(); });
    },
    launchEffect: (mode: "forward" | "observation", effect: () => void) => {
      assertLive();
      if (typeof effect !== "function" || Object.prototype.toString.call(effect) === "[object AsyncFunction]") {
        throw new Error("media_host_effect_must_be_synchronous");
      }
      if (mode !== "forward" && mode !== "observation") throw new Error("media_host_effect_mode_invalid");
      // Only the already-entered producer can make a read-only proof request
      // after required-input closure. It cannot enroll or submit new work.
      if (mode === "observation" && entered) {
        tracker.continueHostEffect(transport, effect, "cleanup");
        return;
      }
      const capturedEffect = (): void => {
        entered = true; // Keep this latch even if fetch or COMMIT subsequently fails.
        return effect(); // Forward accidental thenables for Core's rejection.
      };
      if (entered) tracker.continueHostEffect(transport, capturedEffect);
      else tracker.launchHostEffect(transport, capturedEffect);
    },
    finish: () => {
      if (finished) return;
      finished = true;
      if (receiptProducer) {
        try { receiptProducer.finish(); return; }
        catch { /* Local completion never substitutes for an unconfirmed whole-operation receipt. */ }
      }
      const errors: unknown[] = [];
      for (const handle of [transport, parent]) {
        try {
          if (entered) tracker.markUnknown(handle, "media_remote_operation_unverified");
          else {
            try { tracker.settleNoStart(handle); }
            catch (error) { tracker.markUnknown(handle, "media_admission_unconfirmed"); throw error; }
          }
        } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "Media Host settlement remains unconfirmed.");
    },
  });
  issuedOperations.add(operation);
  return operation;
}

export function assertHostMediaOperation(operation: HostMediaOperation): void {
  if (!issuedOperations.has(operation)) throw new Error("media_host_operation_invalid");
}

/** Original in-memory binding only; a persisted job ID or copied local handle cannot restore authority. */
export function bindHostMediaOperation(operation: HostMediaOperation, handle: MediaLocalExecutionHandle): void {
  assertHostMediaOperation(operation);
  const existing = localOperations.get(handle);
  if (existing && existing !== operation) throw new Error("media_host_local_binding_conflict");
  localOperations.set(handle, operation);
}
export function getHostMediaOperation(handle: MediaLocalExecutionHandle): HostMediaOperation | undefined {
  return localOperations.get(handle);
}
