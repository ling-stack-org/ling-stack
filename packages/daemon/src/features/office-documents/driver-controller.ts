import { randomUUID } from "node:crypto";
import {
  OFFICE_DRIVER_MAX_RESULT_BYTES,
  OFFICE_DRIVER_PROTOCOL,
  parseOfficeDriverAvailability,
  parseOfficeDriverResult,
  type OfficeDriverAvailability,
  type OfficeDriverMethod,
  type OfficeDriverRequest,
  type OfficeDriverResult,
} from "@ling-stack/contracts";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_AVAILABILITY_TTL_MS = 12_000;
const DEFAULT_CLAIM_WAIT_MS = 20_000;
const MAX_COMPLETED_IDEMPOTENCY_RESULTS = 256;

interface PendingCommand {
  readonly command: OfficeDriverRequest;
  readonly authority: OfficeDriverAuthority;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly abort?: () => void;
  claimed: boolean;
}

interface CompletedCommand {
  readonly value: unknown;
  readonly completedAt: number;
}

interface OfficeDriverAuthority {
  readonly desktopInstanceId: string;
  readonly generation: number;
}

export interface OfficeDriverSnapshot {
  readonly connected: boolean;
  readonly availability?: OfficeDriverAvailability;
}

export class OfficeDriverController {
  private availabilityValue: OfficeDriverAvailability | undefined;
  private availabilityReceivedAt = 0;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly queued: string[] = [];
  private readonly completedByIdempotencyKey = new Map<string, CompletedCommand>();
  private readonly inFlightByIdempotencyKey = new Map<string, Promise<unknown>>();
  private readonly claimWaiters = new Set<() => void>();
  private closed = false;

  constructor(private readonly options: {
    readonly commandTimeoutMs?: number;
    readonly availabilityTtlMs?: number;
    readonly now?: () => number;
  } = {}) {}

  publishAvailability(value: unknown): OfficeDriverAvailability {
    this.assertOpen();
    const availability = parseOfficeDriverAvailability(value);
    const current = this.availabilityValue;
    if (current && current.desktopInstanceId === availability.desktopInstanceId && availability.generation < current.generation) {
      throw new Error("office_driver_stale_generation");
    }
    if (current && !sameAuthority(current, availability)) {
      this.rejectCommandsForAuthority(current, "office_driver_authority_replaced");
    }
    this.availabilityValue = availability;
    this.availabilityReceivedAt = this.now();
    this.wakeClaimers();
    return availability;
  }

  snapshot(): OfficeDriverSnapshot {
    const availability = this.availabilityValue;
    if (!availability || this.closed || this.now() - this.availabilityReceivedAt > this.availabilityTtlMs) {
      return { connected: false, ...(availability ? { availability } : {}) };
    }
    return { connected: true, availability };
  }

  async execute(input: {
    readonly method: OfficeDriverMethod;
    readonly params: unknown;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }): Promise<unknown> {
    this.assertOpen();
    input.signal?.throwIfAborted();
    const completed = this.completedByIdempotencyKey.get(input.idempotencyKey);
    if (completed) return completed.value;
    const inFlight = this.inFlightByIdempotencyKey.get(input.idempotencyKey);
    if (inFlight) return await inFlight;
    const snapshot = this.snapshot();
    const availability = snapshot.availability;
    if (!snapshot.connected || !availability) throw new Error("office_driver_desktop_required");
    if (availability.state !== "ready" && availability.state !== "limited" && input.method !== "driver_status") {
      throw new Error(`office_driver_${availability.state}`);
    }
    const id = randomUUID();
    const timeoutMs = this.commandTimeoutMs;
    const command: OfficeDriverRequest = {
      protocol: OFFICE_DRIVER_PROTOCOL,
      id,
      method: input.method,
      params: input.params,
      deadlineAt: new Date(this.now() + timeoutMs).toISOString(),
      idempotencyKey: input.idempotencyKey,
    };
    const execution = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => this.rejectPending(id, "office_driver_timeout"), timeoutMs);
      const abort = input.signal
        ? () => this.rejectPending(id, "office_driver_cancelled")
        : undefined;
      input.signal?.addEventListener("abort", abort as () => void, { once: true });
      this.pending.set(id, {
        command,
        authority: authorityOf(availability),
        resolve,
        reject,
        timer,
        ...(abort ? { abort: () => input.signal?.removeEventListener("abort", abort) } : {}),
        claimed: false,
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

  async claim(input: OfficeDriverAuthority, signal?: AbortSignal): Promise<OfficeDriverRequest | undefined> {
    this.assertCurrentAuthority(input);
    const immediate = this.takeQueued(input);
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
    this.assertCurrentAuthority(input);
    return this.takeQueued(input);
  }

  complete(input: OfficeDriverAuthority, value: unknown): void {
    this.assertCurrentAuthority(input);
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > OFFICE_DRIVER_MAX_RESULT_BYTES) {
      throw new Error("office_driver_result_too_large");
    }
    const result = parseOfficeDriverResult(value);
    const pending = this.pending.get(result.id);
    if (!pending || !sameAuthority(pending.authority, input)) throw new Error("office_driver_command_not_found");
    this.finishPending(pending);
    if (!result.ok) {
      pending.reject(new Error(result.error?.code ?? "office_driver_failed"));
      return;
    }
    const responseValue = result.result ?? null;
    this.completedByIdempotencyKey.set(pending.command.idempotencyKey, {
      value: responseValue,
      completedAt: this.now(),
    });
    this.pruneCompleted();
    pending.resolve(responseValue);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.availabilityValue = undefined;
    for (const id of [...this.pending.keys()]) this.rejectPending(id, "office_driver_closed");
    this.queued.length = 0;
    this.wakeClaimers();
  }

  private takeQueued(authority: OfficeDriverAuthority): OfficeDriverRequest | undefined {
    while (this.queued.length > 0) {
      const id = this.queued.shift();
      if (!id) continue;
      const pending = this.pending.get(id);
      if (!pending || pending.claimed) continue;
      if (!sameAuthority(pending.authority, authority)) {
        this.rejectPending(id, "office_driver_authority_replaced");
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
    pending.reject(new Error(code));
  }

  private finishPending(pending: PendingCommand): void {
    clearTimeout(pending.timer);
    pending.abort?.();
    this.pending.delete(pending.command.id);
  }

  private rejectCommandsForAuthority(authority: OfficeDriverAuthority, code: string): void {
    for (const [id, pending] of this.pending) {
      if (sameAuthority(pending.authority, authority)) this.rejectPending(id, code);
    }
  }

  private assertCurrentAuthority(authority: OfficeDriverAuthority): void {
    this.assertOpen();
    const snapshot = this.snapshot();
    if (!snapshot.connected || !snapshot.availability || !sameAuthority(snapshot.availability, authority)) {
      throw new Error("office_driver_authority_invalid");
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("office_driver_closed");
  }

  private wakeClaimers(): void {
    for (const wake of [...this.claimWaiters]) wake();
  }

  private pruneCompleted(): void {
    if (this.completedByIdempotencyKey.size <= MAX_COMPLETED_IDEMPOTENCY_RESULTS) return;
    const oldest = [...this.completedByIdempotencyKey.entries()]
      .sort((left, right) => left[1].completedAt - right[1].completedAt)
      .slice(0, this.completedByIdempotencyKey.size - MAX_COMPLETED_IDEMPOTENCY_RESULTS);
    for (const [key] of oldest) this.completedByIdempotencyKey.delete(key);
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

function authorityOf(value: OfficeDriverAvailability): OfficeDriverAuthority {
  return { desktopInstanceId: value.desktopInstanceId, generation: value.generation };
}

function sameAuthority(left: OfficeDriverAuthority, right: OfficeDriverAuthority): boolean {
  return left.desktopInstanceId === right.desktopInstanceId && left.generation === right.generation;
}

export function createOfficeDriverSuccess(commandId: string, result: unknown): OfficeDriverResult {
  return { protocol: OFFICE_DRIVER_PROTOCOL, id: commandId, ok: true, result };
}
