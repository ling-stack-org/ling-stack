import { createHash } from "node:crypto";
import { join } from "node:path";
import { digestHarnessToolValue } from "../../dist/harness/tool-executions.js";
import { directoryV2Identity, directoryV2Prepared } from "./host-office-local-directory-v2-fixture.mjs";

/** JSON DTO copy only. This never restores a native session, capability or ticket. */
export const directoryV2ReplayClone = value => JSON.parse(JSON.stringify(value));
const clone = directoryV2ReplayClone;
const hash = value => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const bytesHash = value => createHash("sha256").update(value).digest("hex");
const preparedFacts = ({ preparedArtifactId, preparedDigest, identityDigest, revision, ...prepared }) => prepared;
const effectFacts = ({ executionId, effectDigest, enteredAt, observationArtifactId, revision, ...effect }) => effect;
const terminalFacts = ({ terminalArtifactId, terminalDigest, effectSetDigest, effectCount, sealedAt, ...terminal }) => terminal;

/**
 * Recompute only seal/domain digests after a semantic mutation. Deliberately do
 * not repair source, IDs, call references, native facts, ordering or resources:
 * negative tests must still reach the fixed-graph verifier with those defects.
 * This operates on controlled test DTOs, not genuine immutable Core artifacts.
 */
export function resealDirectoryV2Replay(input) {
  const { execution, terminal, effects } = input;
  const prepared = preparedFacts(execution);
  execution.preparedDigest = hash(prepared);
  execution.identityDigest = digestHarnessToolValue({ protocol: execution.protocol, prepared,
    preparedArtifactId: execution.preparedArtifactId, preparedDigest: execution.preparedDigest });
  for (const { effect, observation } of effects) {
    effect.effectDigest = digestHarnessToolValue({ protocol: execution.protocol,
      executionIdentityDigest: execution.identityDigest, effect: effectFacts(effect) });
    if (observation) {
      observation.executionIdentityDigest = execution.identityDigest;
      observation.effectDigest = effect.effectDigest;
    }
  }
  terminal.executionIdentityDigest = execution.identityDigest;
  terminal.preparedDigest = execution.preparedDigest;
  terminal.effects = effects.map(({ effect, observation }) => ({ ordinal: effect.ordinal, effectId: effect.effectId,
    effectDigest: effect.effectDigest, enteredAt: effect.enteredAt ?? null,
    observation: effect.observationArtifactId && observation
      ? { artifactId: effect.observationArtifactId, digest: hash(observation) } : null }));
  terminal.effectCount = effects.length;
  terminal.effectSetDigest = digestHarnessToolValue(terminal.effects);
  terminal.terminalDigest = hash(terminalFacts(terminal));
  return input;
}

/**
 * Complete, deterministic pure historical DTO graph. No SQLite, filesystem,
 * native addon, actual OOXML output, scope issuance or kernel execution occurs.
 * The bytes hash describes synthetic fixture bytes only, not an Office artifact.
 *
 * @param {{ directoryCount?: number, sizeBytes?: number, writeChunkSize?: number,
 *   shortWrite?: boolean, eintrWrite?: boolean, shortRead?: boolean,
 *   eintrRead?: boolean, reverseParentSync?: boolean }} [options]
 * @returns {{ execution: object, terminal: object, effects: object[] }}
 */
export function directoryV2ReplayFixture(options = {}) {
  const directoryCount = options.directoryCount ?? 3, sizeBytes = options.sizeBytes ?? 70001;
  const writeChunkSize = options.writeChunkSize ?? Math.max(32768, Math.ceil(sizeBytes / 512));
  if (!Number.isSafeInteger(directoryCount) || directoryCount < 1 || directoryCount > 127
    || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 50 * 1024 * 1024
    || !Number.isSafeInteger(writeChunkSize) || writeChunkSize < 1
    || 2 * directoryCount + Math.ceil(sizeBytes / writeChunkSize) + 10 > 1024) {
    throw new RangeError("directory_v2_replay_fixture_options_invalid");
  }
  let wall = 0, monotonic = 9007199254741000n;
  const tick = () => new Date(Date.UTC(2026, 9, 5) + wall++).toISOString();
  const prepared = directoryV2Prepared({ preparedAt: tick() });
  prepared.output = { bytesSha256: bytesHash(Buffer.alloc(sizeBytes, 0x42)), sizeBytes };
  prepared.members = [];
  let parentSlot = prepared.stage.parentResourceSlotId, stagePath = prepared.stage.parentPath,
    canonicalPath = prepared.destination.parentPath;
  for (let index = 0; index < directoryCount; index++) {
    const resourceSlotId = index === 0 ? "tree" : `directory-${index}`;
    const basename = index === 0 ? prepared.stage.topBasename : `nested-${index}`;
    stagePath = join(stagePath, basename);
    canonicalPath = join(canonicalPath, index === 0 ? prepared.destination.firstMissingComponent : basename);
    prepared.members.push({ memberId: resourceSlotId, kind: "created_directory", resourceSlotId,
      publicationResourceSlotId: `${resourceSlotId}-publication`, parentResourceSlotId: parentSlot,
      basename, canonicalPath, stagePath, initial: "absent" });
    parentSlot = resourceSlotId;
  }
  prepared.targetPath = join(canonicalPath, "report.docx");
  prepared.members.push({ memberId: "file", kind: "created_file", resourceSlotId: "file",
    publicationResourceSlotId: "file-publication", parentResourceSlotId: parentSlot,
    basename: "report.docx", canonicalPath: prepared.targetPath, stagePath: join(stagePath, "report.docx"), initial: "absent" });
  const execution = { ...prepared, preparedArtifactId: "directory-replay-prepared", preparedDigest: "0".repeat(64),
    identityDigest: "0".repeat(64), revision: 0 };
  const nonce = "0123456789abcdef0123456789abcdef";
  const effects = [], resources = [], bindings = new Map(), bySlot = new Map(), closeRefs = new Map(), readbacks = [];
  let phase = "building", residualCreation = false, installation, publication;

  const snapshot = () => clone({ sessionNonce: nonce, phase, resources, installationEntered: !!installation,
    residualCreation, everFailed: false, publicationObservationClaimed: !!publication, cancelRequested: false,
    readbacks, scopeBinding: "unbound", protectedStageVerified: false, coreSafe: false, packaged: false,
    ...(installation ? { installation } : {}), ...(publication ? { publication } : {}) });
  const resource = (slot, kind, basename, parentLifetimeId) => {
    const value = { lifetimeId: `${nonce}:${resources.length + 1}`, kind, basename, parentLifetimeId,
      state: "not_acquired", identityObserved: false, device: "0", inode: "0", bytesWritten: "0", fsyncReturned: false };
    resources.push(value); bySlot.set(slot, value);
    bindings.set(slot, { resourceSlotId: slot, nativeLifetimeId: value.lifetimeId });
    return value;
  };
  const bindingFor = value => bindings.get([...bySlot.entries()].find(([, item]) => item === value)[0]);
  const call = (trace, value, syscall, details = {}) => {
    const returned = details.returned ?? 0;
    const item = { syscall, resourceLifetimeId: value.lifetimeId, parentLifetimeId: value.parentLifetimeId,
      nativeReturnState: "returned", calledAtMonotonicNs: String(++monotonic), returnedAtMonotonicNs: String(++monotonic),
      returned, success: returned === "descriptor_acquired_redacted" || returned >= 0, errno: details.errno ?? 0,
      ...(details.requestedBytes !== undefined ? { requestedBytes: String(details.requestedBytes), offset: String(details.offset) } : {}),
      ...(details.identity ? { identity: clone(details.identity) } : {}), ...(details.entryName ? { entryName: details.entryName } : {}) };
    trace.push(item);
    return item;
  };
  const acquire = (trace, effect, value, syscall, entryName) => {
    bindingFor(value).acquisitionCallRef = { effectId: effect.effectId, ordinal: trace.length };
    call(trace, value, syscall, { returned: "descriptor_acquired_redacted", ...(entryName ? { entryName } : {}) });
    value.state = "retained";
  };
  const stat = (trace, effect, value, identity) => {
    const ordinal = trace.length, actual = call(trace, value, "fstat", { identity });
    if (!value.identityObserved) {
      value.initialIdentity = clone(identity); value.initialObservedAtMonotonicNs = actual.returnedAtMonotonicNs;
      bindingFor(value).firstFstatCallRef = { effectId: effect.effectId, ordinal };
    }
    value.identityObserved = true; value.identity = clone(identity);
    value.device = identity.device; value.inode = identity.inode; value.observedAtMonotonicNs = actual.returnedAtMonotonicNs;
  };
  const close = (trace, effect, value, guarded = false) => {
    if (guarded) stat(trace, effect, value, value.identity);
    closeRefs.set(bindingFor(value).resourceSlotId, { effectId: effect.effectId, ordinal: trace.length });
    call(trace, value, "close"); value.state = "closed";
  };
  const append = (kind, details, invoke) => {
    const ordinal = effects.length;
    const effect = { effectId: `effect-${ordinal}`, ordinal, kind, mode: "forward", preparedAt: tick(), ...details,
      executionId: execution.executionId, effectDigest: "0".repeat(64), enteredAt: tick(),
      observationArtifactId: `directory-replay-observation-${ordinal}`, revision: 2 };
    const calledAt = tick(), trace = [], extra = invoke(effect, trace) ?? {}, returnedAt = tick();
    const { observationDetails = {}, ...resultDetails } = extra;
    const result = { success: true, nativeOutcome: "returned", hostAcknowledgment: "not_provided",
      operationId: kind === "capture_parents" || kind === "close_session" ? "" : effect.effectId,
      calls: clone(trace), snapshot: snapshot(), ...clone(resultDetails) };
    const observation = { schemaVersion: 2, protocol: execution.protocol, kind: "office_local_directory_effect_v2",
      executionId: execution.executionId, executionIdentityDigest: execution.identityDigest, source: clone(execution.source),
      effectId: effect.effectId, effectDigest: effect.effectDigest, native: { state: "returned", calledAt, returnedAt, result },
      host: { state: "returned" }, resourceBindings: clone([...bindings.values()]), ...clone(observationDetails), completedAt: tick() };
    effects.push({ effect, observation });
    return effect;
  };
  const read = (effect, value, identity) => {
    const trace = [];
    stat(trace, effect, value, identity);
    let offset = 0, first = true, attempts = 0;
    while (offset < sizeBytes) {
      const requested = Math.min(65536, sizeBytes - offset);
      if (first && options.eintrRead) {
        call(trace, value, "pread", { requestedBytes: requested, offset, returned: -1, errno: 4 }); attempts++;
      }
      const returned = first && options.shortRead ? Math.max(1, Math.floor(requested / 2)) : requested;
      call(trace, value, "pread", { requestedBytes: requested, offset, returned }); attempts++;
      offset += returned; first = false;
    }
    call(trace, value, "pread_eof_probe", { requestedBytes: 1, offset: sizeBytes, returned: 0 }); attempts++;
    stat(trace, effect, value, identity);
    const fact = { operationId: effect.effectId, resourceLifetimeId: value.lifetimeId, expectedBytes: String(sizeBytes),
      budgetBytes: String(sizeBytes + 1), bytesRead: String(sizeBytes), maximumSyscallAttempts: String(Math.ceil(sizeBytes / 65536) + 33),
      syscallAttempts: String(attempts), eofObserved: true, identitiesMatch: true, success: true, nativeOutcome: "returned_success",
      calls: trace, identityBefore: clone(identity), identityAfter: clone(identity) };
    readbacks.push(clone(fact));
    return fact;
  };

  append("capture_parents", {}, (effect, trace) => {
    for (const role of ["stage", "destination"]) {
      let parent = "";
      for (const [index, ancestor] of execution[role].ancestors.entries()) {
        const kind = index === execution[role].ancestors.length - 1 ? `${role}_parent` : "ancestor";
        const value = resource(ancestor.resourceSlotId, kind, ancestor.path === "/" ? "/" : ancestor.path.split("/").at(-1), parent);
        acquire(trace, effect, value, index === 0 ? "open" : "openat"); stat(trace, effect, value, ancestor.identity);
        parent = value.lifetimeId;
      }
    }
  });
  for (const [index, member] of execution.members.entries()) {
    const parent = bySlot.get(member.parentResourceSlotId), file = member.kind === "created_file";
    append(file ? "create_file" : "create_directory", { resourceSlotId: member.resourceSlotId,
      parentResourceSlotId: member.parentResourceSlotId, parentNativeLifetimeId: parent.lifetimeId, basename: member.basename }, (effect, trace) => {
      const value = resource(member.resourceSlotId, member.kind, member.basename, parent.lifetimeId);
      if (!file) { call(trace, value, "mkdirat"); residualCreation = true; }
      acquire(trace, effect, value, file ? "openat_create_exclusive" : "openat");
      stat(trace, effect, value, directoryV2Identity(file ? 200 : 100 + index, file));
      parent.fsyncReturned = false;
      return { resourceFact: value };
    });
  }
  const file = bySlot.get("file"), fileDetails = { resourceSlotId: "file", nativeLifetimeId: file.lifetimeId };
  for (let effectOffset = 0; effectOffset < sizeBytes;) {
    const count = Math.min(writeChunkSize, sizeBytes - effectOffset), start = effectOffset;
    append("write_file", { ...fileDetails, offset: start, sizeBytes: count }, (effect, trace) => {
      file.fsyncReturned = false;
      let written = 0, first = true;
      while (written < count) {
        const requested = Math.min(65536, count - written), offset = start + written;
        if (first && options.eintrWrite) call(trace, file, "write", { requestedBytes: requested, offset, returned: -1, errno: 4 });
        const returned = first && options.shortWrite ? Math.max(1, Math.floor(requested / 2)) : requested;
        call(trace, file, "write", { requestedBytes: requested, offset, returned });
        written += returned; first = false; file.bytesWritten = String(start + written);
      }
      return { resourceFact: file, maximumSyscallAttempts: String(Math.ceil(count / 65536) + 32), syscallAttempts: String(trace.length) };
    });
    effectOffset += count;
  }
  const sync = slot => {
    const value = bySlot.get(slot);
    append("fsync_resource", { resourceSlotId: slot, nativeLifetimeId: value.lifetimeId }, (effect, trace) => {
      call(trace, value, "fsync"); value.fsyncReturned = true; return { resourceFact: value };
    });
  };
  sync("file");
  const fileIdentity = { ...clone(file.initialIdentity), sizeBytes: String(sizeBytes), modifiedNs: "200", changedNs: "200" };
  append("read_file", { ...fileDetails, expectedBytes: sizeBytes, budgetBytes: sizeBytes + 1 }, (effect, trace) => {
    const readback = read(effect, file, fileIdentity); trace.push(...readback.calls);
    return { resourceFact: file, readback, observationDetails: { readbackBytes: clone(execution.output) } };
  });
  append("close_resource", fileDetails, (effect, trace) => { close(trace, effect, file); return { resourceFact: file }; });
  for (const member of execution.members.slice(0, -1).reverse()) sync(member.resourceSlotId);
  const tree = bySlot.get("tree"), stageParent = bySlot.get(execution.stage.parentResourceSlotId),
    destinationParent = bySlot.get(execution.destination.parentResourceSlotId);
  append("install_tree", { resourceSlotId: "tree", nativeLifetimeId: tree.lifetimeId,
    sourceParentResourceSlotId: execution.stage.parentResourceSlotId, sourceParentNativeLifetimeId: stageParent.lifetimeId,
    sourceBasename: execution.stage.topBasename, destinationParentResourceSlotId: execution.destination.parentResourceSlotId,
    destinationParentNativeLifetimeId: destinationParent.lifetimeId, destinationBasename: execution.destination.firstMissingComponent,
    flags: "RENAME_EXCL" }, (effect, trace) => {
    const actual = call(trace, tree, "renameatx_np_RENAME_EXCL");
    installation = { treeLifetimeId: tree.lifetimeId, sourceParentLifetimeId: stageParent.lifetimeId,
      destinationParentLifetimeId: destinationParent.lifetimeId, destinationName: execution.destination.firstMissingComponent,
      entries: execution.members.map(member => { const value = bySlot.get(member.resourceSlotId);
        return { resourceLifetimeId: value.lifetimeId, parentLifetimeId: value.parentLifetimeId, expectedBytes: value.bytesWritten }; }),
      entered: true, nativeReturnState: "returned", calledAtMonotonicNs: actual.calledAtMonotonicNs,
      returnedAtMonotonicNs: actual.returnedAtMonotonicNs, returned: 0, errno: 0 };
    phase = "published_native_only"; residualCreation = false;
    stageParent.fsyncReturned = false; destinationParent.fsyncReturned = false;
    return { resourceFact: tree };
  });
  const parentSlots = [execution.stage.parentResourceSlotId, execution.destination.parentResourceSlotId];
  for (const slot of options.reverseParentSync ? parentSlots.reverse() : parentSlots) sync(slot);
  append("observe_publication", { resourceSlotId: "tree", nativeLifetimeId: tree.lifetimeId, budgetBytes: sizeBytes + 1 }, (effect, trace) => {
    const entries = execution.members.map((member, index) => {
      const original = bySlot.get(member.resourceSlotId), parent = index === 0 ? destinationParent : bySlot.get(execution.members[index - 1].publicationResourceSlotId);
      const observed = resource(member.publicationResourceSlotId, member.kind === "created_file" ? "publication_file" : "publication_directory",
        index === 0 ? execution.destination.firstMissingComponent : member.basename, parent.lifetimeId);
      return { originalLifetimeId: original.lifetimeId, observedLifetimeId: observed.lifetimeId };
    });
    const destinationIdentity = { ...clone(destinationParent.identity), modifiedNs: "400", changedNs: "400" };
    stat(trace, effect, destinationParent, destinationIdentity);
    for (const [index, member] of execution.members.entries()) {
      const observed = bySlot.get(member.publicationResourceSlotId), original = bySlot.get(member.resourceSlotId);
      acquire(trace, effect, observed, "openat", observed.basename);
      const identity = member.kind === "created_file" ? fileIdentity : { ...clone(original.initialIdentity), modifiedNs: "300", changedNs: "300" };
      stat(trace, effect, observed, identity);
      if (member.kind === "created_file") {
        entries[index].readback = read(effect, observed, identity); trace.push(...entries[index].readback.calls);
      }
    }
    for (const member of execution.members) {
      const observed = bySlot.get(member.publicationResourceSlotId);
      call(trace, observed, "fstatat_no_follow", { identity: observed.identity, entryName: observed.basename });
    }
    stat(trace, effect, destinationParent, destinationIdentity);
    for (const member of execution.members.slice().reverse()) close(trace, effect, bySlot.get(member.publicationResourceSlotId), true);
    publication = { operationId: effect.effectId, observationBasis: "original_destination_parent_relative",
      expectedBytes: String(sizeBytes), budgetBytes: String(sizeBytes + 1),
      maximumCalls: String(2 + 5 * execution.members.length + Math.ceil(sizeBytes / 65536) + 35),
      success: true, nativeOutcome: "returned_success", entries, calls: clone(trace) };
    return { publication, observationDetails: { publicationBytes: [{ originalLifetimeId: file.lifetimeId,
      observedLifetimeId: bySlot.get("file-publication").lifetimeId, ...clone(execution.output) }] } };
  });
  append("close_session", {}, (effect, trace) => {
    for (const value of resources.slice().reverse()) if (value.state === "retained") close(trace, effect, value);
    phase = "closed";
  });
  const terminal = { schemaVersion: 2, protocol: execution.protocol, kind: "office_local_directory_terminal_v2",
    executionId: execution.executionId, executionIdentityDigest: execution.identityDigest, source: clone(execution.source),
    preparedArtifactId: execution.preparedArtifactId, preparedDigest: execution.preparedDigest,
    outcome: "published_native_only", installationEntered: true, effects: [],
    resources: [...bindings.values()].map(binding => ({ ...clone(binding), state: "closed", closeCallRef: clone(closeRefs.get(binding.resourceSlotId)) })),
    canonicalVisibility: { state: "unverified", blockerCode: "directory_v2_fixture_scope_and_canonical_unverified" }, completedAt: tick(),
    terminalArtifactId: "directory-replay-terminal", terminalDigest: "0".repeat(64), effectSetDigest: "0".repeat(64),
    effectCount: effects.length, sealedAt: tick() };
  return resealDirectoryV2Replay({ execution, terminal, effects });
}
