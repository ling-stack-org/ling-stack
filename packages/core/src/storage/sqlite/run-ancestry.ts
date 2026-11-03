import type { RunSession } from "../../run-types.js";

export type RunAncestryErrorCode = `run_ancestry.${
  "invalid_input" | "missing" | "cycle" | "depth_exceeded"
  | "identity_mismatch" | "root_mismatch" | "workspace_mismatch"}`;

export class RunAncestryError extends Error {
  constructor(readonly code: RunAncestryErrorCode) {
    super(code);
    this.name = "RunAncestryError";
  }
}

/** Run ownership is independent of whether its Task was stored or inlined. */
export type RunAncestryEntry = Readonly<Pick<RunSession, "id" | "parentRunId" | "taskId">>;

export interface RunAncestryPorts<T extends RunAncestryEntry = RunAncestryEntry> {
  readonly getRun: (id: string) => T | undefined;
  /** Resolve the caller's durable owner, not an untrusted request's workspace. */
  readonly getWorkspaceId?: (run: T) => string | undefined;
}

export interface ResolveRunAncestryInput {
  readonly leafRunId: string;
  readonly expectedRootRunId?: string;
  readonly expectedWorkspaceId?: string;
}

export interface RunAncestry {
  readonly rootRunId: string;
  readonly leafRunId: string;
  readonly workspaceId?: string;
  /** Complete root-to-leaf chain, including both endpoints. */
  readonly entries: readonly RunAncestryEntry[];
}

// A fixed shared limit prevents consumers from accepting inconsistent lineages.
const MAX_PARENT_HOPS = 100;

/**
 * Resolve only authoritative Run parent links. Callers needing transactional
 * guarantees must supply reads from the same SQLite transaction; this helper
 * neither opens a transaction nor authenticates a workspace resolver.
 */
export function resolveRunAncestry<T extends RunAncestryEntry>(
  ports: RunAncestryPorts<T>,
  input: ResolveRunAncestryInput,
): RunAncestry {
  const request = captureInput(input);
  const leafRunId = identity(request.leafRunId, "run_ancestry.invalid_input");
  const expectedRootRunId = request.expectedRootRunId === undefined
    ? undefined : identity(request.expectedRootRunId, "run_ancestry.invalid_input");
  const expectedWorkspaceId = request.expectedWorkspaceId === undefined
    ? undefined : identity(request.expectedWorkspaceId, "run_ancestry.invalid_input");
  const getRun = ports?.getRun;
  const getWorkspaceId = ports?.getWorkspaceId;
  if (typeof getRun !== "function"
    || (getWorkspaceId !== undefined && typeof getWorkspaceId !== "function")
    || (expectedWorkspaceId !== undefined && getWorkspaceId === undefined)) {
    fail("run_ancestry.invalid_input");
  }

  const visited = new Set<string>();
  const entries: RunAncestryEntry[] = [];
  let currentRunId = leafRunId;
  let workspaceId = expectedWorkspaceId;
  while (true) {
    if (visited.has(currentRunId)) fail("run_ancestry.cycle");
    if (entries.length > MAX_PARENT_HOPS) fail("run_ancestry.depth_exceeded");
    visited.add(currentRunId);
    const run = getRun.call(ports, currentRunId);
    if (run === undefined) fail("run_ancestry.missing");
    const entry = captureRun(run);
    if (entry.id !== currentRunId) fail("run_ancestry.identity_mismatch");
    if (getWorkspaceId) {
      const resolvedWorkspaceId = identity(getWorkspaceId.call(ports, run), "run_ancestry.workspace_mismatch");
      if (workspaceId !== undefined && workspaceId !== resolvedWorkspaceId) {
        fail("run_ancestry.workspace_mismatch");
      }
      workspaceId = resolvedWorkspaceId;
    }
    entries.push(entry);
    if (entry.parentRunId === undefined) break;
    currentRunId = entry.parentRunId;
  }

  const rootRunId = entries[entries.length - 1].id;
  if (expectedRootRunId !== undefined && expectedRootRunId !== rootRunId) {
    fail("run_ancestry.root_mismatch");
  }
  return Object.freeze({
    rootRunId,
    leafRunId,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    entries: Object.freeze(entries.reverse()),
  });
}

/** Capture the public request once without evaluating accessors. */
function captureInput(value: unknown): Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("run_ancestry.invalid_input");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail("run_ancestry.invalid_input");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string"
        || !["leafRunId", "expectedRootRunId", "expectedWorkspaceId"].includes(key)) {
        fail("run_ancestry.invalid_input");
      }
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) fail("run_ancestry.invalid_input");
      captured[key] = descriptor.value;
    }
    return captured;
  } catch (error) {
    if (error instanceof RunAncestryError) throw error;
    return fail("run_ancestry.invalid_input");
  }
}

/** Copy just lineage fields; unrelated Run data is not part of this projection. */
function captureRun(value: unknown): RunAncestryEntry {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("run_ancestry.identity_mismatch");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail("run_ancestry.identity_mismatch");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of ["id", "taskId", "parentRunId"]) {
      const descriptor = descriptors[key];
      if (descriptor !== undefined && !("value" in descriptor)) fail("run_ancestry.identity_mismatch");
      fields[key] = descriptor?.value;
    }
    const id = identity(fields.id, "run_ancestry.identity_mismatch");
    const taskId = identity(fields.taskId, "run_ancestry.identity_mismatch");
    const parentRunId = fields.parentRunId === undefined
      ? undefined : identity(fields.parentRunId, "run_ancestry.identity_mismatch");
    return Object.freeze({ id, taskId, ...(parentRunId === undefined ? {} : { parentRunId }) });
  } catch (error) {
    if (error instanceof RunAncestryError) throw error;
    return fail("run_ancestry.identity_mismatch");
  }
}

function identity(value: unknown, code: RunAncestryErrorCode): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) fail(code);
  return value;
}

function fail(code: RunAncestryErrorCode): never {
  throw new RunAncestryError(code);
}
