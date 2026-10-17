import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { lstatSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { EffectiveRunPolicySnapshot, ExecutionSandboxBackendIdentity, HostOfficeLocalDirectoryExecutionRecordV2,
  RunSession, RunStore, RuntimeAttemptFenceV1 } from "@ling-stack/core";
import { captureProtectedHostStagePaths, type ProtectedHostStagePaths } from "./protected-host-stage-paths.js";
import { readMacosSandboxBackendIdentity, readPreparedMacosSandboxAuthority, isOwnedMacosSandboxChild,
  MACOS_NATIVE_COMMAND_ACTOR_ENTRY, type PreparedMacosSandboxAuthority,
  type PreparedMacosSandboxCommand } from "./macos-native-command.js";
import { assertProtectedHostDomainExcludesStage, captureProtectedHostActorDomain,
  type ProtectedHostActorDomain } from "./protected-host-actor-domain.js";
import { readProtectedHostBootstrapReadRoots } from "./protected-host-bootstrap-domain.js";
import { ProtectedHostActorInventory, readOriginalProtectedHostActorDomainHistory,
  type ProtectedHostActorEntry, type OriginalProtectedHostActorDomainHistory } from "./protected-host-actor-inventory.js";
import { readOriginalProtectedHostActorEntries } from "./protected-host-original-entry-manifest.js";
import { readOriginalPackagedCodesignHostProof, type OriginalPackagedCodesignHostProof } from "./packaged-codesign-host-source.js";
import { captureOriginalOfficeDirectoryWindowPaths, type OriginalOfficeDirectoryWindowPaths,
  type OriginalOfficeDirectoryWindowPathClosure } from "./protected-host-office-directory-window.js";
import { readOriginalOfficeDirectoryRuntimeReleasePermitV2, consumeOriginalOfficeDirectoryRuntimeReleasePermitV2,
  type OriginalOfficeDirectoryRuntimeReleasePermitV2 } from "../../features/office-documents/office-local-native-runtime.js";

declare const stageBrand: unique symbol;
declare const sourceBrand: unique symbol;
declare const actorBrand: unique symbol;
declare const officeWindowBrand: unique symbol;
export interface ProtectedHostStageRegistration { readonly [stageBrand]: true }
export interface ProtectedHostActorSource { readonly [sourceBrand]: true }
export interface ProtectedHostActorPreparation { readonly [actorBrand]: true }
export interface ProtectedHostOfficeDirectoryWindowV2 { readonly [officeWindowBrand]: true }
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
  lifetime: "active" | "close_entered" | "closed_pending" | "closed" | "unknown";
  officeAdmission?: "binding_entered" | "bound" | "cleanup_entered" | "invalid";
  officeWindow?: OfficeWindowState;
}
interface OfficeWindowState {
  readonly registration: ProtectedHostStageRegistration;
  readonly stage: StageState;
  readonly execution: HostOfficeLocalDirectoryExecutionRecordV2;
  readonly paths: OriginalOfficeDirectoryWindowPaths;
  readonly epoch: object;
}
interface OfficeLeaseReleaseHistory {
  readonly window: ProtectedHostOfficeDirectoryWindowV2;
  readonly state: OfficeWindowState;
}
interface ActorState {
  readonly source: ActorSourceState;
  readonly prepared: PreparedMacosSandboxCommand;
  readonly authority: PreparedMacosSandboxAuthority;
  readonly domain: ProtectedHostActorDomain | undefined;
  phase: "prepared" | "launch_entered" | "launched" | "unknown";
}
interface ExternalWorkflowRequestActorState {
  readonly prepared: object;
  readonly domain: ProtectedHostActorDomain;
  phase: "prepared" | "launch_entered" | "launched" | "closed" | "unknown";
}
const ownedRegistries = new WeakSet<ProtectedHostStageRegistry>();
const activeExternalWorkflowRequestActors = new Set<ProtectedHostActorPreparation>();
const activeProtectedHostStages = new Set<ProtectedHostStageRegistration>();
const officeLeaseReleasesInProgress = new WeakSet<OriginalOfficeDirectoryRuntimeReleasePermitV2>();
const originalOfficeRegistryReaders = new WeakMap<ProtectedHostStageRegistry, Readonly<{
  assertStage: (stage: ProtectedHostStageRegistration) => void;
  begin: (stage: ProtectedHostStageRegistration, expected: HostOfficeLocalDirectoryExecutionRecordV2) => ProtectedHostOfficeDirectoryWindowV2;
  assertWindow: (window: ProtectedHostOfficeDirectoryWindowV2, expected: HostOfficeLocalDirectoryExecutionRecordV2) => void;
  closeWindow: (window: ProtectedHostOfficeDirectoryWindowV2) => void;
  readClosure: (window: ProtectedHostOfficeDirectoryWindowV2) => OriginalOfficeDirectoryWindowPathClosure;
  releaseLease: (permit: OriginalOfficeDirectoryRuntimeReleasePermitV2) => void;
  assertLeaseReleased: (permit: OriginalOfficeDirectoryRuntimeReleasePermitV2) => void;
}>>();
const actorPreparedBindings = new WeakMap<ProtectedHostActorPreparation, {
  readonly registry: ProtectedHostStageRegistry;
  readonly entry: ProtectedHostActorEntry;
  readonly prepared: object;
  readonly readDomain: () => ProtectedHostActorDomain | undefined;
}>();
const originalActorRegistryReaders = new WeakMap<ProtectedHostStageRegistry, Readonly<{
  readDomain: (actor: ProtectedHostActorPreparation, prepared: PreparedMacosSandboxCommand) => ProtectedHostActorDomain | undefined;
  assertHistory: (entry: ProtectedHostActorEntry, history: OriginalProtectedHostActorDomainHistory) => void;
  commitHistory: (entry: ProtectedHostActorEntry, history: OriginalProtectedHostActorDomainHistory) => void;
  assertEnrollment: (hosts: readonly { entry: ProtectedHostActorEntry; proof: OriginalPackagedCodesignHostProof }[],
    actors: readonly { entry: ProtectedHostActorEntry; history: OriginalProtectedHostActorDomainHistory }[]) => void;
}>>();
function requireScope(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

/** The physical launcher must consume the exact original prepared actor, never a matching policy or another command's token. */
export function assertProtectedHostActorPreparedBinding(actor: ProtectedHostActorPreparation,
  prepared: PreparedMacosSandboxCommand): void {
  const binding = actorPreparedBindings.get(actor);
  requireScope(binding && binding.entry === MACOS_NATIVE_COMMAND_ACTOR_ENTRY
    && ownedRegistries.has(binding.registry) && binding.prepared === prepared,
    "protected_host_actor_prepared_binding_invalid");
  readOriginalProtectedHostActorLaunchDomain(actor);
}

/** The fixed request launcher consumes only the exact request preparation owned by the original registry. */
export function assertProtectedHostExternalWorkflowRequestBinding(actor: ProtectedHostActorPreparation,
  prepared: object): void {
  const binding = actorPreparedBindings.get(actor);
  requireScope(binding && binding.entry.entryId === "external_workflow_request"
    && ownedRegistries.has(binding.registry) && binding.prepared === prepared,
  "protected_host_actor_prepared_binding_invalid");
  readOriginalProtectedHostActorLaunchDomain(actor);
}

/** Read original launcher facts without transferring the owning Run/source capability to another Registry. */
export function readOriginalProtectedHostActorLaunchDomain(actor: ProtectedHostActorPreparation,
  entry?: ProtectedHostActorEntry): ProtectedHostActorDomain | undefined {
  const binding = actorPreparedBindings.get(actor);
  requireScope(binding && ownedRegistries.has(binding.registry), "protected_host_actor_preparation_invalid");
  if (entry) requireScope(entry === binding.entry, "protected_host_actor_entry_proof_invalid");
  return binding.readDomain();
}

/** Source-owned aggregate history uses constructor-private readers, never replacement public methods. */
export function assertOriginalProtectedHostActorDomainHistoryCurrent(registry: ProtectedHostStageRegistry,
  entry: ProtectedHostActorEntry, history: OriginalProtectedHostActorDomainHistory): void {
  const original = originalActorRegistryReaders.get(registry);
  requireScope(original, "protected_host_registry_invalid");
  original.assertHistory(entry, history);
}
export function commitOriginalProtectedHostActorDomainHistory(registry: ProtectedHostStageRegistry,
  entry: ProtectedHostActorEntry, history: OriginalProtectedHostActorDomainHistory): void {
  const original = originalActorRegistryReaders.get(registry);
  requireScope(original, "protected_host_registry_invalid");
  original.commitHistory(entry, history);
}
export function assertOriginalProtectedHostActorHistoryEnrollment(registry: ProtectedHostStageRegistry,
  hosts: readonly { entry: ProtectedHostActorEntry; proof: OriginalPackagedCodesignHostProof }[],
  actors: readonly { entry: ProtectedHostActorEntry; history: OriginalProtectedHostActorDomainHistory }[]): void {
  const original = originalActorRegistryReaders.get(registry);
  requireScope(original, "protected_host_registry_invalid");
  original.assertEnrollment(hosts, actors);
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
  readonly #externalWorkflowRequestActors = new WeakMap<ProtectedHostActorPreparation, ExternalWorkflowRequestActorState>();
  readonly #inventory = new ProtectedHostActorInventory();
  readonly #officeWindows = new WeakMap<ProtectedHostOfficeDirectoryWindowV2, OfficeWindowState>();
  readonly #officeLeaseReleaseHistory = new WeakMap<OriginalOfficeDirectoryRuntimeReleasePermitV2, OfficeLeaseReleaseHistory>();
  readonly #hostBindingEpoch = Object.freeze({});
  #hostBindings = new Map<OriginalPackagedCodesignHostProof, {
    readonly entry: ProtectedHostActorEntry; readonly epoch: object; readonly domain: ProtectedHostActorDomain;
  }>();
  #domain: ProtectedHostActorDomain | undefined;
  #domainEpoch = Object.freeze({});
  #coverageClosed = false;
  constructor() {
    ownedRegistries.add(this);
    originalActorRegistryReaders.set(this, Object.freeze({
      readDomain: (actor, prepared) => {
        requireScope(this.#actor(actor).prepared === prepared, "protected_host_actor_prepared_binding_invalid");
        return this.#assertActorLaunchCurrent(actor);
      },
      assertHistory: (entry, history) => { this.#previewOriginalActorDomainHistory(entry, history); },
      commitHistory: (entry, history) => {
        const epoch = this.#domainEpoch;
        const domain = this.#previewOriginalActorDomainHistory(entry, history);
        if (domain) this.#commitDomain(domain, epoch);
        else this.#coverageClosed = true;
      },
      assertEnrollment: (hosts, actors) => {
        let domain = this.#previewOriginalHostProofBatch(hosts);
        for (const row of actors) domain = this.#previewOriginalActorDomainHistory(row.entry, row.history, false, domain);
      },
    }));
    // Capture private implementations, not replaceable instance methods. No caller
    // can install an inventory reader or inject a destination-path/window object.
    originalOfficeRegistryReaders.set(this, Object.freeze({
      assertStage: stage => this.#assertOriginalOfficeStage(stage),
      begin: (stage, expected) => this.#beginOfficeWindow(stage, expected),
      assertWindow: (window, expected) => this.#assertOfficeWindow(window, expected),
      closeWindow: window => this.#closeOfficeWindow(window),
      readClosure: window => this.#officeWindow(window).paths.readClosureFacts(),
      releaseLease: permit => this.#releaseOfficeLease(permit),
      assertLeaseReleased: permit => this.#assertOfficeLeaseReleased(permit),
    }));
  }
  assertHostStageSourceCurrent(input: ProtectedHostSourceInput): void { captureSource(input); }

  /** Supervisor supplies exact original module exports, not installed/verified caller flags. */
  bindOriginalActorEntries(entries: readonly ProtectedHostActorEntry[]): void {
    this.#inventory.bindOriginalEntries(entries, this);
  }
  markActorEntryCoverageUnknown(): void { this.#coverageClosed = true; }
  assertActorInventoryCurrent(): void {
    this.#assertActorInventoryCurrent();
  }
  #assertActorInventoryCurrent(): void {
    this.#inventory.assertOriginalSourceManifest(readOriginalProtectedHostActorEntries());
    requireScope(!this.#coverageClosed, "protected_host_actor_coverage_unknown");
  }
  /** Gate runs in the source-owned wrapper immediately before its captured native producer. */
  assertActorEntryLaunchCurrent(entry: ProtectedHostActorEntry, actor?: ProtectedHostActorPreparation, launchEntered = true): void {
    const facts = this.#inventory.assertOriginal(entry);
    if (facts.kind !== "controlled") return;
    if (facts.entryId === "external_workflow_request") {
      requireScope(actor, "protected_host_actor_entry_proof_invalid");
      const domain = readOriginalProtectedHostActorLaunchDomain(actor, entry);
      requireScope(domain, "protected_host_actor_domain_unverified");
      for (const stage of this.#stages.values()) {
        this.#assertStage(stage); this.#assertStageExclusion(domain, stage);
      }
      return;
    }
    if (actor) {
      requireScope(facts.entryId === "macos_native_command", "protected_host_actor_entry_proof_invalid");
      this.#assertActorLaunchCurrent(actor); return;
    }
    // A refused launch has not created an unknown descendant. With no stage,
    // ordinary execution remains usable, regardless of lifetime command count.
    requireScope(this.#stages.size === 0, "protected_host_actor_unbound_with_active_stage");
    if (launchEntered) this.#coverageClosed = true;
  }

  #previewOriginalActorDomainHistory(entry: ProtectedHostActorEntry,
    history: OriginalProtectedHostActorDomainHistory, assertBound = true,
    previousDomain: ProtectedHostActorDomain | undefined = this.#domain): ProtectedHostActorDomain | undefined {
    if (assertBound) this.#inventory.assertOriginal(entry);
    const domain = readOriginalProtectedHostActorDomainHistory(entry, history);
    if (!domain) {
      requireScope(this.#stages.size === 0, "protected_host_actor_coverage_unknown");
      return undefined;
    }
    const roots = [...new Set([...(previousDomain?.staticReadRoots ?? []), ...domain.staticReadRoots])];
    requireScope(roots.length <= 128 && (!previousDomain || isDeepStrictEqual(previousDomain.backend, domain.backend)),
      "protected_host_actor_coverage_unknown");
    const merged = Object.freeze({ backend: domain.backend, staticReadRoots: Object.freeze(roots) });
    for (const stage of this.#stages.values()) {
      this.#assertStage(stage); this.#assertStageExclusion(merged, stage);
    }
    return merged;
  }
  #commitDomain(domain: ProtectedHostActorDomain | undefined, epoch: object): void {
    requireScope(epoch === this.#domainEpoch, "protected_host_actor_history_changed");
    this.#domain = domain;
    this.#domainEpoch = Object.freeze({});
  }

  /** Read-only aggregate preflight. Canonical proof identity substitutes no Run/DB authority. */
  assertOriginalHostProofBatch(histories: readonly {
    readonly entry: ProtectedHostActorEntry; readonly proof: OriginalPackagedCodesignHostProof;
  }[]): void { this.#previewOriginalHostProofBatch(histories); }

  /** Commit only retained source custody. Compute every value before either field mutates. */
  commitOriginalHostProofBatch(histories: readonly {
    readonly entry: ProtectedHostActorEntry; readonly proof: OriginalPackagedCodesignHostProof;
  }[]): void {
    const epoch = this.#domainEpoch;
    const merged = this.#previewOriginalHostProofBatch(histories), next = new Map(this.#hostBindings);
    for (const { entry, proof } of histories) {
      this.#inventory.assertOriginal(entry);
      const facts = readOriginalPackagedCodesignHostProof(entry, proof);
      requireScope(facts.phase === "retained", "protected_host_actor_prepared_binding_invalid");
      next.set(proof, Object.freeze({ entry, epoch: this.#hostBindingEpoch, domain: facts.domain }));
    }
    this.#commitDomain(merged, epoch);
    this.#hostBindings = next;
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
      this.#assertStage(stage); this.#assertStageExclusion(merged, stage);
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
    requireScope(activeExternalWorkflowRequestActors.size === 0, "protected_host_request_actor_active");
    const source = captureSource(input), paths = captureProtectedHostStagePaths(input.stagePath);
    try {
      requireScope(this.#stages.size < 64, "protected_host_stage_budget_exceeded");
      requireScope(activeExternalWorkflowRequestActors.size === 0, "protected_host_request_actor_active");
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
      activeProtectedHostStages.add(registration);
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
    const roots = Object.freeze([...this.#stages.values()].flatMap(stage => {
      this.#assertStage(stage);
      return stage.officeWindow ? [stage.paths.stagePath, stage.officeWindow.paths.destination.stagePath] : [stage.paths.stagePath];
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
      const epoch = this.#domainEpoch;
      requireScope(state.compiledProtectedRoots, "protected_host_actor_domain_unverified");
      domain = captureProtectedHostActorDomain(authority, { origin: state.run.cwd,
        effectivePolicy: state.policy, protectedRoots: state.compiledProtectedRoots });
      const roots = [...new Set([...(this.#domain?.staticReadRoots ?? []), ...domain.staticReadRoots])];
      requireScope(roots.length <= 128 && (!this.#domain || isDeepStrictEqual(this.#domain.backend, domain.backend)),
        "protected_host_actor_coverage_unknown");
      const merged = Object.freeze({ backend: domain.backend, staticReadRoots: Object.freeze(roots) });
      for (const stage of this.#stages.values()) {
        this.#assertStage(stage); this.#assertStageExclusion(merged, stage);
      }
      this.#commitDomain(merged, epoch);
    } catch (error) {
      // These facts can close Office protection, never grant execution or impose a no-stage command count limit.
      if (this.#stages.size) throw error;
      this.#coverageClosed = true;
      domain = undefined;
    }
    const actor: ActorState = { source: state, prepared, authority, domain, phase: "prepared" };
    const token = Object.freeze({}) as ProtectedHostActorPreparation;
    this.#actors.set(token, actor);
    actorPreparedBindings.set(token, Object.freeze({ registry: this, entry: MACOS_NATIVE_COMMAND_ACTOR_ENTRY, prepared,
      readDomain: () => originalActorRegistryReaders.get(this)!.readDomain(token, prepared) }));
    return token;
  }

  /**
   * Request-scoped actor lease. It is not a Run/Attempt source and grants no tool permission.
   * The exact source-owned launcher still gates the one physical process; while the request is
   * live, every registry refuses a new protected stage.
   */
  bindExternalWorkflowRequestActor(prepared: object, domain: ProtectedHostActorDomain,
    entry: ProtectedHostActorEntry): ProtectedHostActorPreparation {
    requireScope(prepared && typeof prepared === "object" && domain && typeof domain === "object",
      "protected_host_actor_preparation_invalid");
    requireScope(this.#inventory.assertOriginal(entry).entryId === "external_workflow_request",
      "protected_host_actor_entry_proof_invalid");
    requireScope(activeExternalWorkflowRequestActors.size === 0 && activeProtectedHostStages.size === 0,
      "protected_host_request_actor_busy");
    // Request isolation protects the workspace operation itself and is mutually
    // exclusive with live protected stages. Historical coverage from unrelated
    // fixed Host actors (for example Keychain status probes) is not a workspace
    // safety authority and must not permanently disable this request-scoped lane.
    this.#inventory.assertOriginalSourceManifest(readOriginalProtectedHostActorEntries());
    requireScope(isDeepStrictEqual(readMacosSandboxBackendIdentity(), domain.backend), "protected_host_backend_changed");
    const token = Object.freeze({}) as ProtectedHostActorPreparation;
    const state: ExternalWorkflowRequestActorState = { prepared, domain, phase: "prepared" };
    this.#externalWorkflowRequestActors.set(token, state);
    activeExternalWorkflowRequestActors.add(token);
    actorPreparedBindings.set(token, Object.freeze({ registry: this, entry, prepared,
      readDomain: () => this.#readExternalWorkflowRequestDomain(token) }));
    return token;
  }

  beginExternalWorkflowRequestActorLaunch(token: ProtectedHostActorPreparation): void {
    const state = this.#externalWorkflowRequestActor(token);
    requireScope(state.phase === "prepared", "protected_host_actor_launch_closed");
    this.#readExternalWorkflowRequestDomain(token);
    state.phase = "launch_entered";
  }

  recordExternalWorkflowRequestActorLaunched(token: ProtectedHostActorPreparation): void {
    const state = this.#externalWorkflowRequestActor(token);
    requireScope(state.phase === "launch_entered", "protected_host_actor_launch_unknown");
    state.phase = "launched";
  }

  cancelExternalWorkflowRequestActor(token: ProtectedHostActorPreparation): void {
    const state = this.#externalWorkflowRequestActor(token);
    requireScope(state.phase === "prepared", "protected_host_actor_launch_closed");
    state.phase = "closed";
    activeExternalWorkflowRequestActors.delete(token);
  }

  completeExternalWorkflowRequestActor(token: ProtectedHostActorPreparation): void {
    const state = this.#externalWorkflowRequestActor(token);
    requireScope(state.phase === "launched", "protected_host_actor_launch_unknown");
    state.phase = "closed";
    activeExternalWorkflowRequestActors.delete(token);
  }

  markExternalWorkflowRequestActorUnknown(token: ProtectedHostActorPreparation): void {
    const state = this.#externalWorkflowRequestActor(token);
    state.phase = "unknown";
    this.#coverageClosed = true;
    // Keep the global request lease: without a proved terminal child, future Host
    // stages must remain fail-closed rather than assuming descendants stopped.
  }

  /** Before both launcher entry and native spawn; prepared actors also constrain later stage registration. */
  assertActorLaunchCurrent(token: ProtectedHostActorPreparation): void {
    this.#assertActorLaunchCurrent(token);
  }
  #readActorLaunchDomainCurrent(token: ProtectedHostActorPreparation): ProtectedHostActorDomain | undefined {
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
        return undefined;
      }
    }
    return actor.domain;
  }
  #assertActorLaunchCurrent(token: ProtectedHostActorPreparation): ProtectedHostActorDomain | undefined {
    const domain = this.#readActorLaunchDomainCurrent(token);
    for (const stage of this.#stages.values()) {
      this.#assertStage(stage);
      requireScope(domain, "protected_host_actor_coverage_unknown");
      this.#assertStageExclusion(domain, stage);
    }
    return domain;
  }
  beginActorLaunch(token: ProtectedHostActorPreparation): void {
    this.#assertActorLaunchCurrent(token);
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
    requireScope(activeProtectedHostStages.has(token), "protected_host_stage_registration_invalid");
    if (this.#domain) this.#assertStageExclusion(this.#domain, stage);
  }
  readStageIdentityFacts(token: ProtectedHostStageRegistration): ReturnType<ProtectedHostStagePaths["identityFacts"]> {
    this.assertStageCurrent(token);
    return this.#stageLifetimes.get(token)!.paths.identityFacts();
  }
  /** Irreversible closure first; source/policy/admission changes cannot block the original readonly FD closes. */
  closeStage(token: ProtectedHostStageRegistration): void {
    const stage = this.#stageLifetimes.get(token);
    requireScope(stage, "protected_host_stage_registration_invalid");
    requireScope(!stage.officeWindow && (stage.officeAdmission === undefined || stage.officeAdmission === "invalid"),
      "protected_host_office_window_close_required");
    if (stage.lifetime === "closed" || (stage.officeAdmission === "invalid" && stage.lifetime === "closed_pending")) return;
    requireScope(activeProtectedHostStages.has(token), "protected_host_stage_registration_invalid");
    requireScope(stage.lifetime === "active", "protected_host_stage_close_unknown");
    const officeFailure = stage.officeAdmission === "invalid";
    stage.lifetime = "close_entered";
    if (!officeFailure) this.#stages.delete(token); // Preserve the original native-only cleanup semantics.
    try { stage.paths.close(); }
    catch (error) { stage.lifetime = "unknown"; throw error; }
    // Failed Office admission may also have unknown destination cleanup. No
    // original invalid-cleanup claim exists yet, so even known stage closure
    // must retain its protection member rather than implicitly releasing it.
    stage.lifetime = officeFailure ? "closed_pending" : "closed";
    if (!officeFailure) requireScope(activeProtectedHostStages.delete(token), "protected_host_stage_registration_invalid");
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
  #externalWorkflowRequestActor(token: ProtectedHostActorPreparation): ExternalWorkflowRequestActorState {
    const actor = this.#externalWorkflowRequestActors.get(token);
    requireScope(actor && activeExternalWorkflowRequestActors.has(token), "protected_host_actor_preparation_invalid");
    return actor;
  }
  #readExternalWorkflowRequestDomain(token: ProtectedHostActorPreparation): ProtectedHostActorDomain {
    const actor = this.#externalWorkflowRequestActor(token);
    requireScope(actor.phase === "prepared" || actor.phase === "launch_entered" || actor.phase === "launched",
      "protected_host_actor_launch_closed");
    this.#assertOriginalHostHistoryCurrent();
    requireScope(isDeepStrictEqual(readMacosSandboxBackendIdentity(), actor.domain.backend), "protected_host_backend_changed");
    for (const stage of this.#stages.values()) {
      this.#assertStage(stage); this.#assertStageExclusion(actor.domain, stage);
    }
    return actor.domain;
  }
  #assertStage(stage: StageState): void {
    requireScope(stage.officeAdmission === undefined || stage.officeAdmission === "bound", "protected_host_office_window_admission_closed");
    this.#assertStageCustody(stage);
    stage.officeWindow?.paths.assertCurrent();
  }
  #assertStageCustody(stage: StageState): void {
    requireScope(stage.lifetime === "active", "protected_host_stage_closed");
    requireScope(!this.#coverageClosed, "protected_host_actor_coverage_unknown");
    this.#assertOriginalHostHistoryCurrent();
    requireScope(isDeepStrictEqual(readMacosSandboxBackendIdentity(), stage.backend), "protected_host_backend_changed");
    readProtectedHostBootstrapReadRoots(stage.backend);
    assertSourceCurrent(stage.source); assertPrivateStage(stage.paths);
  }
  #assertStageExclusion(domain: ProtectedHostActorDomain, stage: StageState): void {
    assertProtectedHostDomainExcludesStage(domain, stage.paths);
    if (stage.officeWindow) assertProtectedHostDomainExcludesStage(domain, stage.officeWindow.paths.destination);
  }
  #assertOriginalOfficeStage(token: ProtectedHostStageRegistration): void {
    const stage = this.#stageLifetimes.get(token);
    requireScope(stage && this.#stages.get(token) === stage, "protected_host_stage_registration_invalid");
    this.#assertActorInventoryCurrent(); this.#assertStage(stage);
    if (this.#domain) this.#assertStageExclusion(this.#domain, stage);
  }
  #beginOfficeWindow(token: ProtectedHostStageRegistration, expected: HostOfficeLocalDirectoryExecutionRecordV2): ProtectedHostOfficeDirectoryWindowV2 {
    const stage = this.#stageLifetimes.get(token);
    requireScope(stage && this.#stages.get(token) === stage && !stage.officeAdmission && !stage.officeWindow,
      "protected_host_office_window_admission_closed");
    stage.officeAdmission = "binding_entered";
    let paths: OriginalOfficeDirectoryWindowPaths | undefined;
    try {
      this.#assertActorInventoryCurrent(); this.#assertStageCustody(stage);
      requireScope(isDeepStrictEqual(expected.source, { runId: stage.source.run.id, ...stage.source.sourceFence })
        && expected.workspacePath === stage.source.run.cwd, "protected_host_office_window_source_invalid");
      const execution = structuredClone(expected);
      paths = captureOriginalOfficeDirectoryWindowPaths(execution, stage.paths);
      const domain = this.#domain ?? { backend: stage.backend, staticReadRoots: readProtectedHostBootstrapReadRoots(stage.backend) };
      assertProtectedHostDomainExcludesStage(domain, stage.paths);
      assertProtectedHostDomainExcludesStage(domain, paths.destination);
      this.#assertActorInventoryCurrent(); this.#assertStageCustody(stage); paths.assertCurrent();
      const state: OfficeWindowState = { registration: token, stage, execution, paths, epoch: this.#hostBindingEpoch };
      const window = Object.freeze({}) as ProtectedHostOfficeDirectoryWindowV2;
      this.#officeWindows.set(window, state); stage.officeWindow = state; stage.officeAdmission = "bound";
      return window;
    } catch (error) {
      stage.officeAdmission = "cleanup_entered";
      // Only the newly acquired destination originals belong to failed window capture;
      // the already registered stage retains its separate cleanup/protection lifetime.
      try { paths?.destination.close(); }
      catch (closeError) {
        stage.officeAdmission = "invalid"; stage.lifetime = "unknown";
        throw new AggregateError([error, closeError], "protected_host_office_window_capture_unknown");
      }
      stage.officeAdmission = "invalid";
      if (error instanceof AggregateError) stage.lifetime = "unknown";
      throw error;
    }
  }
  #officeWindow(token: ProtectedHostOfficeDirectoryWindowV2): OfficeWindowState {
    const window = this.#officeWindows.get(token);
    requireScope(window && window.epoch === this.#hostBindingEpoch && window.stage.officeWindow === window
      && this.#stages.get(window.registration) === window.stage, "protected_host_office_window_invalid");
    return window;
  }
  #assertOfficeWindow(token: ProtectedHostOfficeDirectoryWindowV2, expected: HostOfficeLocalDirectoryExecutionRecordV2): void {
    const window = this.#officeWindow(token), stage = window.stage, epoch = this.#domainEpoch;
    requireScope(isDeepStrictEqual(expected, window.execution) && stage.officeAdmission === "bound", "protected_host_office_window_binding_invalid");
    this.#assertActorInventoryCurrent(); this.#assertOriginalHostHistoryCurrent();
    requireScope(isDeepStrictEqual(readMacosSandboxBackendIdentity(), stage.backend), "protected_host_backend_changed");
    const roots = readProtectedHostBootstrapReadRoots(stage.backend); assertSourceCurrent(stage.source);
    if (stage.lifetime === "active") this.#assertStage(stage);
    else {
      const closure = window.paths.readClosureFacts();
      requireScope(stage.lifetime === "closed_pending" && closure.phase === "closed_pending"
        && [...closure.stage, ...closure.destination].every(row => row.state === "closed" && row.close === "returned"),
        "protected_host_office_window_close_unknown");
    }
    this.#assertStageExclusion(this.#domain ?? { backend: stage.backend, staticReadRoots: roots }, stage);
    requireScope(epoch === this.#domainEpoch && this.#officeWindow(token) === window,
      "protected_host_actor_history_changed");
    this.#assertActorInventoryCurrent(); this.#assertOriginalHostHistoryCurrent();
    // Pending custody is historical: never fstat/reopen the already closed originals.
  }
  #closeOfficeWindow(token: ProtectedHostOfficeDirectoryWindowV2): void {
    const window = this.#officeWindow(token), stage = window.stage;
    requireScope(stage.lifetime === "active" && stage.officeAdmission === "bound", "protected_host_office_window_close_already_entered");
    // Cleanup owns only the exact captured originals. Source/policy/pathname
    // revocation cannot block their one close; safe proof and lease release
    // remain separately gated by the fixed pending reader and future Core claim.
    stage.lifetime = "close_entered";
    try { window.paths.closeOriginalPaths(); stage.lifetime = "closed_pending"; }
    catch (error) { stage.lifetime = "unknown"; throw error; }
    // Keep #stages membership: neither closure nor caller DTO can release the lease.
  }
  #assertOfficeLeaseReleaseHistory(permit: OriginalOfficeDirectoryRuntimeReleasePermitV2,
    target: ReturnType<typeof readOriginalOfficeDirectoryRuntimeReleasePermitV2>): OfficeLeaseReleaseHistory {
    const history = this.#officeLeaseReleaseHistory.get(permit), state = history?.state;
    requireScope(history && state && target.registry === this && target.window === history.window
      && target.registration === state.registration && isDeepStrictEqual(target.execution, state.execution)
      && this.#officeWindows.get(history.window) === state && this.#stageLifetimes.get(state.registration) === state.stage
      && state.epoch === this.#hostBindingEpoch && state.stage.officeWindow === state
      && !this.#stages.has(state.registration) && !activeProtectedHostStages.has(state.registration),
    "protected_host_office_lease_release_history_invalid");
    // Historical idempotence is exact identity only. Current source/coverage,
    // native proof and already-closed original FD readers must not run here.
    return history;
  }
  #assertOfficeLeaseReleaseTail(token: ProtectedHostOfficeDirectoryWindowV2, window: OfficeWindowState, epoch: object): void {
    const stage = window.stage;
    const closure = window.paths.readClosureFacts();
    requireScope(closure.phase === "closed_pending"
      && [...closure.stage, ...closure.destination].every(row => row.state === "closed" && row.close === "returned"),
      "protected_host_office_window_close_unknown");
    requireScope(this.#officeWindows.get(token) === window && this.#stageLifetimes.get(window.registration) === stage
      && window.epoch === this.#hostBindingEpoch && stage.officeWindow === window
      && this.#stages.get(window.registration) === stage && epoch === this.#domainEpoch
      && activeProtectedHostStages.has(window.registration)
      && !this.#coverageClosed && stage.lifetime === "closed_pending" && stage.officeAdmission === "bound",
      "protected_host_office_lease_release_invalid");
  }
  #releaseOfficeLease(permit: OriginalOfficeDirectoryRuntimeReleasePermitV2): void {
    requireScope(typeof permit === "object" && permit !== null, "office_local_native_lease_release_permit_invalid");
    requireScope(!officeLeaseReleasesInProgress.has(permit), "protected_host_office_lease_release_reentrant");
    officeLeaseReleasesInProgress.add(permit);
    try {
      const target = readOriginalOfficeDirectoryRuntimeReleasePermitV2(permit);
      if (this.#officeLeaseReleaseHistory.has(permit)) {
        const history = this.#assertOfficeLeaseReleaseHistory(permit, target);
        consumeOriginalOfficeDirectoryRuntimeReleasePermitV2(permit, this, history.window,
          history.state.registration, history.state.execution, true);
        this.#assertOfficeLeaseReleaseHistory(permit, target);
        return;
      }
      requireScope(target.registry === this && !target.historyOnly, "protected_host_office_lease_release_invalid");
      const window = this.#officeWindows.get(target.window), epoch = this.#domainEpoch;
      requireScope(window && window.registration === target.registration
        && isDeepStrictEqual(window.execution, target.execution), "protected_host_office_lease_release_invalid");
      this.#assertOfficeLeaseReleaseTail(target.window, window, epoch);
      // Allocate the immutable historical record before consuming or deleting.
      // Runtime has already performed the original current closed-proof gate.
      const history = Object.freeze({ window: target.window, state: window });
      consumeOriginalOfficeDirectoryRuntimeReleasePermitV2(permit, this, target.window, window.registration, window.execution, false);
      this.#assertOfficeLeaseReleaseTail(target.window, window, epoch);
      // No I/O, listeners, awaits or caller code between the final exact check,
      // deletion of this member and publication of its original private history.
      this.#stages.delete(window.registration);
      this.#officeLeaseReleaseHistory.set(permit, history);
      requireScope(activeProtectedHostStages.delete(window.registration), "protected_host_office_lease_release_invalid");
    } finally { officeLeaseReleasesInProgress.delete(permit); }
  }
  #assertOfficeLeaseReleased(permit: OriginalOfficeDirectoryRuntimeReleasePermitV2): void {
    requireScope(typeof permit === "object" && permit !== null, "office_local_native_lease_release_permit_invalid");
    requireScope(!officeLeaseReleasesInProgress.has(permit), "protected_host_office_lease_release_reentrant");
    officeLeaseReleasesInProgress.add(permit);
    try { this.#assertOfficeLeaseReleaseHistory(permit, readOriginalOfficeDirectoryRuntimeReleasePermitV2(permit)); }
    finally { officeLeaseReleasesInProgress.delete(permit); }
  }
}
function officeReader(registry: ProtectedHostStageRegistry): NonNullable<ReturnType<typeof originalOfficeRegistryReaders.get>> {
  const reader = originalOfficeRegistryReaders.get(registry);
  requireScope(reader, "protected_host_registry_invalid"); return reader;
}
/** Fixed source readers. These helpers never call overridable public inventory/stage methods. */
export function assertOriginalProtectedHostOfficeStage(registry: ProtectedHostStageRegistry, stage: ProtectedHostStageRegistration): void {
  officeReader(registry).assertStage(stage);
}
export function beginOriginalProtectedHostOfficeDirectoryWindow(registry: ProtectedHostStageRegistry, stage: ProtectedHostStageRegistration,
  expected: HostOfficeLocalDirectoryExecutionRecordV2): ProtectedHostOfficeDirectoryWindowV2 {
  return officeReader(registry).begin(stage, expected);
}
export function assertOriginalProtectedHostOfficeDirectoryWindow(registry: ProtectedHostStageRegistry, window: ProtectedHostOfficeDirectoryWindowV2,
  expected: HostOfficeLocalDirectoryExecutionRecordV2): void { officeReader(registry).assertWindow(window, expected); }
/** Closing readonly originals is irreversible and cannot settle Core or release protection. */
export function closeOriginalProtectedHostOfficeDirectoryWindow(registry: ProtectedHostStageRegistry, window: ProtectedHostOfficeDirectoryWindowV2): void {
  officeReader(registry).closeWindow(window);
}
export function readOriginalProtectedHostOfficeDirectoryClosure(registry: ProtectedHostStageRegistry, window: ProtectedHostOfficeDirectoryWindowV2): OriginalOfficeDirectoryWindowPathClosure {
  return officeReader(registry).readClosure(window);
}
/** Only an active original Runtime permit can remove its exact closed-pending protection member. */
export function releaseOriginalProtectedHostOfficeDirectoryLeaseV2(registry: ProtectedHostStageRegistry,
  permit: OriginalOfficeDirectoryRuntimeReleasePermitV2): void { officeReader(registry).releaseLease(permit); }
/** Fixed historical readback for return-loss reconciliation; never uses the live window reader. */
export function assertOriginalProtectedHostOfficeDirectoryLeaseReleasedV2(registry: ProtectedHostStageRegistry,
  permit: OriginalOfficeDirectoryRuntimeReleasePermitV2): void { officeReader(registry).assertLeaseReleased(permit); }
export function isProtectedHostStageRegistry(value: unknown): value is ProtectedHostStageRegistry {
  return typeof value === "object" && value !== null && ownedRegistries.has(value as ProtectedHostStageRegistry);
}
