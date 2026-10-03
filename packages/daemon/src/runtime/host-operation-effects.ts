import type { HostCommandExecutionTicket } from "@ling-stack/core";

/**
 * Host-only hooks reserved before asynchronous preparation. Implementations use
 * the captured operation journal and per-attempt admission group, not SDK text.
 * Only the synchronous filesystem effect belongs inside launch/cleanup; snapshot
 * capture and evidence publication remain outside the SQLite write transaction.
 */
export interface HostFileMutationEffectGuard {
  launch<T>(effect: () => T): T;
  /** Rollback of this already-launched operation; never admits new work. */
  cleanup<T>(effect: () => T): T;
}

export interface HostFileMutationOperation {
  /** Recheck before durable preparation and after the approval queue's awaits. */
  assertMayPrepare(): void;
  /** Bind the exact execution returned by the Broker, before any physical effect. */
  bindHarnessExecution(executionId: string): void;
  readonly effectGuard: HostFileMutationEffectGuard;
}

/** A captured command operation, reserved before any approval/preparation await. */
export interface HostCommandOperation {
  assertMayPrepare(): void;
  /** Exact identity returned by Core preparation, never a toolCallId lookup. */
  bindCommandExecution(executionId: string): void;
  /** Enroll native input/copy preparation before its first await or filesystem effect. */
  registerPreparation(producerId: string): HostCommandPreparationOperation;
  /** Claims command and attempt operation atomically around a synchronous OS spawn. */
  launch<T>(ticket: HostCommandExecutionTicket, effect: () => T): T;
  /** Only a never-entered spawn can release this reservation. */
  settleNoStart(): void;
  /** Exit/stdio close is diagnostic, not proof of descendants or effect drain. */
  markUnknown(code: string): void;
}

export interface HostCommandPreparationOperation {
  readonly effectGuard: HostFileMutationEffectGuard;
  /** Only instrumented never-entered preparation is no-start; any entered effects remain unknown. */
  finish(): void;
}
