/** Memory-only SDK observation. A serialized object or tool result is never a receipt. */
export interface PiToolBoundaryObservation {
  readonly runId: string;
  readonly attemptId: string;
}

export interface PiCompletedBuiltinRead {
  readonly toolCallId: string;
  readonly toolName: "read" | "grep" | "find" | "ls";
}

export interface PiProviderBoundaryInventory {
  readonly toolCallIds: readonly string[];
  readonly settledBuiltinReads: readonly PiCompletedBuiltinRead[];
}

const observations = new WeakMap<PiToolBoundaryObservation, { ended: boolean; entered: boolean; ids: Set<string>;
  names: Map<string, string>; reads: Map<string, PiCompletedBuiltinRead>; invalid: boolean;
  pending: Set<string>; completed: Set<string>; providerBoundary: boolean }>();

export function createPiToolBoundaryObservation(runId: string, attemptId: string): {
  readonly receipt: PiToolBoundaryObservation;
  readonly enter: (toolCallId?: string, toolName?: string) => void;
  readonly completeBuiltinRead: (toolCallId: string, toolName: string) => void;
  readonly completeTool: (toolCallId: string, toolName: string) => void;
  readonly enterProviderBoundary: () => void;
  readonly leaveProviderBoundary: () => void;
  readonly finish: () => void;
} {
  const receipt = Object.freeze({ runId, attemptId });
  const state = { ended: false, entered: false, ids: new Set<string>(), names: new Map<string, string>(),
    reads: new Map<string, PiCompletedBuiltinRead>(), invalid: false,
    pending: new Set<string>(), completed: new Set<string>(), providerBoundary: false };
  observations.set(receipt, state);
  return { receipt, enter: (id, name) => {
    state.entered = true;
    if (!id || !name || state.ended || state.providerBoundary || state.completed.has(id)
      || (state.names.has(id) && state.names.get(id) !== name)) {
      state.invalid = true;
    } else { state.ids.add(id); state.names.set(id, name); state.pending.add(id); }
  }, completeBuiltinRead: (id, name) => {
    if (state.ended || !state.pending.has(id) || state.names.get(id) !== name || !["read", "grep", "find", "ls"].includes(name)) {
      state.invalid = true;
    } else state.reads.set(id, Object.freeze({ toolCallId: id, toolName: name as PiCompletedBuiltinRead["toolName"] }));
  },
    completeTool: (id, name) => {
      if (state.ended || !state.pending.has(id) || state.names.get(id) !== name) state.invalid = true;
      else { state.pending.delete(id); state.completed.add(id); }
    },
    enterProviderBoundary: () => {
      if (state.ended || state.providerBoundary) state.invalid = true;
      state.providerBoundary = true;
    },
    leaveProviderBoundary: () => { state.providerBoundary = false; },
    finish: () => { if (state.pending.size) state.invalid = true; state.ended = true; } };
}

/** Original SDK identity at an actual admission boundary, never a stop receipt. */
export function readPiProviderBoundaryInventory(receipt: PiToolBoundaryObservation | undefined,
  runId: string, attemptId: string): PiProviderBoundaryInventory | undefined {
  if (!receipt || receipt.runId !== runId || receipt.attemptId !== attemptId) return undefined;
  const state = observations.get(receipt);
  if (!state || state.ended || state.invalid || !state.providerBoundary || state.pending.size
    || state.ids.size !== state.completed.size) return undefined;
  return Object.freeze({ toolCallIds: Object.freeze([...state.ids]),
    settledBuiltinReads: Object.freeze([...state.reads.values()]) });
}

/** Actual read-only built-ins; failed file reads are settled without a mutation. */
export function readPiCompletedBuiltinReads(receipt: PiToolBoundaryObservation | undefined,
  runId: string, attemptId: string): readonly PiCompletedBuiltinRead[] | undefined {
  if (!receipt || receipt.runId !== runId || receipt.attemptId !== attemptId) return undefined;
  const state = observations.get(receipt);
  return state?.ended && !state.invalid ? Object.freeze([...state.reads.values()]) : undefined;
}

/** A complete original SDK boundary inventory, not evidence that any effect settled. */
export function readPiCompletedToolCalls(receipt: PiToolBoundaryObservation | undefined,
  runId: string, attemptId: string): readonly string[] | undefined {
  if (!receipt || receipt.runId !== runId || receipt.attemptId !== attemptId) return undefined;
  const state = observations.get(receipt);
  return state?.ended && !state.invalid ? Object.freeze([...state.ids]) : undefined;
}

export function isPiToolFreeCompletion(receipt: PiToolBoundaryObservation | undefined,
  runId: string, attemptId: string): boolean {
  if (!receipt || receipt.runId !== runId || receipt.attemptId !== attemptId) return false;
  const state = observations.get(receipt);
  return state?.ended === true && !state.entered;
}
