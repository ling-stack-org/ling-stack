import { randomUUID } from "node:crypto";
import {
  HOST_CAPABILITY_BRIDGE_PROTOCOL_V1,
  isHostOpenLocalTargetReceiptV1,
  parseHostCapabilityBridgeAvailabilityV1,
  parseHostCapabilityBridgeResultV1,
  type HostCapabilityBridgeAvailabilityV1,
  type HostCapabilityBridgeCommandV1,
  type HostCapabilityBridgeResultV1,
  type HostCapabilityIdV1,
  type HostLocalTargetPresentationV1,
  type HostOpenLocalTargetReceiptV1,
} from "@ling-stack/contracts";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_AVAILABILITY_TTL_MS = 12_000;
const DEFAULT_CLAIM_WAIT_MS = 20_000;
const MAX_COMPLETED_RESULTS = 256;

interface HostCapabilityBridgeAuthority {
  readonly desktopInstanceId: string;
  readonly generation: number;
}

interface PendingCommand {
  readonly command: HostCapabilityBridgeCommandV1;
  readonly authority: HostCapabilityBridgeAuthority;
  readonly resolve: (receipt: HostOpenLocalTargetReceiptV1) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly abort?: () => void;
  claimed: boolean;
  begun: boolean;
}

interface CompletedCommand {
  readonly receipt: HostOpenLocalTargetReceiptV1;
  readonly completedAt: number;
}

interface CompletedResult {
  readonly authority: HostCapabilityBridgeAuthority;
  readonly result: HostCapabilityBridgeResultV1;
  readonly completedAt: number;
}

export interface HostCapabilityBridgeSnapshot {
  readonly connected: boolean;
  readonly availability?: HostCapabilityBridgeAvailabilityV1;
}

/**
 * In-memory rendezvous between a daemon Run and the authenticated Desktop Host.
 * The durable approval and Run/Attempt fence live outside this controller. A
 * daemon restart deliberately drops availability and all unfinished commands.
 */
export class HostCapabilityBridgeController {
  private availabilityValue: HostCapabilityBridgeAvailabilityV1 | undefined;
  private availabilityReceivedAt = 0;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly queued: string[] = [];
  private readonly completedByIdempotencyKey = new Map<string, CompletedCommand>();
  private readonly completedByCommandId = new Map<string, CompletedResult>();
  private readonly inFlightByIdempotencyKey = new Map<string, Promise<HostOpenLocalTargetReceiptV1>>();
  private readonly claimWaiters = new Set<() => void>();
  private closed = false;

  constructor(private readonly options: {
    readonly commandTimeoutMs?: number;
    readonly availabilityTtlMs?: number;
    readonly now?: () => number;
  } = {}) {}

  publishAvailability(value: unknown): HostCapabilityBridgeAvailabilityV1 {
    this.assertOpen();
    const availability = parseHostCapabilityBridgeAvailabilityV1(value);
    const current = this.availabilityValue;
    if (current && current.desktopInstanceId === availability.desktopInstanceId
      && availability.generation < current.generation) throw new Error("host_capability_stale_generation");
    if (current && !sameAuthority(current, availability)) {
      this.rejectCommandsForAuthority(current, "host_capability_authority_replaced");
      this.completedByIdempotencyKey.clear();
      this.completedByCommandId.clear();
    }
    this.availabilityValue = availability;
    this.availabilityReceivedAt = this.now();
    this.wakeClaimers();
    return availability;
  }

  snapshot(): HostCapabilityBridgeSnapshot {
    const availability = this.availabilityValue;
    if (!availability || this.closed || this.now() - this.availabilityReceivedAt > this.availabilityTtlMs) {
      return { connected: false, ...(availability ? { availability } : {}) };
    }
    return { connected: true, availability };
  }

  hasCapability(capabilityId: HostCapabilityIdV1): boolean {
    const snapshot = this.snapshot();
    return snapshot.connected === true && snapshot.availability?.capabilities.includes(capabilityId) === true;
  }

  async executeOpenLocalTarget(input: {
    readonly path: string;
    readonly absolutePath: string;
    readonly workspaceRoot: string;
    readonly presentation: HostLocalTargetPresentationV1;
    readonly runId: string;
    readonly attemptId: string;
    readonly toolCallId: string;
    readonly approvalId: string;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }): Promise<HostOpenLocalTargetReceiptV1> {
    this.assertOpen();
    input.signal?.throwIfAborted();
    const completed = this.completedByIdempotencyKey.get(input.idempotencyKey);
    if (completed) return completed.receipt;
    const inFlight = this.inFlightByIdempotencyKey.get(input.idempotencyKey);
    if (inFlight) return await inFlight;
    const snapshot = this.snapshot();
    const availability = snapshot.availability;
    if (!snapshot.connected || !availability?.capabilities.includes("host.open_local_target")) {
      throw new Error("host_capability_desktop_required");
    }
    const id = randomUUID();
    const command: HostCapabilityBridgeCommandV1 = {
      protocol: HOST_CAPABILITY_BRIDGE_PROTOCOL_V1,
      id,
      capabilityId: "host.open_local_target",
      path: input.path,
      absolutePath: input.absolutePath,
      workspaceRoot: input.workspaceRoot,
      presentation: input.presentation,
      runId: input.runId,
      attemptId: input.attemptId,
      toolCallId: input.toolCallId,
      approvalId: input.approvalId,
      deadlineAt: new Date(this.now() + this.commandTimeoutMs).toISOString(),
      idempotencyKey: input.idempotencyKey,
    };
    const execution = new Promise<HostOpenLocalTargetReceiptV1>((resolve, reject) => {
      const timer = setTimeout(() => this.rejectPending(id, "host_capability_timeout"), this.commandTimeoutMs);
      const abort = input.signal ? () => this.rejectPending(id, "host_capability_cancelled") : undefined;
      input.signal?.addEventListener("abort", abort as () => void, { once: true });
      this.pending.set(id, {
        command,
        authority: authorityOf(availability),
        resolve,
        reject,
        timer,
        ...(abort ? { abort: () => input.signal?.removeEventListener("abort", abort) } : {}),
        claimed: false,
        begun: false,
      });
      this.queued.push(id);
      this.wakeClaimers();
    });
    this.inFlightByIdempotencyKey.set(input.idempotencyKey, execution);
    void execution.finally(() => {
      if (this.inFlightByIdempotencyKey.get(input.idempotencyKey) === execution) {
        this.inFlightByIdempotencyKey.delete(input.idempotencyKey);
      }
    }).catch(() => undefined);
    return await execution;
  }

  async claim(authority: HostCapabilityBridgeAuthority, signal?: AbortSignal): Promise<HostCapabilityBridgeCommandV1 | undefined> {
    this.assertCurrentAuthority(authority);
    const immediate = this.takeQueued(authority);
    if (immediate) return immediate;
    signal?.throwIfAborted();
    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", settle);
        this.claimWaiters.delete(settle);
        resolve();
      };
      const timer = setTimeout(settle, DEFAULT_CLAIM_WAIT_MS);
      this.claimWaiters.add(settle);
      signal?.addEventListener("abort", settle, { once: true });
    });
    signal?.throwIfAborted();
    this.assertCurrentAuthority(authority);
    return this.takeQueued(authority);
  }

  /** Final cancellation/current-owner checkpoint immediately before the Desktop effect. */
  begin(authority: HostCapabilityBridgeAuthority, commandId: string): void {
    this.assertCurrentAuthority(authority);
    const pending = this.pending.get(commandId);
    if (!pending || !pending.claimed || pending.begun || !sameAuthority(pending.authority, authority)) {
      throw new Error("host_capability_command_not_found");
    }
    if (Date.parse(pending.command.deadlineAt) <= this.now()) {
      this.rejectPending(commandId, "host_capability_timeout");
      throw new Error("host_capability_timeout");
    }
    pending.begun = true;
  }

  complete(authority: HostCapabilityBridgeAuthority, value: unknown): void {
    this.assertCurrentAuthority(authority);
    const result = parseHostCapabilityBridgeResultV1(value);
    const completed = this.completedByCommandId.get(result.id);
    if (completed) {
      if (!sameAuthority(completed.authority, authority) || !sameResult(completed.result, result)) {
        throw new Error("host_capability_result_conflict");
      }
      return;
    }
    const pending = this.pending.get(result.id);
    if (!pending || !pending.begun || !sameAuthority(pending.authority, authority)) {
      throw new Error("host_capability_command_not_found");
    }
    this.finishPending(pending);
    if (!result.ok) {
      this.rememberResult(pending, result);
      pending.reject(new Error(result.error.code));
      return;
    }
    const receipt = result.receipt;
    if (!isHostOpenLocalTargetReceiptV1(receipt)
      || receipt.path !== pending.command.path
      || receipt.runId !== pending.command.runId
      || receipt.attemptId !== pending.command.attemptId
      || receipt.toolCallId !== pending.command.toolCallId
      || receipt.approvalId !== pending.command.approvalId) {
      pending.reject(new Error("host_capability_receipt_invalid"));
      return;
    }
    this.completedByIdempotencyKey.set(pending.command.idempotencyKey, { receipt, completedAt: this.now() });
    this.rememberResult(pending, result);
    this.pruneCompleted();
    pending.resolve(receipt);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.availabilityValue = undefined;
    for (const id of [...this.pending.keys()]) this.rejectPending(id, "host_capability_bridge_closed");
    this.queued.length = 0;
    this.wakeClaimers();
  }

  private takeQueued(authority: HostCapabilityBridgeAuthority): HostCapabilityBridgeCommandV1 | undefined {
    while (this.queued.length > 0) {
      const id = this.queued.shift();
      if (!id) continue;
      const pending = this.pending.get(id);
      if (!pending || pending.claimed) continue;
      if (!sameAuthority(pending.authority, authority)) {
        this.rejectPending(id, "host_capability_authority_replaced");
        continue;
      }
      pending.claimed = true;
      return pending.command;
    }
    return undefined;
  }

  private rejectPending(id: string, code: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.finishPending(pending);
    pending.reject(Object.assign(new Error(code), { code }));
  }

  private finishPending(pending: PendingCommand): void {
    clearTimeout(pending.timer);
    pending.abort?.();
    this.pending.delete(pending.command.id);
  }

  private rejectCommandsForAuthority(authority: HostCapabilityBridgeAuthority, code: string): void {
    for (const [id, pending] of this.pending) {
      if (sameAuthority(pending.authority, authority)) this.rejectPending(id, code);
    }
  }

  private assertCurrentAuthority(authority: HostCapabilityBridgeAuthority): void {
    this.assertOpen();
    const snapshot = this.snapshot();
    if (!snapshot.connected || !snapshot.availability || !sameAuthority(snapshot.availability, authority)) {
      throw new Error("host_capability_authority_invalid");
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("host_capability_bridge_closed");
  }

  private wakeClaimers(): void {
    for (const wake of [...this.claimWaiters]) wake();
  }

  private pruneCompleted(): void {
    pruneMap(this.completedByIdempotencyKey, MAX_COMPLETED_RESULTS);
    pruneMap(this.completedByCommandId, MAX_COMPLETED_RESULTS);
  }

  private rememberResult(pending: PendingCommand, result: HostCapabilityBridgeResultV1): void {
    this.completedByCommandId.set(result.id, {
      authority: pending.authority,
      result,
      completedAt: this.now(),
    });
    this.pruneCompleted();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private get commandTimeoutMs(): number {
    return this.options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  private get availabilityTtlMs(): number {
    return this.options.availabilityTtlMs ?? DEFAULT_AVAILABILITY_TTL_MS;
  }
}

function authorityOf(value: Pick<HostCapabilityBridgeAvailabilityV1, "desktopInstanceId" | "generation">): HostCapabilityBridgeAuthority {
  return { desktopInstanceId: value.desktopInstanceId, generation: value.generation };
}

function sameAuthority(
  left: Pick<HostCapabilityBridgeAuthority, "desktopInstanceId" | "generation">,
  right: Pick<HostCapabilityBridgeAuthority, "desktopInstanceId" | "generation">,
): boolean {
  return left.desktopInstanceId === right.desktopInstanceId && left.generation === right.generation;
}

function sameResult(left: HostCapabilityBridgeResultV1, right: HostCapabilityBridgeResultV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pruneMap<T extends { readonly completedAt: number }>(map: Map<string, T>, limit: number): void {
  if (map.size <= limit) return;
  const oldest = [...map.entries()]
    .sort((left, right) => left[1].completedAt - right[1].completedAt)
    .slice(0, map.size - limit);
  for (const [key] of oldest) map.delete(key);
}

export function createHostCapabilityBridgeSuccess(
  commandId: string,
  receipt: HostOpenLocalTargetReceiptV1,
): HostCapabilityBridgeResultV1 {
  return { protocol: HOST_CAPABILITY_BRIDGE_PROTOCOL_V1, id: commandId, ok: true, receipt };
}
