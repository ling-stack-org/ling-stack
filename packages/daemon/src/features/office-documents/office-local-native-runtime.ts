import { mkdtempSync, realpathSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { OFFICE_DOCUMENTS_MCP_SERVER_ID } from "@ling-stack/contracts";
import type { HostOfficeLocalDirectoryExecutionRecordV2, RunStore, RuntimeInstance } from "@ling-stack/core";
import type { McpBroker } from "../../context.js";
import { findHostOfficeLocalFactory } from "../mcp/broker.js";
import { isRuntimeSupervisorOfficeCacheEntry, readRuntimeSupervisorOfficeArtifact, readRuntimeSupervisorOfficeBinding, readRuntimeSupervisorOfficeIssuerId,
  type RuntimeSupervisor } from "../../runtime/supervisor.js";
import { isProtectedHostStageRegistry, assertOriginalProtectedHostOfficeStage,
  beginOriginalProtectedHostOfficeDirectoryWindow, assertOriginalProtectedHostOfficeDirectoryWindow,
  type ProtectedHostOfficeDirectoryWindowV2, type ProtectedHostSourceInput,
  type ProtectedHostStageRegistration, type ProtectedHostStageRegistry } from "../../runtime/sandbox/protected-host-staging.js";
import { loadReviewedOfficeLocalNativeArtifact, type OfficeLocalNativeIdentityFacts,
  type OfficeLocalNativeMethod } from "../../runtime/sandbox/protected-host-office-native-identity.js";

declare const scopeBrand: unique symbol;
declare const resourceBrand: unique symbol;
export interface OfficeLocalNativeTypedScope { readonly [scopeBrand]: true }
export interface OfficeLocalNativeResource { readonly [resourceBrand]: true }
/** Native factual fields stay original; only live capabilities are opaque Host wrappers. No serialized FD or session. */
export interface OfficeLocalNativePacket {
  readonly success: boolean;
  readonly nativeOutcome: "returned";
  readonly hostAcknowledgment: "not_provided";
  readonly operationId: string;
  readonly snapshot: unknown;
  readonly calls: unknown;
  readonly stageParent?: OfficeLocalNativeResource;
  readonly destinationParent?: OfficeLocalNativeResource;
  readonly capability?: OfficeLocalNativeResource;
  readonly bytes?: Buffer;
  readonly [key: string]: unknown;
}
export interface OfficeLocalNativeBootstrapInput extends ProtectedHostSourceInput {
  readonly originalBroker: McpBroker;
  readonly factory: McpBroker;
  readonly rawName: string;
  readonly toolCallId: string;
}
export interface OfficeLocalNativeScopeFacts {
  readonly hostScopeBinding: "original_supervisor_factory_source_v1";
  readonly hostStageProtection: "controlled_actor_inventory_verified";
  readonly stagePath: string;
  readonly stageCreator: "host_mkdtemp_0700";
  readonly scopeRef: { readonly scopeId: string; readonly issuerId: string; readonly evidenceDigest: string };
  readonly runtimeSchemaVersion: 23;
  readonly nativeArtifact: OfficeLocalNativeIdentityFacts;
  /** Primitive native flags are not promoted by Host stage verification. */
  readonly scopeBinding: "unbound";
  readonly protectedStageVerified: false;
  readonly coreSafe: false;
  readonly packaged: false;
}
interface ScopeState {
  readonly source: OfficeLocalNativeBootstrapInput;
  readonly runtime: RuntimeInstance;
  readonly runtimeSnapshot: RuntimeInstance;
  readonly stage: ProtectedHostStageRegistration;
  readonly stagePath: string;
  readonly facts: OfficeLocalNativeScopeFacts;
  phase: "bootstrap" | "capture_entered" | "captured" | "revoked" | "close_entered" | "closed" | "unknown";
  session?: object;
  nativeClosed: boolean;
  captureEntered: boolean;
  sessionCloseEntered: boolean;
  stageClosure: "retained" | "closed" | "unknown";
  coreBinding?: "custody_entered" | "custody_captured" | "binding_entered" | "bound" | "invalid";
  coreWindow?: ProtectedHostOfficeDirectoryWindowV2;
  coreExecution?: HostOfficeLocalDirectoryExecutionRecordV2;
}
interface ResourceState { readonly scope: ScopeState; readonly native: object; closeEntered: boolean }
const ownedRuntimes = new WeakSet<OfficeLocalNativeRuntime>();
const originalCoreScopeReaders = new WeakMap<OfficeLocalNativeRuntime, Readonly<{
  capture: (scope: OfficeLocalNativeTypedScope) => object;
  assertBinding: (custody: object, expected: HostOfficeLocalDirectoryExecutionRecordV2) => void;
}>>();
function requireRuntime(value: unknown, code = "office_local_native_runtime_invalid"): asserts value {
  if (!value) throw new Error(code);
}
function dataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  requireRuntime(descriptor && Object.hasOwn(descriptor, "value"), "office_local_native_reply_invalid");
  return descriptor.value;
}

/** Supervisor-owned local runtime. Bootstrap never enters native openSession or issues Core authority. */
export class OfficeLocalNativeRuntime {
  readonly #scopes = new WeakMap<OfficeLocalNativeTypedScope, ScopeState>();
  readonly #resources = new WeakMap<OfficeLocalNativeResource, ResourceState>();
  readonly #coreCustodies = new WeakMap<object, ScopeState>();
  readonly #native: ReturnType<typeof loadReviewedOfficeLocalNativeArtifact>;
  readonly #factories = new WeakMap<McpBroker, string>();
  #identityClosure: "retained" | "closed" | "unknown" = "retained";
  constructor(readonly supervisor: RuntimeSupervisor, readonly registry: ProtectedHostStageRegistry,
    readonly store: RunStore) {
    requireRuntime(isProtectedHostStageRegistry(registry));
    readRuntimeSupervisorOfficeBinding(supervisor, store, registry);
    this.#native = loadReviewedOfficeLocalNativeArtifact(readRuntimeSupervisorOfficeArtifact(supervisor, store, registry));
    for (const name of ["bootstrapStage", "assertScopeCurrent", "assertScopeBinding", "scopeFacts", "openSession", "createDirectory", "createFile",
      "writeFile", "readFile", "fsyncResource", "observeResource", "installTree", "observePublication", "inspectSession",
      "closeResource", "cancelSession", "closeSession", "revokeScope", "closeStage", "releaseIdentity"] as const) {
      const method = OfficeLocalNativeRuntime.prototype[name].bind(this);
      Object.defineProperty(this, name, { value: method, writable: false, configurable: false });
    }
    Object.freeze(this);
    ownedRuntimes.add(this);
    originalCoreScopeReaders.set(this, Object.freeze({
      capture: scope => this.#captureCoreCustody(scope),
      assertBinding: (custody, expected) => this.#assertCoreBinding(custody, expected),
    }));
  }

  bootstrapStage(input: OfficeLocalNativeBootstrapInput): OfficeLocalNativeTypedScope {
    requireRuntime(isOwnedOfficeLocalNativeRuntime(this) && this.#identityClosure === "retained", "office_local_native_runtime_closed");
    requireRuntime(input.store === this.store && input.run.cwd === this.store.paths.cwd
      && typeof input.toolCallId === "string" && input.toolCallId.length > 0 && input.toolCallId.length <= 512);
    const runtime = readRuntimeSupervisorOfficeBinding(this.supervisor, this.store, this.registry);
    requireRuntime(runtime.schemaVersion === 23 && input.sourceFence.runtimeInstanceId === runtime.runtimeInstanceId,
      "office_local_native_runtime_schema_unsupported");
    this.registry.assertActorInventoryCurrent(); this.#native.assertCurrent();
    this.registry.assertHostStageSourceCurrent(input);
    requireRuntime(findHostOfficeLocalFactory(input.originalBroker, OFFICE_DOCUMENTS_MCP_SERVER_ID,
      input.rawName, input.run.cwd) === input.factory, "office_local_native_factory_invalid");
    // mkdtemp's kernel-created private directory is factual Host creator evidence.
    // No caller stagePath is accepted, and no capture_parents facts exist here.
    const stagePath = realpathSync(mkdtempSync("/private/tmp/ling-office-host-"));
    const stage = this.registry.registerStage({ ...input, stagePath });
    try {
      const source: OfficeLocalNativeBootstrapInput = Object.freeze({ store: input.store, run: structuredClone(input.run),
        sourceFence: Object.freeze({ ...input.sourceFence }), originalBroker: input.originalBroker,
        factory: input.factory, rawName: input.rawName, toolCallId: input.toolCallId });
      const scopeId = `office_host_scope_${randomUUID()}`,
        issuerId = readRuntimeSupervisorOfficeIssuerId(this.supervisor, this.store, this.registry);
      let factoryId = this.#factories.get(source.factory);
      if (!factoryId) { factoryId = `office_original_factory_${randomUUID()}`; this.#factories.set(source.factory, factoryId); }
      const evidenceDigest = createHash("sha256").update(JSON.stringify({ scopeId, issuerId, runtime,
        factoryId,
        source: { run: source.run, sourceFence: source.sourceFence, rawName: source.rawName, toolCallId: source.toolCallId },
        stage: this.registry.readStageIdentityFacts(stage), nativeArtifact: this.#native.facts })).digest("hex");
      const scopeRef = Object.freeze({ scopeId, issuerId, evidenceDigest });
      const facts: OfficeLocalNativeScopeFacts = Object.freeze({ hostScopeBinding: "original_supervisor_factory_source_v1",
        hostStageProtection: "controlled_actor_inventory_verified", stagePath, stageCreator: "host_mkdtemp_0700", scopeRef,
        runtimeSchemaVersion: 23, nativeArtifact: this.#native.facts, scopeBinding: "unbound", protectedStageVerified: false,
        coreSafe: false, packaged: false });
      const scope = Object.freeze({}) as OfficeLocalNativeTypedScope;
      this.#scopes.set(scope, { source, runtime, runtimeSnapshot: structuredClone(runtime), stage, stagePath, facts,
        phase: "bootstrap", nativeClosed: false, captureEntered: false, sessionCloseEntered: false, stageClosure: "retained" });
      return scope;
    } catch (error) {
      // No scope/session has escaped: release only this registration's original
      // readonly FDs. Registry closure tombstones first and never deletes paths.
      try { this.registry.closeStage(stage); }
      catch (closeError) { throw new AggregateError([error, closeError], "office_local_native_bootstrap_cleanup_unknown"); }
      throw error;
    }
  }

  assertScopeCurrent(scope: OfficeLocalNativeTypedScope): void { this.#forward(this.#scope(scope)); }
  /** An opaque current scope cannot be borrowed by another reservation/source/factory. History digests are not admitted. */
  assertScopeBinding(scope: OfficeLocalNativeTypedScope, input: OfficeLocalNativeBootstrapInput): void {
    const state = this.#scope(scope), source = state.source;
    requireRuntime(input.store === source.store && input.originalBroker === source.originalBroker && input.factory === source.factory
      && input.rawName === source.rawName && input.toolCallId === source.toolCallId
      && isDeepStrictEqual(input.run, source.run) && isDeepStrictEqual(input.sourceFence, source.sourceFence),
      "office_local_native_scope_binding_invalid");
    this.#forward(state);
  }
  scopeFacts(scope: OfficeLocalNativeTypedScope): OfficeLocalNativeScopeFacts {
    const state = this.#scope(scope); this.#forward(state); return state.facts;
  }
  /** The fixed adapter calls this exactly once inside its original capture_parents Core synchronous gate. */
  openSession(scope: OfficeLocalNativeTypedScope, destinationParent: string): OfficeLocalNativePacket {
    const state = this.#scope(scope); this.#forward(state);
    requireRuntime(state.phase === "bootstrap", "office_local_native_capture_already_entered");
    requireRuntime(state.coreBinding === undefined || state.coreBinding === "bound", "office_local_native_core_binding_required");
    if (state.coreExecution) requireRuntime(destinationParent === state.coreExecution.destination.parentPath, "office_local_native_core_destination_invalid");
    state.phase = "capture_entered"; state.captureEntered = true;
    try {
      const packet = this.#native.invoke("openSession", [state.stagePath, destinationParent]);
      requireRuntime(packet && typeof packet === "object");
      const session = dataValue(packet, "session"); requireRuntime(session && typeof session === "object");
      state.session = session; state.phase = "captured";
      return this.#packet(state, packet);
    } catch (error) { state.phase = "unknown"; throw error; }
  }
  createDirectory(scope: OfficeLocalNativeTypedScope, parent: OfficeLocalNativeResource, name: string, effectId: string): OfficeLocalNativePacket {
    return this.#resourceCall(scope, "createDirectory", parent, [name, effectId]);
  }
  createFile(scope: OfficeLocalNativeTypedScope, parent: OfficeLocalNativeResource, name: string, effectId: string): OfficeLocalNativePacket {
    return this.#resourceCall(scope, "createFile", parent, [name, effectId]);
  }
  writeFile(scope: OfficeLocalNativeTypedScope, resource: OfficeLocalNativeResource, bytes: Buffer, effectId: string): OfficeLocalNativePacket {
    return this.#resourceCall(scope, "writeFile", resource, [bytes, effectId]);
  }
  readFile(scope: OfficeLocalNativeTypedScope, resource: OfficeLocalNativeResource, expectedBytes: number, budget: number, effectId: string): OfficeLocalNativePacket {
    return this.#resourceCall(scope, "readFile", resource, [expectedBytes, budget, effectId]);
  }
  fsyncResource(scope: OfficeLocalNativeTypedScope, resource: OfficeLocalNativeResource, effectId: string): OfficeLocalNativePacket {
    return this.#resourceCall(scope, "fsyncResource", resource, [effectId]);
  }
  observeResource(scope: OfficeLocalNativeTypedScope, resource: OfficeLocalNativeResource, effectId: string): OfficeLocalNativePacket {
    return this.#resourceCall(scope, "observeResource", resource, [effectId]);
  }
  installTree(scope: OfficeLocalNativeTypedScope, resource: OfficeLocalNativeResource, name: string, effectId: string): OfficeLocalNativePacket {
    return this.#resourceCall(scope, "installTree", resource, [name, effectId]);
  }
  observePublication(scope: OfficeLocalNativeTypedScope, tree: OfficeLocalNativeResource, budget: number, effectId: string): OfficeLocalNativePacket {
    return this.#resourceCall(scope, "observePublication", tree, [budget, effectId]);
  }
  inspectSession(scope: OfficeLocalNativeTypedScope): unknown {
    const state = this.#scope(scope); this.#forward(state); return this.#native.invoke("inspectSession", [this.#session(state)]);
  }
  /** Cleanup can use only these original acquired caps after source/policy/admission revocation. */
  closeResource(scope: OfficeLocalNativeTypedScope, resource: OfficeLocalNativeResource, effectId: string): OfficeLocalNativePacket {
    const state = this.#scope(scope), held = this.#resource(state, resource);
    requireRuntime(!held.closeEntered, "office_local_native_resource_close_already_entered"); held.closeEntered = true;
    return this.#packet(state, this.#native.invokeCleanup("closeResource", [this.#session(state), held.native, effectId]));
  }
  cancelSession(scope: OfficeLocalNativeTypedScope): unknown {
    const state = this.#scope(scope); state.phase = "revoked";
    return this.#native.invokeCleanup("cancelSession", [this.#session(state)]);
  }
  closeSession(scope: OfficeLocalNativeTypedScope): OfficeLocalNativePacket {
    const state = this.#scope(scope);
    requireRuntime(!state.sessionCloseEntered, "office_local_native_close_already_entered");
    state.phase = "close_entered"; state.sessionCloseEntered = true;
    try {
      const raw = this.#native.invokeCleanup("closeSession", [this.#session(state)]), packet = this.#packet(state, raw);
      state.nativeClosed = packet.success === true; state.phase = state.nativeClosed ? "closed" : "unknown";
      return packet;
    } catch (error) { state.phase = "unknown"; throw error; }
  }
  revokeScope(scope: OfficeLocalNativeTypedScope): void {
    const state = this.#scope(scope);
    if (state.phase !== "closed") state.phase = "revoked";
  }
  /** Close original readonly stage FDs only. No pathname unlink, no cleanup permission resurrection. */
  closeStage(scope: OfficeLocalNativeTypedScope): void {
    const state = this.#scope(scope);
    requireRuntime(!state.coreWindow && state.coreBinding !== "binding_entered" && state.coreBinding !== "custody_entered",
      "office_local_native_core_window_close_required");
    if (state.stageClosure === "closed") return;
    requireRuntime(state.stageClosure === "retained", "office_local_native_stage_close_unknown");
    requireRuntime(!state.captureEntered || state.nativeClosed, "office_local_native_stage_lifetime_unknown");
    state.phase = "closed"; state.stageClosure = "unknown";
    this.registry.closeStage(state.stage); state.stageClosure = "closed";
  }
  /** Host shutdown releases the original binary identity FD, not native/Core resources or a safe receipt. */
  releaseIdentity(): void {
    if (this.#identityClosure === "closed") return;
    requireRuntime(this.#identityClosure === "retained", "office_local_native_identity_close_unknown");
    this.#identityClosure = "unknown"; this.#native.closeIdentity(); this.#identityClosure = "closed";
  }
  #scope(scope: OfficeLocalNativeTypedScope): ScopeState {
    const state = this.#scopes.get(scope); requireRuntime(state, "office_local_native_scope_invalid"); return state;
  }
  #session(state: ScopeState): object { requireRuntime(state.session, "office_local_native_session_unavailable"); return state.session; }
  #resource(state: ScopeState, resource: OfficeLocalNativeResource): ResourceState {
    const held = this.#resources.get(resource); requireRuntime(held?.scope === state, "office_local_native_resource_invalid"); return held;
  }
  #forward(state: ScopeState): void {
    requireRuntime(isOwnedOfficeLocalNativeRuntime(this), "office_local_native_runtime_unowned");
    requireRuntime(this.#identityClosure === "retained" && ["bootstrap", "captured"].includes(state.phase) && state.stageClosure === "retained"
      && state.coreBinding !== "invalid", "office_local_native_scope_closed");
    const runtime = readRuntimeSupervisorOfficeBinding(this.supervisor, this.store, this.registry);
    requireRuntime(runtime === state.runtime && isDeepStrictEqual(runtime, state.runtimeSnapshot), "office_local_native_runtime_obsolete");
    requireRuntime(findHostOfficeLocalFactory(state.source.originalBroker, OFFICE_DOCUMENTS_MCP_SERVER_ID,
      state.source.rawName, state.source.run.cwd) === state.source.factory, "office_local_native_factory_obsolete");
    this.registry.assertActorInventoryCurrent(); this.registry.assertStageCurrent(state.stage); this.#native.assertCurrent();
    if (state.coreWindow) assertOriginalProtectedHostOfficeDirectoryWindow(this.registry, state.coreWindow, state.coreExecution!);
  }
  #captureCoreCustody(scope: OfficeLocalNativeTypedScope): object {
    const state = this.#scope(scope);
    requireRuntime(state.phase === "bootstrap" && !state.captureEntered && !state.sessionCloseEntered
      && state.stageClosure === "retained" && !state.coreBinding, "office_local_native_core_custody_closed");
    state.coreBinding = "custody_entered";
    try {
      this.#forward(state); assertOriginalProtectedHostOfficeStage(this.registry, state.stage);
      const custody = Object.freeze({}); this.#coreCustodies.set(custody, state);
      state.coreBinding = "custody_captured"; return custody;
    } catch (error) { state.coreBinding = "invalid"; throw error; }
  }
  #assertCoreBinding(custody: object, expected: HostOfficeLocalDirectoryExecutionRecordV2): void {
    const state = this.#coreCustodies.get(custody);
    requireRuntime(state && state.coreBinding === "custody_captured", "office_local_native_core_custody_invalid");
    state.coreBinding = "binding_entered";
    try {
      requireRuntime(state.phase === "bootstrap" && !state.captureEntered && !state.sessionCloseEntered && state.stageClosure === "retained",
        "office_local_native_core_custody_closed");
      this.#forward(state); assertOriginalProtectedHostOfficeStage(this.registry, state.stage);
      const source = state.source;
      requireRuntime(isDeepStrictEqual(expected.source, { runId: source.run.id, ...source.sourceFence })
        && expected.workspacePath === source.run.cwd && expected.toolCallId === source.toolCallId && expected.toolName === source.rawName
        && expected.stage.parentPath === state.stagePath && isDeepStrictEqual(expected.scopeRef, state.facts.scopeRef),
        "office_local_native_core_source_invalid");
      const execution = structuredClone(expected);
      state.coreWindow = beginOriginalProtectedHostOfficeDirectoryWindow(this.registry, state.stage, execution);
      state.coreExecution = execution; state.coreBinding = "bound";
    } catch (error) { state.coreBinding = "invalid"; throw error; }
  }
  #resourceCall(scope: OfficeLocalNativeTypedScope, method: OfficeLocalNativeMethod, resource: OfficeLocalNativeResource,
    args: readonly unknown[]): OfficeLocalNativePacket {
    const state = this.#scope(scope); this.#forward(state); const held = this.#resource(state, resource);
    requireRuntime(!held.closeEntered, "office_local_native_resource_closed");
    try { return this.#packet(state, this.#native.invoke(method, [this.#session(state), held.native, ...args])); }
    catch (error) { state.phase = "unknown"; throw error; }
  }
  #packet(state: ScopeState, raw: unknown): OfficeLocalNativePacket {
    requireRuntime(raw && typeof raw === "object" && Object.getPrototypeOf(raw) === Object.prototype, "office_local_native_reply_invalid");
    const output: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(raw))) {
      requireRuntime(Object.hasOwn(descriptor, "value"), "office_local_native_reply_invalid");
      if (key === "session") continue;
      let value = descriptor.value;
      if (["stageParent", "destinationParent", "capability"].includes(key)) {
        requireRuntime(value && typeof value === "object", "office_local_native_reply_invalid");
        const capability = Object.freeze({}) as OfficeLocalNativeResource;
        this.#resources.set(capability, { scope: state, native: value, closeEntered: false }); value = capability;
      }
      Object.defineProperty(output, key, { value, enumerable: true });
    }
    requireRuntime(output.nativeOutcome === "returned" && output.hostAcknowledgment === "not_provided" && typeof output.success === "boolean",
      "office_local_native_reply_invalid");
    if (output.success === false) state.phase = "unknown";
    return Object.freeze(output) as unknown as OfficeLocalNativePacket;
  }
}

/** Genuine constructor success plus the exact original Supervisor cache object; clones/noop objects are not issuers. */
export function isOwnedOfficeLocalNativeRuntime(value: unknown): value is OfficeLocalNativeRuntime {
  return typeof value === "object" && value !== null && ownedRuntimes.has(value as OfficeLocalNativeRuntime)
    && Object.isFrozen(value) && isRuntimeSupervisorOfficeCacheEntry((value as OfficeLocalNativeRuntime).supervisor,
      (value as OfficeLocalNativeRuntime).store, (value as OfficeLocalNativeRuntime).registry, value as OfficeLocalNativeRuntime);
}

/** Module-private constructor readers: replacing a public runtime/registry method cannot mint custody. */
export function captureOriginalOfficeDirectoryRuntimeCustody(runtime: OfficeLocalNativeRuntime, scope: OfficeLocalNativeTypedScope): object {
  const reader = originalCoreScopeReaders.get(runtime);
  requireRuntime(reader && isOwnedOfficeLocalNativeRuntime(runtime), "office_local_native_runtime_unowned");
  return reader.capture(scope);
}
export function assertOriginalOfficeDirectoryRuntimeBinding(runtime: OfficeLocalNativeRuntime, custody: object,
  expected: HostOfficeLocalDirectoryExecutionRecordV2): void {
  const reader = originalCoreScopeReaders.get(runtime);
  requireRuntime(reader && isOwnedOfficeLocalNativeRuntime(runtime), "office_local_native_runtime_unowned");
  reader.assertBinding(custody, expected);
}
