import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AttemptHostOperationHandle, AttemptHostOperationTracker } from "../../runtime/attempt-host-operation-tracker.js";

const issuedOperations = new WeakSet<HostMcpOperation>();

/**
 * Host-only capability for one captured MCP call and its pre-reserved connection.
 * It is not a completion receipt: this slice has no remote whole-operation proof.
 */
export interface HostMcpOperation {
  assertMayPrepare(): void;
  launchToolDispatch(effect: () => void): void;
  launchConnectionEffect(effect: () => void): void;
  /** Bounded cleanup of only this original entered connection; never a new forward send. */
  cleanupConnectionEffect(effect: () => void): void;
  finish(): void;
}

export class McpHostAdmissionError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "McpHostAdmissionError";
  }
}

/** Reserve parent and producer before the callback's first await/dispatch. */
export function reserveHostMcpOperation(tracker: AttemptHostOperationTracker, toolCallId: string): HostMcpOperation {
  const parent = tracker.beginHostCall("mcp", toolCallId);
  let connection: AttemptHostOperationHandle;
  try {
    connection = tracker.registerProducer(parent, "mcp", "mcp-transport-connection");
  } catch (error) {
    // A failed child admission remains in the tracker; never remove it or
    // interpret this parent's genuine no-start as a proof about the child.
    try { tracker.settleNoStart(parent); }
    catch { tracker.markUnknown(parent, "mcp_admission_unconfirmed"); }
    throw error;
  }
  let parentEntered = false;
  let connectionEntered = false;
  let finishing = false;
  const assertLive = (): void => {
    if (finishing) throw new McpHostAdmissionError("mcp_host_operation_finished", "MCP callback has ended; no further dispatch is permitted.");
  };
  const launch = (handle: AttemptHostOperationHandle, entered: boolean, effect: () => void, onEntered: () => void): void => {
    assertLive();
    assertSynchronousEffect(effect);
    const capturedEffect = (): void => {
      onEntered(); // Retain this claim even if effect/COMMIT subsequently fails.
      return effect(); // Forward accidental thenables so Core rejects them.
    };
    if (entered) tracker.continueHostEffect(handle, capturedEffect);
    else tracker.launchHostEffect(handle, capturedEffect);
  };
  const operation: HostMcpOperation = Object.freeze({
    assertMayPrepare: (): void => { assertLive(); tracker.executorGroup.assertAdmissionOpen(); },
    launchToolDispatch: (effect: () => void): void => {
      if (parentEntered) throw new McpHostAdmissionError("mcp_host_dispatch_already_entered", "An entered MCP dispatch cannot be retried.");
      launch(parent, false, effect, () => { parentEntered = true; });
    },
    launchConnectionEffect: (effect: () => void): void => launch(connection, connectionEntered, effect, () => { connectionEntered = true; }),
    cleanupConnectionEffect: (effect: () => void): void => {
      assertLive();
      assertSynchronousEffect(effect);
      if (!connectionEntered) throw new McpHostAdmissionError("mcp_host_connection_not_entered", "An unentered connection has no cleanup authority.");
      tracker.continueHostEffect(connection, effect, "cleanup");
    },
    finish: (): void => {
      finishing = true; // Also closes late SDK retry/SSE callbacks on write failure.
      const errors: unknown[] = [];
      for (const [handle, entered, code] of [
        [connection, connectionEntered, "mcp_connection_physical_scope_unverified"],
        // Core also verifies every child: a never-dispatched tool parent cannot
        // claim whole-operation no-start after its connection producer entered.
        [parent, parentEntered || connectionEntered, "mcp_remote_operation_unverified"],
      ] as const) {
        try {
          if (entered) tracker.markUnknown(handle, code);
          else {
            try { tracker.settleNoStart(handle); }
            catch (error) {
              // Source replacement/persistence failure cannot mint safe no-start.
              tracker.markUnknown(handle, "mcp_admission_unconfirmed");
              throw error;
            }
          }
        } catch (error) { errors.push(error); }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "MCP Host settlement remains unconfirmed.");
    },
  });
  issuedOperations.add(operation);
  return operation;
}

/** Structural clones, optional caller callbacks and booleans grant no authority. */
export function assertHostMcpOperation(operation: HostMcpOperation): void {
  if (!issuedOperations.has(operation)) {
    throw new McpHostAdmissionError("mcp_host_operation_invalid", "An operation issued by the Host tracker is required.");
  }
}

/**
 * Every actual fetch (including sends after awaited headers and SSE reconnects)
 * reenters Core with the same captured connection producer. A pending fetch is
 * deliberately captured, not returned, from the synchronous launch transaction.
 */
export function createHostMcpFetch(operation: HostMcpOperation): FetchLike {
  assertHostMcpOperation(operation);
  return (url, init) => {
    let pending: Promise<Response> | undefined;
    try {
      operation.launchConnectionEffect(() => {
        pending = globalThis.fetch(url, { ...init, redirect: "error" });
      });
    } catch (error) {
      // A COMMIT failure can happen after fetch accepted the request. Keep its
      // rejection observed; broker finally still cancels the original HTTP
      // transport. This does not infer remote stop or allow a retry/no-start.
      if (pending) void pending.then(response => response.body?.cancel()).catch(() => {});
      throw error;
    }
    return pending!;
  };
}

function assertSynchronousEffect(effect: () => void): void {
  // Check the actual callback before wrapping; an AsyncFunction could otherwise
  // continue producing effects after the Core transaction rejects/rolls back.
  if (typeof effect !== "function" || Object.prototype.toString.call(effect) === "[object AsyncFunction]") {
    throw new McpHostAdmissionError("mcp_host_effect_must_be_synchronous", "A synchronous effect dispatch is required.");
  }
}
