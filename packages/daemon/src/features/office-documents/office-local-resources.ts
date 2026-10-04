import { fstatSync } from "node:fs";
import type { HostOfficeFileIdentity, HostOperationSource } from "@ling-stack/core";
import { officeFileIdentity, sameOfficeNode } from "./office-local-members.js";

declare const resourceBrand: unique symbol;
/** Private live reference. Serialized metadata and a reused FD number are not capabilities. */
export interface OfficeLocalResource {
  readonly memberId: string;
  readonly resourceLifetimeId: string;
  readonly openEffectId: string;
  readonly fd: number;
  readonly [resourceBrand]: true;
}
export interface OfficeLocalResourceFinal {
  readonly memberId: string;
  readonly resourceLifetimeId: string;
  readonly openEffectId: string;
  readonly closeEffectId?: string;
  readonly identity?: HostOfficeFileIdentity;
  readonly state: "closed" | "retained" | "unknown";
}
interface ResourceState {
  identity?: HostOfficeFileIdentity;
  closeEffectId?: string;
  state: OfficeLocalResourceFinal["state"];
}

// Strongly own every unclosed execution even when the plan/caller is collected.
// Unknown close outcomes are retained as blockers, never retried by FD number.
const activeOwners = new Set<OfficeLocalResourceOwner>();
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 4096 && !value.includes("\0");
const invalid = (): never => { throw Object.assign(new Error("office_local_resource_invalid"), { code: "office_local_resource_invalid" }); };

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
    readonly openEffectId: string; readonly fd: number }): OfficeLocalResource {
    if (![input.resourceLifetimeId, input.memberId, input.openEffectId].every(validId)
      || !Number.isSafeInteger(input.fd) || input.fd < 0 || this.#lifetimes.has(input.resourceLifetimeId)) invalid();
    const resource = Object.freeze({ ...input }) as OfficeLocalResource;
    this.#lifetimes.add(resource.resourceLifetimeId);
    this.#resources.set(resource, { state: "retained" });
    activeOwners.add(this);
    return resource;
  }

  /** Guard a still-owned resource. A prior close call forbids even a fresh fstat. */
  assertUsable(resource: OfficeLocalResource): HostOfficeFileIdentity {
    const state = this.#require(resource);
    if (state.state !== "retained" || state.closeEffectId !== undefined) return invalid();
    const identity = officeFileIdentity(fstatSync(resource.fd, { bigint: true }));
    if (state.identity && !sameOfficeNode(state.identity, identity)) return invalid();
    state.identity ??= identity;
    return identity;
  }

  /** Fixed writer calls this immediately before its one native close invocation. */
  beginClose(resource: OfficeLocalResource, closeEffectId: string): void {
    const state = this.#require(resource);
    if (!validId(closeEffectId) || state.state !== "retained" || state.closeEffectId !== undefined) invalid();
    state.closeEffectId = closeEffectId;
    state.state = "unknown";
  }

  /** Only the fixed writer's actual close-return point may mark the resource closed. */
  markClosed(resource: OfficeLocalResource): void {
    const state = this.#require(resource);
    if (state.state !== "unknown" || state.closeEffectId === undefined) invalid();
    state.state = "closed";
    if ([...this.#resources.values()].every(item => item.state === "closed")) activeOwners.delete(this);
  }

  /** Internal original-owner handles eligible for bounded cleanup; never includes unknown close. */
  cleanupCandidates(): readonly OfficeLocalResource[] {
    return [...this.#resources].filter(([, state]) => state.state === "retained").map(([resource]) => resource);
  }

  snapshots(): readonly OfficeLocalResourceFinal[] {
    return Object.freeze([...this.#resources].map(([resource, state]) => Object.freeze({ memberId: resource.memberId,
      resourceLifetimeId: resource.resourceLifetimeId, openEffectId: resource.openEffectId,
      ...(state.closeEffectId ? { closeEffectId: state.closeEffectId } : {}),
      ...(state.identity ? { identity: state.identity } : {}), state: state.state })));
  }

  #require(resource: OfficeLocalResource): ResourceState {
    return this.#resources.get(resource) ?? invalid();
  }
}
