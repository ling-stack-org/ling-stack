import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { lstatSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { EffectiveRunPolicySnapshot, ExecutionSandboxBackendIdentity, RunSession, RunStore, RuntimeAttemptFenceV1 } from "@ling-stack/core";
import { captureProtectedHostStagePaths, type ProtectedHostStagePaths } from "./protected-host-stage-paths.js";
import { readMacosSandboxBackendIdentity, readPreparedMacosSandboxAuthority, isOwnedMacosSandboxChild,
  type PreparedMacosSandboxAuthority, type PreparedMacosSandboxCommand } from "./macos-native-command.js";
import { assertProtectedHostDomainExcludesStage, captureProtectedHostActorDomain,
  type ProtectedHostActorDomain } from "./protected-host-actor-domain.js";
import { readProtectedHostBootstrapReadRoots } from "./protected-host-bootstrap-domain.js";
import { ProtectedHostActorInventory, type ProtectedHostActorEntry } from "./protected-host-actor-inventory.js";
import { readOriginalProtectedHostActorEntries } from "./protected-host-original-entry-manifest.js";
import { readOriginalPackagedCodesignHostProof, type OriginalPackagedCodesignHostProof } from "./packaged-codesign-host-source.js";

declare const stageBrand: unique symbol;
declare const sourceBrand: unique symbol;
declare const actorBrand: unique symbol;
export interface ProtectedHostStageRegistration { readonly [stageBrand]: true }
export interface ProtectedHostActorSource { readonly [sourceBrand]: true }
export interface ProtectedHostActorPreparation { readonly [actorBrand]: true }
export interface ProtectedHostSourceInput {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly sourceFence: RuntimeAttemptFenceV1;
}
interface SourceState extends ProtectedHostSourceInput {
  readonly workspacePolicy: ReturnType<RunStore["getApprovalPolicy"]>;
}
interface ActorSourceState extends SourceState {
  readonly command: string;
  readonly toolCallId: string;
  readonly policy: EffectiveRunPolicySnapshot;
  compiledProtectedRoots?: readonly string[];
}
interface StageState {
  readonly source: SourceState;
  readonly paths: ProtectedHostStagePaths;
  readonly backend: ExecutionSandboxBackendIdentity;
  lifetime: "active" | "closed" | "unknown";
}
interface ActorState {
  readonly source: ActorSourceState;
  readonly prepared: PreparedMacosSandboxCommand;
  readonly authority: PreparedMacosSandboxAuthority;
  readonly domain: ProtectedHostActorDomain | undefined;
  phase: "prepared" | "launch_entered" | "launched" | "unknown";
}
const ownedRegistries = new WeakSet<ProtectedHostStageRegistry>();
const actorPreparedBindings = new WeakMap<ProtectedHostActorPreparation, {
  readonly registry: ProtectedHostStageRegistry; readonly prepared: PreparedMacosSandboxCommand;
}>();
function requireScope(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

/** The physical launcher must consume the exact original prepared actor, never a matching policy or another command's token. */
export function assertProtectedHostActorPreparedBinding(actor: ProtectedHostActorPreparation,
  prepared: PreparedMacosSandboxCommand): void {
  const binding = actorPreparedBindings.get(actor);
  requireScope(binding && ownedRegistries.has(binding.registry) && binding.prepared === prepared,
    "protected_host_actor_prepared_binding_invalid");
  binding.registry.assertActorLaunchCurrent(actor);
}
function assertPrivateStage(paths: ProtectedHostStagePaths): void {
  paths.assertCurrent();
  const stat = lstatSync(paths.stagePath);
  requireScope(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0,
    "protected_host_stage_not_private");
  paths.assertCurrent();
}

function captureSource(input: ProtectedHostSourceInput): SourceState {
  const state = { store: input.store, run: structuredClone(input.run), sourceFence: Object.freeze({ ...input.sourceFence }),
    workspacePolicy: structuredClone(input.store.getApprovalPolicy()) };
  assertSourceCurrent(state);
  return state;
}
function assertSourceCurrent(source: SourceState): void {
  source.store.readSnapshot(() => {
    const current = source.store.getRun(source.run.id);
    requireScope(current?.status === "running" && source.run.workUnitId === source.sourceFence.workUnitId
      && source.store.paths.cwd === source.run.cwd
      && source.store.isCurrentRunExecutionOwner(source.run.id, source.sourceFence)
      && ["cwd", "workUnitId", "taskId", "workflowStepId", "teammateId", "channelId", "threadId"].every(key =>
        current[key as keyof RunSession] === source.run[key as keyof RunSession])
      && isDeepStrictEqual(current.requestSnapshot, source.run.requestSnapshot)
      && isDeepStrictEqual(source.store.getApprovalPolicy(), source.workspacePolicy), "protected_host_source_obsolete");
  });
}

/** Controlled actors: data/map isolation and ancestor mutation protection, not metadata/path hiding.
 * No creator, Core safe or external same-UID promise. */
export class ProtectedHostStageRegistry {
  readonly #stages = new Map<ProtectedHostStageRegistration, StageState>();
  readonly #stageLifetimes = new WeakMap<ProtectedHostStageRegistration, StageState>();
  readonly #sources = new WeakMap<ProtectedHostActorSource, ActorSourceState>();
  readonly #actors = new WeakMap<ProtectedHostActorPreparation, ActorState>();
  readonly #inventory = new ProtectedHostActorInventory();
  readonly #hostBindingEpoch = Object.freeze({});
  #hostBindings = new Map<OriginalPackagedCodesignHostProof, {
    readonly entry: ProtectedHostActorEntry; readonly epoch: object; readonly domain: ProtectedHostActorDomain;
  }>();
  #domain: ProtectedHostActorDomain | undefined;
  #coverageClosed = false;
  constructor() { ownedRegistries.add(this); }
  assertHostStageSourceCurrent(input: ProtectedHostSourceInput): void { captureSource(input); }

  /** Supervisor supplies exact original module exports, not installed/verified caller flags. */
  bindOriginalActorEntries(entries: readonly ProtectedHostActorEntry[]): void {
    this.#inventory.bindOriginalEntries(entries, this);
  }
  markActorEntryCoverageUnknown(): void { this.#coverageClosed = true; }
  assertActorInventoryCurrent(): void {
    this.#inventory.assertOriginalSourceManifest(readOriginalProtectedHostActorEntries());
    requireScope(!this.#coverageClosed, "protected_host_actor_coverage_unknown");
  }
  /** Gate runs in the source-owned wrapper immediately before its captured native producer. */
  assertActorEntryLaunchCurrent(entry: ProtectedHostActorEntry, actor?: ProtectedHostActorPreparation, launchEntered = true): void {
    const facts = this.#inventory.assertOriginal(entry);
    if (facts.kind !== "controlled") return;
    if (actor) {
      requireScope(facts.entryId === "macos_native_command", "protected_host_actor_entry_proof_invalid");
      this.assertActorLaunchCurrent(actor); return;
    }
    // A refused launch has not created an unknown descendant. With no stage,
    // ordinary execution remains usable, regardless of lifetime command count.
    requireScope(this.#stages.size === 0, "protected_host_actor_unbound_with_active_stage");
    if (launchEntered) this.#coverageClosed = true;
  }

  /** Read-only aggregate preflight. Canonical proof identity substitutes no Run/DB authority. */
  assertOriginalHostProofBatch(histories: readonly {
    readonly entry: ProtectedHostActorEntry; readonly proof: OriginalPackagedCodesignHostProof;
  }[]): void { this.#previewOriginalHostProofBatch(histories); }

  /** Commit only retained source custody. Compute every value before either field mutates. */
  commitOriginalHostProofBatch(histories: readonly {
    readonly entry: ProtectedHostActorEntry; readonly proof: OriginalPackagedCodesignHostProof;
  }[]): void {
    const merged = this.#previewOriginalHostProofBatch(histories), next = new Map(this.#hostBindings);
    for (const { entry, proof } of histories) {
      this.#inventory.assertOriginal(entry);
      const facts = readOriginalPackagedCodesignHostProof(entry, proof);
      requireScope(facts.phase === "retained", "protected_host_actor_prepared_binding_invalid");
      next.set(proof, Object.freeze({ entry, epoch: this.#hostBindingEpoch, domain: facts.domain }));
    }
    this.#hostBindings = next;
    this.#domain = merged;
  }
  #previewOriginalHostProofBatch(histories: readonly {
    readonly entry: ProtectedHostActorEntry; readonly proof: OriginalPackagedCodesignHostProof;
  }[]): ProtectedHostActorDomain | undefined {
    this.#assertOriginalHostHistoryCurrent();
    requireScope(new Set(histories.map(row => row.proof)).size === histories.length,
      "protected_host_actor_prepared_binding_invalid");
    const roots = new Set(this.#domain?.staticReadRoots ?? []);
    let backend = this.#domain?.backend;
    for (const { entry, proof } of histories) {
      const facts = readOriginalPackagedCodesignHostProof(entry, proof);
      requireScope(facts.entryId === "packaged_codesign" && (!backend || isDeepStrictEqual(backend, facts.domain.backend)),
        "protected_host_backend_changed");
      backend ??= facts.domain.backend;
      for (const root of facts.domain.staticReadRoots) roots.add(root);
    }
    requireScope(roots.size <= 128 && this.#hostBindings.size + histories.filter(row => !this.#hostBindings.has(row.proof)).length <= 16,
      "protected_host_actor_coverage_unknown");
    const merged = backend ? Object.freeze({ backend, staticReadRoots: Object.freeze([...roots]) }) : undefined;
    if (merged) for (const stage of this.#stages.values()) {
      this.#assertStage(stage); assertProtectedHostDomainExcludesStage(merged, stage.paths);
    }
    return merged;
  }
  #assertOriginalHostHistoryCurrent(): void {
    try {
      for (const [proof, binding] of this.#hostBindings) {
        const facts = readOriginalPackagedCodesignHostProof(binding.entry, proof);
        requireScope(binding.epoch === this.#hostBindingEpoch && facts.phase === "retained" && facts.domain === binding.domain,
          "protected_host_actor_prepared_binding_invalid");
      }
    } catch (error) { this.#coverageClosed = true; throw error; }
  }

  /** Only register an existing Host stage: this slice neither creates it nor deletes any pathname. */
  registerStage(input: ProtectedHostSourceInput & { readonly stagePath: string }): ProtectedHostStageRegistration {
    const source = captureSource(input), paths = captureProtectedHostStagePaths(input.stagePath);
    try {
      requireScope(this.#stages.size < 64, "protected_host_stage_budget_exceeded");
      requireScope(!this.#coverageClosed, "protected_host_actor_coverage_unknown");
      this.#assertOriginalHostHistoryCurrent();
      assertSourceCurrent(source); assertPrivateStage(paths);
      const backend = readMacosSandboxBackendIdentity();
      const implicitRoots = readProtectedHostBootstrapReadRoots(backend);
      if (this.#domain) requireScope(isDeepStrictEqual(this.#domain.backend, backend), "protected_host_backend_changed");
      const state: StageState = { source, paths, backend, lifetime: "active" };
      assertProtectedHostDomainExcludesStage(this.#domain ?? { backend, staticReadRoots: implicitRoots }, paths);
      const registration = Object.freeze({}) as ProtectedHostStageRegistration;
      this.#stages.set(registration, state);
      this.#stageLifetimes.set(registration, state);
      return registration;
    } catch (error) {
      try { paths.close(); } catch (closeError) { throw new AggregateError([error, closeError], "protected_host_stage_registration_unknown"); }
      throw error;
    }
  }

  /** Private DB-backed source token, not the caller's replaceable authority callback. */
  captureActorSource(input: ProtectedHostSourceInput & { readonly command: string; readonly toolCallId: string }): ProtectedHostActorSource {
    const source = captureSource(input), request = source.run.requestSnapshot as Record<string, unknown>;
    const policy = request?.effectivePolicySnapshot;
    requireScope(policy && typeof policy === "object" && input.command && input.toolCallId, "protected_host_actor_source_invalid");
    const effective = structuredClone(policy) as EffectiveRunPolicySnapshot;
    requireScope(effective.workspacePolicyUpdatedAt === source.workspacePolicy.updatedAt
      && source.workspacePolicy.toolDecisions.bash !== "deny" && effective.toolDecisions?.bash !== "deny",
      "protected_host_actor_policy_obsolete");
    const token = Object.freeze({}) as ProtectedHostActorSource;
    this.#sources.set(token, { ...source, command: input.command, toolCallId: input.toolCallId,
      policy: effective });
    return token;
  }

  assertActorSource(source: ProtectedHostActorSource, input: {
    readonly command: string; readonly cwd: string; readonly policy: EffectiveRunPolicySnapshot;
    readonly source: RuntimeAttemptFenceV1 & { readonly workspaceId: string; readonly runId: string; readonly toolCallId: string };
  }): void {
    const state = this.#source(source);
    assertSourceCurrent(state);
    requireScope(state.command === input.command && state.run.cwd === input.cwd && state.toolCallId === input.source.toolCallId
      && state.run.id === input.source.runId && state.workspacePolicy.workspaceId === input.source.workspaceId
      && Object.entries(state.sourceFence).every(([key, value]) => input.source[key as keyof typeof input.source] === value)
      && isDeepStrictEqual(state.policy, input.policy), "protected_host_actor_binding_invalid");
  }

  /** Capture currently active deny roots before compilation; no serialized root list becomes authority. */
  protectedRoots(source: ProtectedHostActorSource): readonly string[] {
    const state = this.#source(source);
    assertSourceCurrent(state);
    const roots = Object.freeze([...this.#stages.values()].map(stage => {
      this.#assertStage(stage); return stage.paths.stagePath;
    }));
    state.compiledProtectedRoots = roots;
    return roots;
  }

  bindPreparedActor(source: ProtectedHostActorSource, prepared: PreparedMacosSandboxCommand): ProtectedHostActorPreparation {
    const state = this.#source(source), authority = readPreparedMacosSandboxAuthority(prepared);
    assertSourceCurrent(state);
    const binding = authority.policy.binding;
    requireScope(authority.policy.executionMode === "native_required" && authority.policy.backend?.kind === "macos_seatbelt"
      && binding.workspaceId === state.workspacePolicy.workspaceId && binding.runId === state.run.id
      && binding.toolCallId === state.toolCallId
      && Object.entries(state.sourceFence).every(([key, value]) => binding[key as keyof typeof binding] === value),
    "protected_host_actor_binding_invalid");
    let domain: ProtectedHostActorDomain | undefined;
    try {
      requireScope(state.compiledProtectedRoots, "protected_host_actor_domain_unverified");
      domain = captureProtectedHostActorDomain(authority, { origin: state.run.cwd,
        effectivePolicy: state.policy, protectedRoots: state.compiledProtectedRoots });
      const roots = [...new Set([...(this.#domain?.staticReadRoots ?? []), ...domain.staticReadRoots])];
      requireScope(roots.length <= 128 && (!this.#domain || isDeepStrictEqual(this.#domain.backend, domain.backend)),
        "protected_host_actor_coverage_unknown");
      const merged = Object.freeze({ backend: domain.backend, staticReadRoots: Object.freeze(roots) });
      for (const stage of this.#stages.values()) {
        this.#assertStage(stage); assertProtectedHostDomainExcludesStage(merged, stage.paths);
      }
      this.#domain = merged;
    } catch (error) {
      // These facts can close Office protection, never grant execution or impose a no-stage command count limit.
      if (this.#stages.size) throw error;
      this.#coverageClosed = true;
      domain = undefined;
    }
    const actor: ActorState = { source: state, prepared, authority, domain, phase: "prepared" };
    const token = Object.freeze({}) as ProtectedHostActorPreparation;
    this.#actors.set(token, actor);
    actorPreparedBindings.set(token, Object.freeze({ registry: this, prepared }));
    return token;
  }

  /** Before both launcher entry and native spawn; prepared actors also constrain later stage registration. */
  assertActorLaunchCurrent(token: ProtectedHostActorPreparation): void {
    const actor = this.#actor(token);
    requireScope(actor.phase === "prepared" || actor.phase === "launch_entered", "protected_host_actor_launch_closed");
    assertSourceCurrent(actor.source);
    requireScope(readPreparedMacosSandboxAuthority(actor.prepared) === actor.authority
      && isDeepStrictEqual(readMacosSandboxBackendIdentity(), actor.authority.backend), "protected_host_backend_changed");
    if (actor.domain) {
      try {
        const current = captureProtectedHostActorDomain(actor.authority, { origin: actor.source.run.cwd,
          effectivePolicy: actor.source.policy, protectedRoots: actor.source.compiledProtectedRoots ?? [] });
        requireScope(isDeepStrictEqual(current, actor.domain), "protected_host_actor_domain_unverified");
      } catch (error) {
        if (this.#stages.size) throw error;
        this.#coverageClosed = true;
      }
    }
    for (const stage of this.#stages.values()) {
      this.#assertStage(stage);
      requireScope(actor.domain, "protected_host_actor_coverage_unknown");
      assertProtectedHostDomainExcludesStage(actor.domain, stage.paths);
    }
  }
  beginActorLaunch(token: ProtectedHostActorPreparation): void {
    this.assertActorLaunchCurrent(token);
    const actor = this.#actor(token);
    requireScope(actor.phase === "prepared", "protected_host_actor_launch_closed");
    actor.phase = "launch_entered";
  }
  recordActorLaunched(token: ProtectedHostActorPreparation, child: ChildProcessWithoutNullStreams): void {
    const actor = this.#actor(token);
    requireScope(actor.phase === "launch_entered" && isOwnedMacosSandboxChild(child, actor.prepared), "protected_host_actor_launch_unknown");
    actor.phase = "launched";
  }
  markActorLaunchUnknown(token: ProtectedHostActorPreparation): void {
    this.#actor(token).phase = "unknown";
    this.#coverageClosed = true;
  }

  assertStageCurrent(token: ProtectedHostStageRegistration): void {
    const stage = this.#stageLifetimes.get(token);
    requireScope(stage, "protected_host_stage_registration_invalid");
    this.#assertStage(stage);
    if (this.#domain) assertProtectedHostDomainExcludesStage(this.#domain, stage.paths);
  }
  readStageIdentityFacts(token: ProtectedHostStageRegistration): ReturnType<ProtectedHostStagePaths["identityFacts"]> {
    this.assertStageCurrent(token);
    return this.#stageLifetimes.get(token)!.paths.identityFacts();
  }
  /** Irreversible closure first; source/policy/admission changes cannot block the original readonly FD closes. */
  closeStage(token: ProtectedHostStageRegistration): void {
    const stage = this.#stageLifetimes.get(token);
    requireScope(stage, "protected_host_stage_registration_invalid");
    if (stage.lifetime === "closed") return;
    requireScope(stage.lifetime === "active", "protected_host_stage_close_unknown");
    stage.lifetime = "unknown";
    this.#stages.delete(token);
    stage.paths.close();
    stage.lifetime = "closed";
  }
  #source(token: ProtectedHostActorSource): ActorSourceState {
    const source = this.#sources.get(token);
    requireScope(source, "protected_host_actor_source_invalid");
    return source;
  }
  #actor(token: ProtectedHostActorPreparation): ActorState {
    const actor = this.#actors.get(token);
    requireScope(actor, "protected_host_actor_preparation_invalid");
    return actor;
  }
  #assertStage(stage: StageState): void {
    requireScope(stage.lifetime === "active", "protected_host_stage_closed");
    requireScope(!this.#coverageClosed, "protected_host_actor_coverage_unknown");
    this.#assertOriginalHostHistoryCurrent();
    requireScope(isDeepStrictEqual(readMacosSandboxBackendIdentity(), stage.backend), "protected_host_backend_changed");
    readProtectedHostBootstrapReadRoots(stage.backend);
    assertSourceCurrent(stage.source); assertPrivateStage(stage.paths);
  }
}
export function isProtectedHostStageRegistry(value: unknown): value is ProtectedHostStageRegistry {
  return typeof value === "object" && value !== null && ownedRegistries.has(value as ProtectedHostStageRegistry);
}
