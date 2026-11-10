import { isDeepStrictEqual } from "node:util";
import type { HostOfficeDirectoryAncestorV2, HostOfficeLocalDirectoryExecutionRecordV2 } from "@ling-stack/core";
import { protectedHostPathInside } from "./protected-host-domain-paths.js";
import { captureProtectedHostStagePaths, type ProtectedHostStagePaths,
  type ProtectedHostStagePathClosureFact } from "./protected-host-stage-paths.js";

export interface OriginalOfficeDirectoryWindowPathClosure {
  readonly phase: "active" | "close_entered" | "closed_pending" | "unknown";
  readonly stage: readonly ProtectedHostStagePathClosureFact[];
  readonly destination: readonly ProtectedHostStagePathClosureFact[];
}
/** Readonly resource custody only. Registry membership and Core claims supply authority separately. */
export interface OriginalOfficeDirectoryWindowPaths {
  readonly destination: ProtectedHostStagePaths;
  assertCurrent(): void;
  closeOriginalPaths(): void;
  readClosureFacts(): OriginalOfficeDirectoryWindowPathClosure;
}
function requirePaths(value: unknown): asserts value {
  if (!value) throw new Error("protected_host_office_window_identity_invalid");
}
function assertOriginalChain(paths: ProtectedHostStagePaths, expected: readonly HostOfficeDirectoryAncestorV2[]): void {
  const original = paths.readTerminalClosureFacts(), current = paths.identityFacts();
  requirePaths(original.length === expected.length && current.length === original.length);
  for (let i = 0; i < original.length; i++) {
    const held = original[i]!, row = expected[i]!, live = current[i]!;
    // Directory publication legitimately changes timestamps/size. It never replaces the
    // original device/inode/mode or lets a later observation repair the first identity.
    requirePaths(held.state === "retained" && held.close === "not_entered" && row.path === held.path
      && row.identity.isDirectory && !row.identity.isFile && row.identity.device === held.device
      && row.identity.inode === held.inode && String(row.identity.mode) === held.mode
      && live.path === held.path && live.device === held.device && live.inode === held.inode
      && live.uid === held.uid && live.mode === held.mode);
  }
  paths.assertCurrent();
}

/** Capture the original ordinary destination chain; no private-0700 requirement or pathname writes. */
export function captureOriginalOfficeDirectoryWindowPaths(expected: HostOfficeLocalDirectoryExecutionRecordV2,
  stage: ProtectedHostStagePaths): OriginalOfficeDirectoryWindowPaths {
  requirePaths(expected.stage.parentPath === stage.stagePath
    && protectedHostPathInside(expected.destination.parentPath, expected.workspacePath)
    && expected.workspacePath !== "/" && expected.stage.parentPath !== expected.destination.parentPath
    && !protectedHostPathInside(expected.destination.parentPath, expected.stage.parentPath));
  // Keep an independent immutable snapshot; caller mutation cannot retarget later checks.
  const stageChain = structuredClone(expected.stage.ancestors), destinationChain = structuredClone(expected.destination.ancestors);
  assertOriginalChain(stage, stageChain);
  const destination = captureProtectedHostStagePaths(expected.destination.parentPath);
  try {
    assertOriginalChain(destination, destinationChain);
    const workspace = destinationChain.find(row => row.path === expected.workspacePath);
    requirePaths(workspace && isDeepStrictEqual(workspace.identity, expected.workspaceIdentity));
    assertOriginalChain(stage, stageChain);
  } catch (error) {
    try { destination.close(); }
    catch (closeError) { throw new AggregateError([error, closeError], "protected_host_office_window_capture_unknown"); }
    throw error;
  }
  let phase: OriginalOfficeDirectoryWindowPathClosure["phase"] = "active";
  const readClosureFacts = (): OriginalOfficeDirectoryWindowPathClosure => Object.freeze({ phase,
    stage: stage.readTerminalClosureFacts(), destination: destination.readTerminalClosureFacts() });
  return Object.freeze({ destination,
    assertCurrent(): void {
      requirePaths(phase === "active");
      assertOriginalChain(stage, stageChain); assertOriginalChain(destination, destinationChain);
    },
    closeOriginalPaths(): void {
      if (phase !== "active") throw new Error("protected_host_office_window_close_already_entered");
      phase = "close_entered"; // Before either original FD set can execute a close or reenter.
      const errors: unknown[] = [];
      for (const paths of [destination, stage]) try { paths.close(); } catch (error) { errors.push(error); }
      const facts = readClosureFacts();
      if (errors.length || [...facts.stage, ...facts.destination].some(row => row.state !== "closed" || row.close !== "returned")) {
        phase = "unknown";
        throw new AggregateError(errors, "protected_host_office_window_close_unknown");
      }
      phase = "closed_pending"; // Resource closure is not protection-lease release or Core success.
    },
    readClosureFacts,
  });
}
