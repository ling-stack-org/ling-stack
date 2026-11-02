import type { RunStore } from "@ling-stack/core";

interface WorkflowIsolationLifecycle {
  readonly pending: Map<string, Map<string, Promise<unknown>>>;
  readonly trackCompletion?: (completion: Promise<unknown>) => void;
  readonly isShuttingDown?: () => boolean;
}

const lifecycles = new WeakMap<RunStore, WorkflowIsolationLifecycle>();

export function configureWorkflowIsolationLifecycle(store: RunStore, input: {
  readonly trackCompletion: (completion: Promise<unknown>) => void;
  readonly isShuttingDown: () => boolean;
}): void {
  const previous = lifecycles.get(store);
  lifecycles.set(store, { ...input, pending: previous?.pending ?? new Map() });
}

/** Local lifetime only. SQLite intents and fenced authority still decide every effect. */
export function runWorkflowIsolationOperation<T>(store: RunStore, workflowId: string, key: string,
  run: () => Promise<T>): Promise<T> {
  let lifecycle = lifecycles.get(store);
  if (!lifecycle) {
    lifecycle = { pending: new Map() };
    lifecycles.set(store, lifecycle);
  }
  let pending = lifecycle.pending.get(workflowId);
  const previous = pending?.get(key);
  if (previous) return previous as Promise<T>;
  if (lifecycle.isShuttingDown?.()) return Promise.reject(new Error("workflow_isolation.runtime_shutting_down"));
  if (!pending) {
    pending = new Map();
    lifecycle.pending.set(workflowId, pending);
  }
  const operations = pending;
  const completion = Promise.resolve().then(run);
  operations.set(key, completion);
  const finish = () => {
    if (operations.get(key) === completion) operations.delete(key);
    if (!operations.size) lifecycle.pending.delete(workflowId);
  };
  void completion.then(finish, finish);
  lifecycle.trackCompletion?.(completion);
  return completion;
}

export function workflowIsolationIsDraining(store: RunStore, workflowId: string): boolean {
  return Boolean(lifecycles.get(store)?.pending.get(workflowId)?.size);
}

/** Abort/disposition is not physical stop; wait for the original callbacks, without a timeout inference. */
export async function waitForWorkflowIsolationIdle(store: RunStore, workflowId: string): Promise<void> {
  while (true) {
    const pending = lifecycles.get(store)?.pending.get(workflowId);
    if (!pending?.size) return;
    await Promise.allSettled([...pending.values()]);
  }
}
