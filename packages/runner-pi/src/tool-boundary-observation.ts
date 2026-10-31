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

/** Same bounded facts, but only inside the independent settled SDK callback window. */
export type PiSettledBoundaryInventory = PiProviderBoundaryInventory;

/** Detached original SDK view, available only inside its authentic settlement window. */
export interface PiSettledBoundarySnapshot {
  readonly modelView: readonly unknown[];
  readonly inventory: PiSettledBoundaryInventory;
}

export interface PiCompletedTool {
  readonly toolCallId: string;
  readonly toolName: string;
}

const observations = new WeakMap<PiToolBoundaryObservation, { ended: boolean; entered: boolean; ids: Set<string>;
  names: Map<string, string>; reads: Map<string, PiCompletedBuiltinRead>; invalid: boolean;
  pending: Set<string>; completed: Set<string>; providerBoundary: boolean;
  settledBoundary: boolean; settledKind?: "original" | "restored"; settledSignal?: AbortSignal; settledModelView?: readonly unknown[] }>();

export function createPiToolBoundaryObservation(runId: string, attemptId: string): {
  readonly receipt: PiToolBoundaryObservation;
  readonly enter: (toolCallId?: string, toolName?: string) => void;
  readonly completeBuiltinRead: (toolCallId: string, toolName: string) => void;
  readonly completeTool: (toolCallId: string, toolName: string) => void;
  readonly enterProviderBoundary: () => void;
  readonly leaveProviderBoundary: () => void;
  readonly enterSettledBoundary: (signal?: AbortSignal, modelView?: readonly unknown[]) => void;
  readonly enterRestoredCompleteBoundary: (signal: AbortSignal | undefined, modelView: readonly unknown[]) => void;
  readonly leaveSettledBoundary: () => void;
  readonly finish: () => void;
} {
  const receipt = Object.freeze({ runId, attemptId });
  const state = { ended: false, entered: false, ids: new Set<string>(), names: new Map<string, string>(),
    reads: new Map<string, PiCompletedBuiltinRead>(), invalid: false,
    pending: new Set<string>(), completed: new Set<string>(), providerBoundary: false,
    settledBoundary: false, settledSignal: undefined as AbortSignal | undefined,
    settledKind: undefined as "original" | "restored" | undefined,
    settledModelView: undefined as readonly unknown[] | undefined };
  observations.set(receipt, state);
  return { receipt, enter: (id, name) => {
    state.entered = true;
    if (!id || !name || state.ended || state.providerBoundary || state.settledBoundary || state.completed.has(id)
      || (state.names.has(id) && state.names.get(id) !== name)) {
      state.invalid = true;
    } else { state.ids.add(id); state.names.set(id, name); state.pending.add(id); }
  }, completeBuiltinRead: (id, name) => {
    if (state.ended || state.settledBoundary || !state.pending.has(id) || state.names.get(id) !== name || !["read", "grep", "find", "ls"].includes(name)) {
      state.invalid = true;
    } else state.reads.set(id, Object.freeze({ toolCallId: id, toolName: name as PiCompletedBuiltinRead["toolName"] }));
  },
    completeTool: (id, name) => {
      if (state.ended || state.settledBoundary || !state.pending.has(id) || state.names.get(id) !== name) state.invalid = true;
      else { state.pending.delete(id); state.completed.add(id); }
    },
    enterProviderBoundary: () => {
      if (state.ended || state.providerBoundary || state.settledBoundary) state.invalid = true;
      state.providerBoundary = true;
    },
    leaveProviderBoundary: () => { state.providerBoundary = false; },
    enterSettledBoundary: (signal, modelView) => {
      if (state.ended || state.providerBoundary || state.settledBoundary || signal?.aborted) state.invalid = true;
      state.settledBoundary = true;
      state.settledKind = "original";
      state.settledSignal = signal;
      // Capture before any Host callback awaits or mutates its argument. A DTO
      // returned by that callback is never the source of this observation.
      state.settledModelView = modelView === undefined ? undefined : structuredClone(modelView);
    },
    enterRestoredCompleteBoundary: (signal, modelView) => {
      if (state.ended || state.entered || state.ids.size || state.providerBoundary || state.settledBoundary || signal?.aborted) state.invalid = true;
      state.settledBoundary = true; state.settledKind = "restored"; state.settledSignal = signal;
      state.settledModelView = structuredClone(modelView);
    },
    leaveSettledBoundary: () => { state.settledBoundary = false; state.settledKind = undefined; state.settledSignal = undefined; state.settledModelView = undefined; },
    finish: () => { if (state.pending.size) state.invalid = true; state.ended = true; state.settledModelView = undefined; } };
}

/** Original SDK identity at an actual admission boundary, never a stop receipt. */
export function readPiProviderBoundaryInventory(receipt: PiToolBoundaryObservation | undefined,
  runId: string, attemptId: string): PiProviderBoundaryInventory | undefined {
  if (!receipt || receipt.runId !== runId || receipt.attemptId !== attemptId) return undefined;
  const state = observations.get(receipt);
  if (!state || state.ended || state.invalid || !state.providerBoundary || state.settledBoundary || state.pending.size
    || state.ids.size !== state.completed.size) return undefined;
  return Object.freeze({ toolCallIds: Object.freeze([...state.ids]),
    settledBuiltinReads: Object.freeze([...state.reads.values()]) });
}

/** Authentic identity during a complete non-aborted SDK settlement callback, never provider admission or stop proof. */
export function readPiSettledBoundaryInventory(receipt: PiToolBoundaryObservation | undefined,
  runId: string, attemptId: string): PiSettledBoundaryInventory | undefined {
  // Consult the private identity map before inspecting untrusted copied values.
  const state = receipt && observations.get(receipt);
  if (!state || !receipt || receipt.runId !== runId || receipt.attemptId !== attemptId
    || state.ended || state.invalid || !state.settledBoundary || state.settledKind !== "original" || state.providerBoundary
    || state.settledSignal?.aborted || state.pending.size || state.ids.size !== state.completed.size) return undefined;
  return Object.freeze({ toolCallIds: Object.freeze([...state.ids]),
    settledBuiltinReads: Object.freeze([...state.reads.values()]) });
}

/** Read the independent capture, not the mutable modelView argument handed to Host. */
export function readPiSettledBoundarySnapshot(receipt: PiToolBoundaryObservation | undefined,
  runId: string, attemptId: string): PiSettledBoundarySnapshot | undefined {
  const inventory = readPiSettledBoundaryInventory(receipt, runId, attemptId);
  const view = receipt && observations.get(receipt)?.settledModelView;
  return inventory && view ? Object.freeze({ inventory, modelView: structuredClone(view) }) : undefined;
}

/** Separate installed-complete observation; never claims a new agent_settled event. */
export function readPiRestoredCompleteSnapshot(receipt: PiToolBoundaryObservation | undefined,
  runId: string, attemptId: string): PiSettledBoundarySnapshot | undefined {
  const state = receipt && observations.get(receipt);
  if (!state || !receipt || receipt.runId !== runId || receipt.attemptId !== attemptId || state.ended || state.invalid
    || !state.settledBoundary || state.settledKind !== "restored" || state.settledSignal?.aborted
    || state.providerBoundary || state.entered || state.ids.size || state.pending.size || !state.settledModelView) return undefined;
  return Object.freeze({ inventory: Object.freeze({ toolCallIds: Object.freeze([]), settledBuiltinReads: Object.freeze([]) }),
    modelView: structuredClone(state.settledModelView) });
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

/** Closed original SDK tool inventory, including the exact registered name. */
export function readPiCompletedTools(receipt: PiToolBoundaryObservation | undefined,
  runId: string, attemptId: string): readonly PiCompletedTool[] | undefined {
  if (!receipt || receipt.runId !== runId || receipt.attemptId !== attemptId) return undefined;
  const state = observations.get(receipt);
  if (!state?.ended || state.invalid || state.ids.size !== state.completed.size) return undefined;
  const result: PiCompletedTool[] = [];
  for (const toolCallId of state.ids) {
    const toolName = state.names.get(toolCallId);
    if (!toolName) return undefined;
    result.push(Object.freeze({ toolCallId, toolName }));
  }
  return Object.freeze(result);
}

export function isPiToolFreeCompletion(receipt: PiToolBoundaryObservation | undefined,
  runId: string, attemptId: string): boolean {
  if (!receipt || receipt.runId !== runId || receipt.attemptId !== attemptId) return false;
  const state = observations.get(receipt);
  return state?.ended === true && !state.entered;
}
