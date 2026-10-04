import { isDeepStrictEqual } from "node:util";
import type { HostCommandExecutionTicket, HostMediaEffectRecord, HostMediaExecutionRecord, HostMediaExecutionTicket,
  HostOfficeLocalEffectRecord, HostOfficeLocalTicket, PrepareHostOfficeLocalInput, PrepareHostOfficeLocalEffect,
  HostOperationEvidenceRef, HostOperationRecord, HostOperationTicket, PrepareHostMediaEffectInput,
  PrepareHostMediaExecutionInput, RunStore, RuntimeAttemptFenceV1, SealHostOfficeLocalTerminalInput,
  HostOfficeLocalTerminalRecord, HostOfficeLocalSettlement } from "@ling-stack/core";
import { AttemptExecutorGroup, type AttemptExecutionSource, type HostCallTicket, type HostExecutorBlocker,
  type HostExecutorKind, type HostExecutorSettlement } from "./attempt-execution-quiescence.js";
import type { HostCommandOperation, HostCommandPreparationOperation, HostFileMutationOperation } from "./host-operation-effects.js";

type TrackerStore = Pick<RunStore, "isCurrentRunExecutionOwner" | "admitHostOperation" | "bindHostOperationEvidence"
  | "launchHostOperation" | "launchTrackedHostCommandExecution" | "continueHostOperationEffect" | "settleHostOperation" | "getHostOperation"
  | "prepareHostMediaExecution" | "bindHostMediaChildExecution" | "prepareHostMediaEffect" | "launchHostMediaEffect"
  | "getHostMediaExecution" | "recordHostMediaResponse" | "recordHostMediaSubmission" | "recordHostMediaSubmissionAndExecutionHandle" | "recordHostMediaTerminal"
  | "recordHostMediaArtifactManifest" | "finalizeHostMediaExecution" | "recordHostMediaEffectNoStart"
  | "prepareHostOfficeLocalExecution" | "prepareHostOfficeLocalEffect" | "launchHostOfficeLocalEffect" | "recordHostOfficeLocalObservation"
  | "sealHostOfficeLocalTerminal" | "settleHostOfficeLocalExecution">;
const operationHandleBrand: unique symbol = Symbol("AttemptHostOperationHandle");
/** Neither persisted IDs nor a structural clone grants launch/settlement authority. */
export interface AttemptHostOperationHandle {
  readonly [operationHandleBrand]: true;
  readonly operationId: string;
  readonly source: AttemptExecutionSource;
  readonly kind: HostExecutorKind;
  readonly toolCallId: string;
  readonly parentOperationId?: string;
  readonly producerId?: string;
}
interface TrackedOperation {
  readonly handle: AttemptHostOperationHandle;
  readonly groupTicket: HostCallTicket;
  durableTicket?: HostOperationTicket;
  launched: boolean;
  groupSettlement?: HostExecutorSettlement;
  unknownIntent?: { readonly code: string; readonly settledAt: string };
}
interface TrackedMediaExecution {
  readonly parent: TrackedOperation;
  readonly transport: TrackedOperation;
}
export class AttemptHostOperationTrackerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message); this.name = "AttemptHostOperationTrackerError";
  }
}

/**
 * Binds one captured attempt's in-memory barrier to the actual Core journal.
 * There is no caller-provided proof verifier, SDK-result heuristic, toolCallId
 * evidence lookup, automatic terminal transition or resource release here.
 * Every effect hook is synchronous; async preparation stays outside it, and
 * concrete executor facts must settle before this tracker can prove quiescence.
 */
export class AttemptHostOperationTracker {
  readonly #store: TrackerStore;
  readonly #group: AttemptExecutorGroup;
  readonly #now: () => string;
  readonly #operations = new Map<AttemptHostOperationHandle, TrackedOperation>();
  readonly #byGroupTicket = new Map<HostCallTicket, TrackedOperation>();
  readonly #mediaExecutions = new WeakMap<HostMediaExecutionTicket, TrackedMediaExecution>();
  readonly #officeExecutions = new WeakMap<HostOfficeLocalTicket, TrackedMediaExecution>();
  readonly #officeEffects = new WeakMap<HostOfficeLocalTicket, Map<string, HostOfficeLocalEffectRecord>>();
  readonly #officeClosed = new WeakSet<HostOfficeLocalTicket>();

  constructor(options: { readonly store: TrackerStore; readonly source: AttemptExecutionSource; readonly now?: () => string }) {
    const keys = Reflect.ownKeys(options);
    if (keys.some(key => typeof key !== "string" || !["store", "source", "now"].includes(key))) {
      fail("invalid_constructor_option", "Constructor options cannot supply alternative Host proof hooks.");
    }
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#group = new AttemptExecutorGroup({ source: options.source,
      isCurrentExecutionOwner: source => this.#store.isCurrentRunExecutionOwner(source.runId, source),
      verifySettlement: (ticket, proof) => this.#verifySafeSettlement(ticket, proof),
      persistBlockedOperation: blocker => this.#verifyPersistedUnknown(blocker) });
  }

  get executorGroup(): AttemptExecutorGroup { return this.#group; }
  get source(): AttemptExecutionSource { return this.#group.source; }

  /** Reserve then persist before any await. Failed admission never drops the reserved barrier member. */
  beginHostCall(kind: HostExecutorKind, toolCallId: string): AttemptHostOperationHandle {
    return this.#admit(this.#group.beginHostCall(kind, toolCallId));
  }

  /** Reserve a source-linked producer before dispatch; never enroll it after the barrier closes. */
  registerProducer(parent: AttemptHostOperationHandle, kind: HostExecutorKind, producerId: string): AttemptHostOperationHandle {
    const operation = this.#operation(parent);
    this.#requireDurableTicket(operation);
    return this.#admit(this.#group.registerProducer(operation.groupTicket, kind, producerId));
  }

  /** Bind the executor's exact returned identity. Core checks source/type and freezes this binding. */
  bindEvidence(handle: AttemptHostOperationHandle, evidence: HostOperationEvidenceRef): HostOperationRecord {
    const operation = this.#operation(handle);
    this.#assertUnsettled(operation);
    this.#group.assertMayLaunch(operation.groupTicket);
    const record = this.#store.bindHostOperationEvidence(this.#requireDurableTicket(operation), evidence);
    this.#assertRecord(operation, record);
    return this.#read(operation);
  }

  /** First actual effect: recheck group inside Core's synchronous full-source launch gate. */
  launchHostEffect<T>(handle: AttemptHostOperationHandle, effect: () => T): T {
    const operation = this.#operation(handle);
    this.#assertSynchronousEffect(effect);
    this.#assertUnsettled(operation);
    this.#group.assertMayLaunch(operation.groupTicket);
    if (operation.launched) fail("already_launched", "Host operation has already entered effect launch.");
    return this.#store.launchHostOperation(this.#requireDurableTicket(operation), () =>
      this.#group.launchHostEffect(operation.groupTicket, () => {
        // Do not reset this if Core COMMIT or a synchronous observer fails after
        // the filesystem/process effect. A rolled-back row is not a no-start.
        operation.launched = true;
        return effect();
      }));
  }

  /**
   * Each subsequent mutation must reenter the gate. Cleanup is a narrowly owned
   * rollback of an entered operation: Core rechecks the original source with
   * allowCleanup, it does not reopen admission, enroll work or settle the row.
   */
  continueHostEffect<T>(handle: AttemptHostOperationHandle, effect: () => T, mode: "forward" | "cleanup" = "forward"): T {
    const operation = this.#operation(handle);
    this.#assertSynchronousEffect(effect);
    this.#assertUnsettled(operation);
    if (!operation.launched) fail("not_launched", "Host operation has not entered an effect launch.");
    if (mode !== "forward" && mode !== "cleanup") fail("invalid_effect_mode", "Invalid Host operation effect mode.");
    if (mode === "forward") this.#group.assertMayLaunch(operation.groupTicket);
    return this.#store.continueHostOperationEffect(this.#requireDurableTicket(operation), () => {
      this.#assertUnsettled(operation);
      if (mode === "forward") this.#group.assertMayLaunch(operation.groupTicket);
      return effect();
    }, mode);
  }

  /** Explicit no-start is accepted only if both local launch state and Core's immutable history agree. */
  settleNoStart(handle: AttemptHostOperationHandle): HostOperationRecord {
    const operation = this.#operation(handle);
    if (operation.launched) fail("launched_no_start", "An entered launch cannot be settled as known no-start.");
    const previous = this.#read(operation);
    this.#store.settleHostOperation(this.#requireDurableTicket(operation), { kind: "known_no_start",
      settledAt: previous.settlementKind === "known_no_start" ? previous.settledAt : this.#now() });
    return this.settleFromStore(handle);
  }

  /** Core independently verifies the exact bound Broker row/artifacts; tool results do not enter this API. */
  settleFileFromStore(handle: AttemptHostOperationHandle): HostOperationRecord {
    const operation = this.#operation(handle);
    if (handle.kind !== "file_mutation") fail("invalid_file_operation", "File settlement requires a file mutation operation.");
    const previous = this.#read(operation);
    if (previous.evidenceRef?.kind !== "harness_tool_execution") {
      fail("file_evidence_missing", "An exact immutable file Broker evidence binding is required.");
    }
    this.#store.settleHostOperation(this.#requireDurableTicket(operation), { kind: "file_completed",
      settledAt: previous.settlementKind === "file_completed" ? previous.settledAt : this.#now() });
    return this.settleFromStore(handle);
  }

  /** Read an existing Core-verified safe/unknown fact; never create safety from return/throw/timeout. */
  settleFromStore(handle: AttemptHostOperationHandle): HostOperationRecord {
    const operation = this.#operation(handle);
    const record = this.#read(operation);
    const proof = this.#proof(operation, record);
    this.#group.settleHostCall(operation.groupTicket, proof);
    operation.groupSettlement = proof;
    return record;
  }

  /** Persist unknown first. A failed write still latches the group as blocked, with no fabricated durable success. */
  markUnknown(handle: AttemptHostOperationHandle, code: string): HostOperationRecord {
    const operation = this.#operation(handle);
    if (typeof code !== "string" || !/^[a-zA-Z0-9_.:-]{1,96}$/u.test(code)) fail("invalid_unknown_code", "Invalid Host unknown-outcome code.");
    if (operation.unknownIntent && operation.unknownIntent.code !== code) {
      fail("different_unknown", "A different unknown outcome cannot replace the original blocker.");
    }
    if (!operation.unknownIntent) {
      // Reading an existing row is useful for an exact retry, but a transient
      // read failure must not leave the in-memory barrier looking unsettled.
      // Latch one immutable Host-clock intent first; the durable write and the
      // Core/group verifier below may still fail closed and require a retry.
      let previous: HostOperationRecord | undefined;
      try { previous = this.#read(operation); } catch {
        operation.unknownIntent = Object.freeze({ code, settledAt: this.#now() });
      }
      if (!operation.unknownIntent) {
        operation.unknownIntent = Object.freeze({ code, settledAt: previous!.phase === "unknown_outcome" && previous!.code === code
          ? previous!.settledAt! : this.#now() });
      }
    }
    const proof = this.#unknownProof(operation, operation.unknownIntent);
    let durableError: unknown;
    try {
      this.#store.settleHostOperation(this.#requireDurableTicket(operation), {
        kind: "unknown_outcome", ...operation.unknownIntent });
    } catch (error) { durableError = error; }
    let groupError: unknown;
    try {
      this.#group.settleHostCall(operation.groupTicket, proof);
      operation.groupSettlement = proof;
    } catch (error) {
      // Unknown settlement is latched before the group's durable verification
      // hook returns false. Retain this local state even when persistence fails.
      operation.groupSettlement = proof;
      groupError = error;
    }
    if (durableError) throw durableError;
    if (groupError) throw groupError;
    return this.#read(operation);
  }

  /** The Broker/patch adapter shares one reserved operation across prepare, each write and rollback. */
  fileMutationOperation(handle: AttemptHostOperationHandle): HostFileMutationOperation {
    const operation = this.#operation(handle);
    if (handle.kind !== "file_mutation") fail("invalid_file_operation", "File effect hooks require a file mutation operation.");
    return Object.freeze({
      assertMayPrepare: () => {
        this.#assertUnsettled(operation);
        this.#group.assertMayLaunch(operation.groupTicket);
        if (this.#read(operation).phase !== "admitted") fail("invalid_prepare_phase", "File preparation requires a never-launched operation.");
      },
      bindHarnessExecution: (executionId: string) => { this.bindEvidence(handle, { kind: "harness_tool_execution", id: executionId }); },
      effectGuard: Object.freeze({
        launch: <T>(effect: () => T): T => operation.launched
          ? this.continueHostEffect(handle, effect) : this.launchHostEffect(handle, effect),
        cleanup: <T>(effect: () => T): T => this.continueHostEffect(handle, effect, "cleanup"),
      }),
    });
  }

  /**
   * Ordinary command completion and U physical quiescence are different facts.
   * Current commands report descendants=unverified, so no completed settlement
   * exists here. The executor may only confirm never-start or persist unknown.
   */
  commandOperation(handle: AttemptHostOperationHandle): HostCommandOperation {
    const operation = this.#operation(handle);
    if (handle.kind !== "command") fail("invalid_command_operation", "Command effect hooks require a command operation.");
    return Object.freeze({
      assertMayPrepare: () => {
        this.#assertUnsettled(operation);
        this.#group.assertMayLaunch(operation.groupTicket);
        if (this.#read(operation).phase !== "admitted") fail("invalid_prepare_phase", "Command preparation requires a never-launched operation.");
      },
      bindCommandExecution: (executionId: string) => { this.bindEvidence(handle, { kind: "host_command", id: executionId }); },
      registerPreparation: (producerId: string): HostCommandPreparationOperation => {
        const child = this.registerProducer(handle, "command", producerId);
        const trackedChild = this.#operation(child);
        return Object.freeze({
          effectGuard: Object.freeze({
            launch: <T>(effect: () => T): T => trackedChild.launched
              ? this.continueHostEffect(child, effect) : this.launchHostEffect(child, effect),
            cleanup: <T>(effect: () => T): T => this.continueHostEffect(child, effect, "cleanup"),
          }),
          finish: () => {
            if (trackedChild.launched) { this.markUnknown(child, "command_preparation_scope_unverified"); return; }
            try { this.settleNoStart(child); }
            catch (error) {
              this.markUnknown(child, "command_preparation_admission_unconfirmed");
              throw error;
            }
          },
        });
      },
      launch: <T>(ticket: HostCommandExecutionTicket, effect: () => T): T => {
        this.#assertUnsettled(operation);
        this.#group.assertMayLaunch(operation.groupTicket);
        if (operation.launched) fail("already_launched", "Host command has already entered effect launch.");
        this.#assertSynchronousEffect(effect);
        return this.#store.launchTrackedHostCommandExecution(this.#requireDurableTicket(operation), ticket, () =>
          this.#group.launchHostEffect(operation.groupTicket, () => {
            operation.launched = true; // Never reset after effect/COMMIT failure.
            return effect();
          }));
      },
      settleNoStart: () => { this.settleNoStart(handle); },
      markUnknown: (code: string) => { this.markUnknown(handle, code); },
    });
  }

  /** Bind the original MCP parent and fixed binary writer before any syscall. */
  prepareOfficeLocalExecution(parent: AttemptHostOperationHandle, producer: AttemptHostOperationHandle,
    input: PrepareHostOfficeLocalInput): HostOfficeLocalTicket {
    const pair = { parent: this.#operation(parent), transport: this.#operation(producer) };
    if (parent.kind !== "mcp" || producer.kind !== "file_mutation" || producer.parentOperationId !== parent.operationId
      || producer.producerId !== "office-local-binary") fail("invalid_office_pair", "Office requires its original reserved binary writer.");
    this.#assertMediaMayLaunch(pair);
    const ticket = this.#store.prepareHostOfficeLocalExecution(this.#requireDurableTicket(pair.parent),
      this.#requireDurableTicket(pair.transport), input);
    this.#officeExecutions.set(ticket, pair);
    this.#officeEffects.set(ticket, new Map());
    this.#read(pair.parent); this.#read(pair.transport);
    return ticket;
  }

  prepareOfficeLocalEffect(ticket: HostOfficeLocalTicket, input: PrepareHostOfficeLocalEffect): HostOfficeLocalEffectRecord {
    this.assertOfficeLocalPlanOpen(ticket);
    const pair = this.#officeExecution(ticket);
    const captured: PrepareHostOfficeLocalEffect = JSON.parse(JSON.stringify(input));
    this.#assertMediaUnsettled(pair);
    if (captured.mode !== "cleanup") this.#assertMediaMayLaunch(pair);
    const record = this.#store.prepareHostOfficeLocalEffect(ticket, captured);
    this.#officeEffects.get(ticket)!.set(record.effectId, Object.freeze({ ...record }));
    return record;
  }

  /** Binary syscalls enter both original local barriers inside Core's atomic pair gate. */
  launchOfficeLocalEffect<T>(ticket: HostOfficeLocalTicket, effectId: string, effect: () => T,
    mode: "forward" | "cleanup"): T {
    this.assertOfficeLocalPlanOpen(ticket);
    const pair = this.#officeExecution(ticket);
    const descriptor = this.#officeEffects.get(ticket)!.get(effectId);
    if (!descriptor || descriptor.mode !== mode) fail("invalid_office_effect", "Office launch mode must match its exact prepared effect.");
    this.#assertSynchronousEffect(effect); this.#assertMediaUnsettled(pair);
    if (mode !== "forward" && mode !== "cleanup") fail("invalid_effect_mode", "Invalid Office effect mode.");
    if (mode === "forward") this.#assertMediaMayLaunch(pair);
    else if (!pair.parent.launched || !pair.transport.launched) fail("not_launched", "Unentered Office execution has no cleanup authority.");
    return this.#store.launchHostOfficeLocalEffect(ticket, effectId, () => {
      this.#assertMediaUnsettled(pair);
      if (mode === "forward") this.#assertMediaMayLaunch(pair);
      const parentEntered = pair.parent.launched, producerEntered = pair.transport.launched;
      pair.parent.launched = true; pair.transport.launched = true;
      const launchProducer = (): T => producerEntered ? effect() : this.#group.launchHostEffect(pair.transport.groupTicket, effect);
      return parentEntered ? launchProducer() : this.#group.launchHostEffect(pair.parent.groupTicket, launchProducer);
    });
  }

  recordOfficeLocalObservation(ticket: HostOfficeLocalTicket, effectId: string, artifactId: string): HostOfficeLocalEffectRecord {
    this.#assertMediaUnsettled(this.#officeExecution(ticket));
    return this.#store.recordHostOfficeLocalObservation(ticket, effectId, artifactId);
  }

  /** Freeze original-owner facts only. A terminal seal is never a group settlement proof. */
  sealOfficeLocalTerminal(ticket: HostOfficeLocalTicket, input: SealHostOfficeLocalTerminalInput): HostOfficeLocalTerminalRecord {
    this.#assertMediaUnsettled(this.#officeExecution(ticket));
    return this.#store.sealHostOfficeLocalTerminal(ticket, input);
  }

  /** Core settles the original pair atomically; only then may either local barrier close. */
  settleOfficeLocalFromStore(ticket: HostOfficeLocalTicket): HostOfficeLocalSettlement {
    const pair = this.#officeExecution(ticket);
    if ([pair.parent, pair.transport].some(operation => operation.groupSettlement?.kind === "unknown_outcome"
      || this.#group.getSnapshot().operations.some(row => row.ticket === operation.groupTicket && row.state === "blocked"))) {
      fail("already_settled", "Unknown Office execution cannot be upgraded to a safe receipt.");
    }
    // Local closure precedes Core's independent proof. Pending required children
    // keep their barriers, but can never reopen this original writer plan.
    if (!pair.parent.launched && !pair.transport.launched) this.#officeClosed.add(ticket);
    try { this.#store.settleHostOfficeLocalExecution(ticket); }
    catch {
      // Core retains the first write intent only after all children are ready.
      // An exact original-ticket retry reconciles rollback or a lost COMMIT return.
      this.#store.settleHostOfficeLocalExecution(ticket);
    }
    const producer = this.settleFromStore(pair.transport.handle);
    const parent = this.settleFromStore(pair.parent.handle);
    return { parent, producer };
  }

  /** Original tracker capability only; local closure is a stop, not a no-start receipt. */
  assertOfficeLocalPlanOpen(ticket: HostOfficeLocalTicket): void {
    this.#assertMediaUnsettled(this.#officeExecution(ticket));
    if (this.#officeClosed.has(ticket)) fail("office_local_execution_closed", "Office writer is permanently closed.");
  }

  #officeExecution(ticket: HostOfficeLocalTicket): TrackedMediaExecution {
    return this.#officeExecutions.get(ticket) ?? fail("invalid_office_ticket", "Office capability was not issued through this tracker.");
  }

  /** Bind the two original tracker members to Core's exact Media capability before dispatch. */
  prepareMediaExecution(parent: AttemptHostOperationHandle, transport: AttemptHostOperationHandle,
    input: PrepareHostMediaExecutionInput): HostMediaExecutionTicket {
    const pair = { parent: this.#operation(parent), transport: this.#operation(transport) };
    if (parent.kind !== "media" || transport.kind !== "media" || transport.parentOperationId !== parent.operationId) {
      fail("invalid_media_pair", "Media requires the original parent and its reserved transport producer.");
    }
    this.#assertMediaMayLaunch(pair);
    const ticket = this.#store.prepareHostMediaExecution(this.#requireDurableTicket(pair.parent),
      this.#requireDurableTicket(pair.transport), input);
    this.#mediaExecutions.set(ticket, pair);
    this.#read(pair.parent); this.#read(pair.transport);
    return ticket;
  }

  bindMediaChildExecution(ticket: HostMediaExecutionTicket, child: RuntimeAttemptFenceV1): HostMediaExecutionRecord {
    this.#assertMediaMayLaunch(this.#mediaExecution(ticket));
    return this.#store.bindHostMediaChildExecution(ticket, child);
  }

  prepareMediaEffect(ticket: HostMediaExecutionTicket, input: PrepareHostMediaEffectInput): HostMediaEffectRecord {
    this.#assertMediaMayLaunch(this.#mediaExecution(ticket));
    return this.#store.prepareHostMediaEffect(ticket, input);
  }

  /** Every physical POST uses Core's atomic pair gate and the in-memory barrier inside that gate. */
  launchMediaEffect<T>(ticket: HostMediaExecutionTicket, effectId: string, send: () => T): T {
    const pair = this.#mediaExecution(ticket);
    this.#assertSynchronousEffect(send);
    this.#assertMediaMayLaunch(pair);
    return this.#store.launchHostMediaEffect(ticket, effectId, () => {
      this.#assertMediaMayLaunch(pair);
      const parentEntered = pair.parent.launched, transportEntered = pair.transport.launched;
      // These are irreversible local facts, even if send throws, returns a
      // Promise accidentally, or Core COMMIT subsequently rolls back SQL.
      pair.parent.launched = true; pair.transport.launched = true;
      const launchTransport = (): T => transportEntered ? send()
        : this.#group.launchHostEffect(pair.transport.groupTicket, send);
      return parentEntered ? launchTransport() : this.#group.launchHostEffect(pair.parent.groupTicket, launchTransport);
    });
  }

  /** Fixed Core receipt writers accept sealed artifact IDs, not caller success or stop claims. */
  recordMediaResponse(ticket: HostMediaExecutionTicket, effectId: string, artifactId: string): HostMediaExecutionRecord {
    this.#assertMediaUnsettled(this.#mediaExecution(ticket));
    return this.#store.recordHostMediaResponse(ticket, effectId, artifactId);
  }
  recordMediaSubmission(ticket: HostMediaExecutionTicket, artifactId: string): HostMediaExecutionRecord {
    this.#assertMediaUnsettled(this.#mediaExecution(ticket));
    return this.#store.recordHostMediaSubmission(ticket, artifactId);
  }
  recordMediaSubmissionAndExecutionHandle(ticket: HostMediaExecutionTicket, artifactId: string,
    projection: Parameters<RunStore["recordHostMediaSubmissionAndExecutionHandle"]>[2]): HostMediaExecutionRecord {
    this.#assertMediaUnsettled(this.#mediaExecution(ticket));
    return this.#store.recordHostMediaSubmissionAndExecutionHandle(ticket, artifactId, projection);
  }
  recordMediaTerminal(ticket: HostMediaExecutionTicket, artifactId: string): HostMediaExecutionRecord {
    this.#assertMediaUnsettled(this.#mediaExecution(ticket));
    return this.#store.recordHostMediaTerminal(ticket, artifactId);
  }
  recordMediaArtifactManifest(ticket: HostMediaExecutionTicket, artifactId: string): HostMediaExecutionRecord {
    this.#assertMediaUnsettled(this.#mediaExecution(ticket));
    return this.#store.recordHostMediaArtifactManifest(ticket, artifactId);
  }
  finalizeMediaExecution(ticket: HostMediaExecutionTicket, artifactId: string): HostMediaExecutionRecord {
    this.#assertMediaUnsettled(this.#mediaExecution(ticket));
    return this.#store.finalizeHostMediaExecution(ticket, artifactId);
  }
  recordMediaEffectNoStart(ticket: HostMediaExecutionTicket, effectId: string, artifactId: string): HostMediaExecutionRecord {
    this.#assertMediaUnsettled(this.#mediaExecution(ticket));
    return this.#store.recordHostMediaEffectNoStart(ticket, effectId, artifactId);
  }

  /** Request one fixed Core verification, then read its independently reverified safe journal row. */
  settleMediaFromStore(handle: AttemptHostOperationHandle): HostOperationRecord {
    const operation = this.#operation(handle), previous = this.#read(operation);
    const binding = previous.evidenceRef;
    if (handle.kind !== "media" || !binding || !["media_chain_execution", "media_transport_execution"].includes(binding.kind)) {
      fail("media_evidence_missing", "Media settlement requires an exact immutable Core Media binding.");
    }
    const execution = this.#store.getHostMediaExecution(binding.id);
    if (!execution || !isDeepStrictEqual(execution.source, this.source)
      || (binding.kind === "media_chain_execution" ? execution.parentOperationId : execution.transportOperationId) !== handle.operationId) {
      fail("media_evidence_identity", "Media evidence does not match its captured operation.");
    }
    const kind = previous.phase === "admitted" || previous.settlementKind === "known_no_start" ? "known_no_start"
      : binding.kind === "media_chain_execution" ? "media_chain_completed"
      : execution.protocol === "image_response_v1" ? "media_response_completed" : "media_remote_terminal";
    const ticket = this.#requireDurableTicket(operation);
    const intent = Object.freeze({ kind, settledAt: previous.settlementKind === kind ? previous.settledAt : this.#now() });
    try { this.#store.settleHostOperation(ticket, intent); }
    catch {
      // The Core capability latches this exact settlement even on COMMIT
      // failure. Reconcile it once, before any unknown group intent is latched.
      this.#store.settleHostOperation(ticket, intent);
    }
    return this.settleFromStore(handle);
  }

  #mediaExecution(ticket: HostMediaExecutionTicket): TrackedMediaExecution {
    const execution = this.#mediaExecutions.get(ticket);
    if (!execution) fail("invalid_media_ticket", "Media capability was not issued through this tracker.");
    return execution;
  }
  #assertMediaUnsettled(pair: TrackedMediaExecution): void {
    this.#assertUnsettled(pair.parent); this.#assertUnsettled(pair.transport);
  }
  #assertMediaMayLaunch(pair: TrackedMediaExecution): void {
    this.#assertMediaUnsettled(pair);
    this.#group.assertMayLaunch(pair.parent.groupTicket); this.#group.assertMayLaunch(pair.transport.groupTicket);
  }

  #admit(ticket: HostCallTicket): AttemptHostOperationHandle {
    const handle: AttemptHostOperationHandle = Object.freeze({ [operationHandleBrand]: true as const,
      operationId: ticket.id, source: this.source, kind: ticket.kind, toolCallId: ticket.toolCallId,
      ...(ticket.parentId ? { parentOperationId: ticket.parentId, producerId: ticket.producerId } : {}) });
    const operation: TrackedOperation = { handle, groupTicket: ticket, launched: false };
    this.#operations.set(handle, operation);
    this.#byGroupTicket.set(ticket, operation);
    operation.durableTicket = this.#store.admitHostOperation({ operationId: handle.operationId, source: this.source,
      kind: handle.kind, toolCallId: handle.toolCallId, admittedAt: this.#now(),
      ...(handle.parentOperationId ? { parentOperationId: handle.parentOperationId, producerId: handle.producerId } : {}) });
    if (operation.durableTicket.operationId !== handle.operationId) fail("journal_identity", "Core returned another Host operation identity.");
    this.#read(operation);
    return handle;
  }
  #operation(handle: AttemptHostOperationHandle): TrackedOperation {
    const operation = this.#operations.get(handle);
    if (!operation) fail("invalid_handle", "Invalid Host operation handle: it was not issued by this tracker.");
    return operation;
  }
  #requireDurableTicket(operation: TrackedOperation): HostOperationTicket {
    if (!operation.durableTicket) fail("admission_unconfirmed", "Host operation journal admission is unconfirmed.");
    return operation.durableTicket;
  }
  #assertUnsettled(operation: TrackedOperation): void {
    if (operation.groupSettlement || this.#group.getSnapshot().operations.some(row => row.ticket === operation.groupTicket
      && (row.state === "settled" || row.state === "blocked"))) fail("already_settled", "Settled Host operations cannot execute more effects.");
  }
  #assertSynchronousEffect(effect: () => unknown): void {
    // Validate the real effect before wrapping it. Checking only the Core
    // wrapper lets an async body resume and mutate after transaction rollback.
    if (typeof effect !== "function" || Object.prototype.toString.call(effect) === "[object AsyncFunction]") {
      fail("effect_must_be_synchronous", "Host effect callback must be synchronous.");
    }
  }
  #assertRecord(operation: TrackedOperation, record: HostOperationRecord | undefined): asserts record is HostOperationRecord {
    const handle = operation.handle;
    if (!record || record.schemaVersion !== 1 || record.operationId !== handle.operationId
      || !isDeepStrictEqual(record.source, this.source) || record.kind !== handle.kind || record.toolCallId !== handle.toolCallId
      || record.parentOperationId !== handle.parentOperationId || record.producerId !== handle.producerId) {
      fail("journal_identity", "Host operation journal identity does not match its captured handle.");
    }
  }
  #read(operation: TrackedOperation): HostOperationRecord {
    this.#requireDurableTicket(operation);
    // Core revalidates safe rows against exact immutable domain digests on every
    // read; a raw or guessed toolCallId result is never an accepted receipt.
    const record = this.#store.getHostOperation(operation.handle.operationId);
    this.#assertRecord(operation, record);
    return record;
  }
  #proof(operation: TrackedOperation, record: HostOperationRecord): HostExecutorSettlement {
    if (!record.settledAt) fail("settlement_unconfirmed", "Host operation settlement is unconfirmed.");
    if (record.phase === "unknown_outcome" && record.settlementKind === "unknown_outcome" && record.code) {
      return this.#unknownProof(operation, { code: record.code, settledAt: record.settledAt });
    }
    if (record.phase !== "safe" || !record.evidenceDigest) fail("settlement_unconfirmed", "Host operation settlement is unconfirmed.");
    const base = { schemaVersion: 1 as const, source: this.source, operationId: operation.handle.operationId,
      evidenceRef: `host_operation:${record.operationId}:${record.evidenceDigest}`, settledAt: record.settledAt };
    if (record.settlementKind === "known_no_start" && !operation.launched && !record.launchedAt) {
      return Object.freeze({ ...base, kind: "known_no_start" });
    }
    if (record.settlementKind === "file_completed" && record.kind === "file_mutation"
      && record.evidenceRef?.kind === "harness_tool_execution") {
      return Object.freeze({ ...base, kind: "completed_persisted", physicalScope: "entire_operation", effects: "persisted" });
    }
    if (record.kind === "mcp" && record.settlementKind === "office_local_chain_completed"
      && record.evidenceRef?.kind === "office_local_chain_execution"
      || record.kind === "file_mutation" && record.settlementKind === "office_local_binary_completed"
        && record.evidenceRef?.kind === "office_local_binary_execution") {
      return Object.freeze({ ...base, kind: "completed_persisted", physicalScope: "entire_operation", effects: "persisted" });
    }
    if (record.kind === "media" && (record.settlementKind === "media_chain_completed" && record.evidenceRef?.kind === "media_chain_execution"
      || ["media_response_completed", "media_remote_terminal"].includes(String(record.settlementKind))
        && record.evidenceRef?.kind === "media_transport_execution")) {
      return Object.freeze({ ...base, kind: "completed_persisted", physicalScope: "entire_operation", effects: "persisted" });
    }
    fail("settlement_unconfirmed", "Host operation settlement is unconfirmed.");
  }
  #unknownProof(operation: TrackedOperation, intent: { readonly code: string; readonly settledAt: string }): HostExecutorSettlement {
    return Object.freeze({ schemaVersion: 1, source: this.source, operationId: operation.handle.operationId,
      kind: "unknown_outcome", evidenceRef: `host_operation:${operation.handle.operationId}:unknown`, ...intent });
  }
  #verifySafeSettlement(ticket: HostCallTicket, proof: HostExecutorSettlement): boolean {
    const operation = this.#byGroupTicket.get(ticket);
    if (!operation || proof.kind === "unknown_outcome") return false;
    try { return isDeepStrictEqual(this.#proof(operation, this.#read(operation)), proof); }
    catch { return false; }
  }
  #verifyPersistedUnknown(blocker: HostExecutorBlocker): boolean {
    const operation = [...this.#operations.values()].find(item => item.handle.operationId === blocker.operationId);
    if (!operation || blocker.state !== "unknown_outcome" || !blocker.settlement) return false;
    try {
      const record = this.#read(operation);
      return record.phase === "unknown_outcome" && isDeepStrictEqual(this.#proof(operation, record), blocker.settlement);
    } catch { return false; }
  }
}

function fail(code: string, message: string): never {
  throw new AttemptHostOperationTrackerError(`attempt_host_operation_${code}`, message);
}
