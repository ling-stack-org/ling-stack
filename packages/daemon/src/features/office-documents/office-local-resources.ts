import { fstatSync } from "node:fs";
import type { HostOfficeFileIdentity, HostOperationSource } from "@ling-stack/core";
import { officeFileIdentity, sameOfficeNode } from "./office-local-identity.js";
import { officeObservationTime } from "./office-local-clock.js";

declare const resourceBrand: unique symbol;
/** Private live reference. Serialized metadata and a reused FD number are not capabilities. */
interface ResourceBase {
  readonly memberId: string;
  readonly resourceLifetimeId: string;
  readonly fd: number;
  readonly [resourceBrand]: true;
}
export interface OfficeLocalEffectResource extends ResourceBase {
  readonly origin: "effect";
  readonly openEffectId: string;
}
export interface OfficeLocalMemberReadResource extends ResourceBase {
  readonly origin: "member_read";
  readonly readId: string;
  readonly purpose: "refresh" | "final";
  readonly openCalledAt: string;
  readonly openReturnedAt: string;
}
export type OfficeLocalResource = OfficeLocalEffectResource | OfficeLocalMemberReadResource;
interface ResourceFinalBase {
  readonly memberId: string;
  readonly resourceLifetimeId: string;
  readonly identity?: HostOfficeFileIdentity;
  readonly identityObservedAt?: string;
}
type EffectClose = { readonly origin: "effect"; readonly state: "retained" }
  | { readonly origin: "effect"; readonly state: "closed" | "unknown"; readonly closeEffectId: string };
type ReadClose = { readonly origin: "member_read"; readonly state: "retained" }
  | { readonly origin: "member_read"; readonly state: "unknown"; readonly closeEnteredAt: string }
  | { readonly origin: "member_read"; readonly state: "closed"; readonly closeEnteredAt: string; readonly closeReturnedAt: string };
export type OfficeLocalEffectResourceFinal = ResourceFinalBase & EffectClose & { readonly openEffectId: string };
export type OfficeLocalMemberReadResourceFinal = ResourceFinalBase & ReadClose & {
  readonly readId: string; readonly purpose: "refresh" | "final";
  readonly openCalledAt: string; readonly openReturnedAt: string; readonly identityObservedAt?: string;
};
export type OfficeLocalResourceFinal = OfficeLocalEffectResourceFinal | OfficeLocalMemberReadResourceFinal;
interface ResourceState {
  identity?: HostOfficeFileIdentity;
  identityObservedAt?: string;
  close: EffectClose | ReadClose;
}

// Strongly own every unclosed execution even when the plan/caller is collected.
// Unknown close outcomes are retained as blockers, never retried by FD number.
const activeOwners = new Set<OfficeLocalResourceOwner>();
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 4096 && !value.includes("\0");
const invalid = (): never => { throw Object.assign(new Error("office_local_resource_invalid"), { code: "office_local_resource_invalid" }); };
const timestamp = (value: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));

/** Own native resources for one captured execution; no ID-based recovery or automatic cleanup. */
export class OfficeLocalResourceOwner {
  readonly source: HostOperationSource;
  readonly #resources = new Map<OfficeLocalResource, ResourceState>();
  readonly #lifetimes = new Set<string>();

  constructor(readonly executionId: string, source: HostOperationSource) {
    if (!validId(executionId) || ![source.runId, source.workUnitId, source.attemptId,
      source.runtimeInstanceId, source.fencingToken].every(validId)) invalid();
    this.source = Object.freeze({ runId: source.runId, workUnitId: source.workUnitId, attemptId: source.attemptId,
      runtimeInstanceId: source.runtimeInstanceId, fencingToken: source.fencingToken });
  }

  /** Called immediately after native open returned, before fstat/readback/COMMIT. */
  retainOpened(input: { readonly resourceLifetimeId: string; readonly memberId: string;
    readonly openEffectId: string; readonly fd: number }): OfficeLocalEffectResource {
    if (![input.resourceLifetimeId, input.memberId, input.openEffectId].every(validId)
      || !Number.isSafeInteger(input.fd) || input.fd < 0 || this.#lifetimes.has(input.resourceLifetimeId)) invalid();
    const resource = Object.freeze({ origin: "effect" as const, ...input }) as OfficeLocalEffectResource;
    this.#lifetimes.add(resource.resourceLifetimeId);
    this.#resources.set(resource, { close: { origin: "effect", state: "retained" } });
    activeOwners.add(this);
    return resource;
  }

  /** A local observation owns its returned FD too, but cannot invent a Host effect. */
  retainReadOpened(input: { readonly resourceLifetimeId: string; readonly memberId: string; readonly readId: string;
    readonly purpose: "refresh" | "final"; readonly openCalledAt: string; readonly openReturnedAt: string;
    readonly fd: number }): OfficeLocalMemberReadResource {
    if (![input.resourceLifetimeId, input.memberId, input.readId].every(validId)
      || !["refresh", "final"].includes(input.purpose) || !timestamp(input.openCalledAt) || !timestamp(input.openReturnedAt)
      || input.openCalledAt > input.openReturnedAt || !Number.isSafeInteger(input.fd) || input.fd < 0
      || this.#lifetimes.has(input.resourceLifetimeId)) invalid();
    const resource = Object.freeze({ origin: "member_read" as const, ...input }) as OfficeLocalMemberReadResource;
    this.#lifetimes.add(resource.resourceLifetimeId);
    this.#resources.set(resource, { close: { origin: "member_read", state: "retained" } });
    activeOwners.add(this);
    return resource;
  }

  /** Guard a still-owned resource. A prior close call forbids even a fresh fstat. */
  assertUsable(resource: OfficeLocalResource, notBefore?: string): HostOfficeFileIdentity {
    return this.inspectUsable(resource, notBefore).identity;
  }

  /** One actual fstat, after ownership admission; no extra path lookup or FD reopening. */
  inspectUsable(resource: OfficeLocalResource, notBefore?: string): { readonly identity: HostOfficeFileIdentity; readonly isFile: boolean } {
    const state = this.#require(resource);
    if (state.close.state !== "retained" || (notBefore !== undefined && !timestamp(notBefore))) return invalid();
    const observed = fstatSync(resource.fd, { bigint: true }), identity = officeFileIdentity(observed);
    if (state.identity && !sameOfficeNode(state.identity, identity)) return invalid();
    if (!state.identity) {
      state.identity = identity;
      state.identityObservedAt = officeObservationTime(resource.origin === "member_read" ? resource.openReturnedAt : notBefore);
    }
    return { identity, isFile: observed.isFile() };
  }

  /** Fixed writer calls this immediately before its one native close invocation. */
  beginClose(resource: OfficeLocalEffectResource, closeEffectId: string): void {
    const state = this.#require(resource);
    if (resource.origin !== "effect" || !validId(closeEffectId) || state.close.state !== "retained") invalid();
    state.close = { origin: "effect", state: "unknown", closeEffectId };
  }

  /** Only the fixed writer's actual close-return point may mark the resource closed. */
  markClosed(resource: OfficeLocalEffectResource): void {
    const state = this.#require(resource);
    if (resource.origin !== "effect" || state.close.origin !== "effect" || state.close.state !== "unknown") return invalid();
    state.close = { ...state.close, state: "closed" };
    this.#releaseIfClosed();
  }

  /** No fstat here: even a first-fstat failure must close its original read handle once. */
  beginReadClose(resource: OfficeLocalMemberReadResource, enteredAt: string): void {
    const state = this.#require(resource);
    if (resource.origin !== "member_read" || state.close.state !== "retained" || !timestamp(enteredAt)
      || enteredAt < resource.openReturnedAt) return invalid();
    state.close = { origin: "member_read", state: "unknown", closeEnteredAt: enteredAt };
  }

  /** Called only after the native read close returned; a throw never reaches this latch. */
  markReadClosed(resource: OfficeLocalMemberReadResource, returnedAt: string): void {
    const state = this.#require(resource);
    if (resource.origin !== "member_read" || state.close.origin !== "member_read" || state.close.state !== "unknown"
      || !timestamp(returnedAt) || returnedAt < state.close.closeEnteredAt) return invalid();
    state.close = { ...state.close, state: "closed", closeReturnedAt: returnedAt };
    this.#releaseIfClosed();
  }

  readSnapshot(resource: OfficeLocalMemberReadResource): OfficeLocalMemberReadResourceFinal {
    const result = this.#snapshot(resource, this.#require(resource));
    return result.origin === "member_read" ? result : invalid();
  }

  /** Internal original-owner handles eligible for bounded cleanup; never includes unknown close. */
  cleanupCandidates(): readonly OfficeLocalEffectResource[] {
    return [...this.#resources].flatMap(([resource, state]) => resource.origin === "effect" && state.close.state === "retained" ? [resource] : []);
  }

  snapshots(): readonly OfficeLocalResourceFinal[] {
    return Object.freeze([...this.#resources].map(([resource, state]) => this.#snapshot(resource, state)));
  }

  #snapshot(resource: OfficeLocalResource, state: ResourceState): OfficeLocalResourceFinal {
    const common = { memberId: resource.memberId, resourceLifetimeId: resource.resourceLifetimeId,
      ...(state.identity ? { identity: state.identity, identityObservedAt: state.identityObservedAt } : {}) };
    if (resource.origin === "effect" && state.close.origin === "effect") {
      return Object.freeze({ ...common, ...state.close, openEffectId: resource.openEffectId });
    }
    if (resource.origin === "member_read" && state.close.origin === "member_read") {
      return Object.freeze({ ...common, ...state.close, readId: resource.readId, purpose: resource.purpose,
        openCalledAt: resource.openCalledAt, openReturnedAt: resource.openReturnedAt,
        ...(state.identityObservedAt ? { identityObservedAt: state.identityObservedAt } : {}) });
    }
    return invalid();
  }

  #releaseIfClosed(): void {
    if ([...this.#resources.values()].every(item => item.close.state === "closed")) activeOwners.delete(this);
  }

  #require(resource: OfficeLocalResource): ResourceState {
    return this.#resources.get(resource) ?? invalid();
  }
}
