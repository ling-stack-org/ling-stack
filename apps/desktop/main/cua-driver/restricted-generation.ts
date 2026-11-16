import { createHash } from "node:crypto";
import { isLockedComputerControlGrantV1, type LockedComputerControlGrantV1 } from "@ling-stack/contracts";
import type { CuaDriverCoordinatorOptions, CuaDriverCoordinatorSnapshot } from "./coordinator.js";
import type { JsonRpcClientMessage } from "./provider-host.js";

export interface CuaDriverActionGate {
  beforeCall(message: JsonRpcClientMessage): Promise<() => Promise<void>>;
}

export interface RestrictedCuaDriverNativeSession {
  check(signal: AbortSignal): Promise<void>;
  beginAction(signal: AbortSignal): Promise<void>;
  finishAction(signal: AbortSignal): Promise<void>;
  /** Provider shutdown must complete before acknowledging native quiescence. */
  end(): Promise<void>;
}

export interface RestrictedCuaDriverCoordinator {
  readonly snapshot?: CuaDriverCoordinatorSnapshot;
  enable(): Promise<CuaDriverCoordinatorSnapshot>;
  suspendForSystem?(reason: string): Promise<void>;
  closeCallGateForSecurityBoundary?(reason: string): void;
  shutdown(): Promise<void>;
}

/** A restricted episode never restarts itself or reuses the normal generation. */
export class RestrictedCuaDriverGeneration {
  private reserved: number | undefined;
  private coordinator: RestrictedCuaDriverCoordinator | undefined;
  private stopped = false;
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;

  constructor(private readonly options: {
    readonly currentGeneration: () => number;
    readonly advanceNormalGenerationFloor: (generation: number) => void;
    readonly createCoordinator: (input: Pick<CuaDriverCoordinatorOptions, "generationFloor" | "actionGate">) => RestrictedCuaDriverCoordinator;
    readonly native: RestrictedCuaDriverNativeSession;
    readonly allowedToolIds: readonly string[];
    readonly isAuthorityCurrent: (grant: LockedComputerControlGrantV1) => boolean;
  }) {}

  reserve(): number {
    if (this.reserved !== undefined || this.stopped) throw new Error("locked_control_authority_rotated");
    const generation = this.options.currentGeneration() + 1;
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("locked_control_generation_exhausted");
    this.options.advanceNormalGenerationFloor(generation);
    this.reserved = generation;
    return generation;
  }

  start(input: { readonly generation: number; readonly grant: LockedComputerControlGrantV1 }): Promise<void> {
    if (this.starting || this.coordinator || this.stopped) return Promise.reject(new Error("locked_control_authority_rotated"));
    if (!isLockedComputerControlGrantV1(input.grant)) return Promise.reject(new Error("locked_control_session_mismatch"));
    const grant = Object.freeze({ ...input.grant });
    const allowedIds = [...this.options.allowedToolIds];
    const allowed = new Set(allowedIds);
    const digest = createHash("sha256").update(JSON.stringify(allowedIds)).digest("hex");
    if (input.generation !== this.reserved
      || grant.platform !== "darwin" || input.generation <= grant.authorizedNormalGeneration
      || digest !== grant.allowedLockedToolIdsDigest || allowed.size === 0) {
      return Promise.reject(new Error("locked_control_session_mismatch"));
    }
    const assertCurrent = (): void => {
      if (this.stopped || Date.parse(grant.expiresAt) <= Date.now() || !this.options.isAuthorityCurrent(grant)) {
        throw new Error("locked_control_authority_rotated");
      }
    };
    const actionGate: CuaDriverActionGate = {
      beforeCall: async (message) => {
        assertCurrent();
        if (!("method" in message) || message.method !== "tools/call") {
          const allowedControl = "method" in message && ("id" in message
            ? ["initialize", "ping", "tools/list"].includes(message.method)
            : ["notifications/initialized", "notifications/cancelled"].includes(message.method));
          if (!allowedControl) throw new Error("locked_control_disabled_by_policy");
          await this.options.native.check(new AbortController().signal);
          assertCurrent();
          return async () => { assertCurrent(); };
        }
        const params = message.params;
        const name = typeof params === "object" && params !== null && !Array.isArray(params)
          ? (params as Readonly<Record<string, unknown>>).name : undefined;
        if (!("id" in message) || typeof name !== "string" || !allowed.has(name)) {
          throw new Error("locked_control_disabled_by_policy");
        }
        await this.options.native.beginAction(new AbortController().signal);
        try { assertCurrent(); }
        catch (error) { await this.options.native.finishAction(new AbortController().signal).catch(() => undefined); throw error; }
        return async () => {
          await this.options.native.finishAction(new AbortController().signal);
          assertCurrent();
        };
      },
    };
    const pending = (async () => {
      assertCurrent();
      await this.options.native.check(new AbortController().signal);
      assertCurrent();
      const coordinator = this.options.createCoordinator({ generationFloor: input.generation - 1, actionGate });
      this.coordinator = coordinator;
      const snapshot = await coordinator.enable();
      assertCurrent();
      if (snapshot.generation !== input.generation || snapshot.lifecycle !== "active") {
        throw new Error("locked_control_capture_unavailable");
      }
      await this.options.native.check(new AbortController().signal);
      assertCurrent();
    })();
    this.starting = pending;
    return pending;
  }

  closeCallGate(reason: string): void {
    this.stopped = true;
    this.coordinator?.closeCallGateForSecurityBoundary?.(reason);
  }

  stop(reason: string): Promise<void> {
    this.closeCallGate(reason);
    if (this.stopping) return this.stopping;
    const pending = (async () => {
      await this.starting?.catch(() => undefined);
      const coordinator = this.coordinator;
      // A failed provider drain must retain native shields and the same owner.
      await coordinator?.suspendForSystem?.(reason);
      await coordinator?.shutdown();
      await this.options.native.end();
      this.coordinator = undefined;
    })();
    this.stopping = pending;
    void pending.catch(() => { if (this.stopping === pending) this.stopping = undefined; });
    return pending;
  }
}
