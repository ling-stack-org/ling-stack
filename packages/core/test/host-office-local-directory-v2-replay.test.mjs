import assert from "node:assert/strict";
import test from "node:test";
import { verifyOfficeLocalDirectoryReplayV2 } from "../dist/index.js";
import { validateOfficeLocalDirectoryObservationPayloadV2 } from "../dist/storage/sqlite/host-office-local-directory-v2-observations.js";
import { validateOfficeLocalDirectoryTerminalPayloadV2 } from "../dist/storage/sqlite/host-office-local-directory-v2-terminal.js";
import { directoryV2ReplayClone as clone, directoryV2ReplayFixture as fixture,
  resealDirectoryV2Replay as reseal } from "./support/host-office-local-directory-v2-replay-fixture.mjs";

const invalid = error => error.code === "host_office_local_directory_v2_evidence_invalid";
const entry = (input, kind, slot) => input.effects.find(value => value.effect.kind === kind
  && (slot === undefined || value.effect.resourceSlotId === slot));
const result = (input, kind, slot) => entry(input, kind, slot).observation.native.result;
const lifetime = (input, slot) => input.effects.at(-1).observation.resourceBindings
  .find(value => value.resourceSlotId === slot).nativeLifetimeId;

/** Edit every JSON copy of one fact, without repairing the changed semantics. */
function walk(value, change) {
  if (!value || typeof value !== "object") return;
  change(value);
  for (const child of Object.values(value)) walk(child, change);
}
function calls(input, match, change) {
  walk(input, value => { if (typeof value.syscall === "string" && match(value)) change(value); });
}
function resources(input, slot, change) {
  const id = lifetime(input, slot);
  walk(input, value => { if (value.lifetimeId === id && typeof value.kind === "string") change(value); });
}
function bindings(input, slot, change) {
  // Effects also carry slot/lifetime parameters, but they are not binding facts.
  // Mutate only actual binding copies so reference-negative fixtures reach the verifier.
  for (const values of [...input.effects.map(value => value.observation.resourceBindings), input.terminal.resources]) {
    for (const value of values) if (value.resourceSlotId === slot) change(value);
  }
}
function readbacks(input, kind, change) {
  const effectId = entry(input, kind).effect.effectId;
  walk(input, value => {
    if (value.operationId === effectId && Object.hasOwn(value, "eofObserved")) change(value);
  });
}
function publications(input, change) {
  walk(input, value => { if (value.observationBasis === "original_destination_parent_relative") change(value); });
}
/** Keep actual outer trace copies and call refs coherent so fixed-graph checks see the defect. */
function removePublicationCall(input, ordinal) {
  const effectId = entry(input, "observe_publication").effect.effectId;
  result(input, "observe_publication").calls.splice(ordinal, 1);
  publications(input, value => value.calls.splice(ordinal, 1));
  walk(input, value => {
    for (const key of ["acquisitionCallRef", "firstFstatCallRef", "closeCallRef"]) {
      const ref = value[key];
      if (ref?.effectId === effectId && ref.ordinal > ordinal) ref.ordinal--;
    }
  });
}
function advanceClocks(input, pivot) {
  walk(input, value => {
    for (const key of ["calledAtMonotonicNs", "returnedAtMonotonicNs", "initialObservedAtMonotonicNs", "observedAtMonotonicNs"]) {
      if (typeof value[key] === "string" && BigInt(value[key]) >= pivot) value[key] = String(BigInt(value[key]) + 2n);
    }
  });
}
function insertPublicationCall(input, ordinal, sourceOrdinal) {
  const effectId = entry(input, "observe_publication").effect.effectId, trace = result(input, "observe_publication").calls;
  const extra = clone(trace[sourceOrdinal]), pivot = BigInt(trace[ordinal].calledAtMonotonicNs);
  advanceClocks(input, pivot);
  extra.calledAtMonotonicNs = String(pivot); extra.returnedAtMonotonicNs = String(pivot + 1n);
  trace.splice(ordinal, 0, extra);
  publications(input, value => value.calls.splice(ordinal, 0, clone(extra)));
  walk(input, value => {
    for (const key of ["acquisitionCallRef", "firstFstatCallRef", "closeCallRef"]) {
      const ref = value[key];
      if (ref?.effectId === effectId && ref.ordinal >= ordinal) ref.ordinal++;
    }
  });
}
/** Rebind times/ordinals only; never repair the reordered graph or snapshot states. */
function restampReorderedHistory(input) {
  const clockMap = new Map(); let monotonic = 9007199254741000n, wall = 1;
  const tick = () => new Date(Date.UTC(2026, 9, 5) + wall++).toISOString();
  input.effects.forEach(({ effect, observation }, ordinal) => {
    effect.ordinal = ordinal; effect.preparedAt = tick(); effect.enteredAt = tick();
    observation.native.calledAt = tick(); observation.native.returnedAt = tick(); observation.completedAt = tick();
    for (const call of observation.native.result.calls) {
      clockMap.set(call.calledAtMonotonicNs, String(++monotonic));
      clockMap.set(call.returnedAtMonotonicNs, String(++monotonic));
    }
  });
  walk(input, value => {
    for (const key of ["calledAtMonotonicNs", "returnedAtMonotonicNs", "initialObservedAtMonotonicNs", "observedAtMonotonicNs"]) {
      if (clockMap.has(value[key])) value[key] = clockMap.get(value[key]);
    }
  });
  input.terminal.completedAt = tick(); input.terminal.sealedAt = tick();
}
function assertBaseContracts(input) {
  for (const value of input.effects) assert.deepEqual(validateOfficeLocalDirectoryObservationPayloadV2(
    input.execution, value.effect, value.observation, input.terminal.completedAt), value.observation);
  const { terminalArtifactId, terminalDigest, effectSetDigest, effectCount, sealedAt, ...manifest } = input.terminal;
  assert.deepEqual(validateOfficeLocalDirectoryTerminalPayloadV2(input.execution, manifest, input.effects), manifest);
}
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

// Controlled DTO graph only: these tests do not run SQLite, native syscalls, Office
// production, a Host scope issuer, canonical namespace checks or safe settlement.
for (const [label, options] of [
  ["complete nested three-directory graph", {}],
  ["single-directory one-byte graph", { directoryCount: 1, sizeBytes: 1 }],
  ["reversed adjacent parent fsync order", { reverseParentSync: true }],
  ["positive short writes and reads with finite EINTR", { shortWrite: true, shortRead: true, eintrWrite: true, eintrRead: true }],
  ["multiple 64KiB syscalls within one write effect", { sizeBytes: 150001, writeChunkSize: 150001 }],
]) test(`directory v2 replay accepts ${label} only as a graph-only proof`, () => {
  const input = fixture(options), before = JSON.stringify(input);
  const proof = verifyOfficeLocalDirectoryReplayV2(input);
  assert.deepEqual(proof, { kind: "graph_verified_only", executionId: input.execution.executionId,
    executionIdentityDigest: input.execution.identityDigest, targetMemberId: "file", effectCount: input.effects.length,
    resourceCount: input.terminal.resources.length,
    callCount: input.effects.reduce((count, value) => count + value.observation.native.result.calls.length, 0),
    coreSafe: false, canonicalVisibility: "unverified", scopeBinding: "unbound", packaged: false });
  assert.equal(Object.isFrozen(proof), true);
  assert.equal(JSON.stringify(input), before);
});
test("directory v2 replay allows separate existing ancestor lifetimes to alias one inode", () => {
  const input = fixture(), stage = input.execution.stage.ancestors[0], destination = input.execution.destination.ancestors[0];
  assert.deepEqual(stage.identity, destination.identity);
  assert.notEqual(lifetime(input, stage.resourceSlotId), lifetime(input, destination.resourceSlotId));
  assert.equal(verifyOfficeLocalDirectoryReplayV2(input).kind, "graph_verified_only");
});
test("directory v2 replay retains exact clocks above 2^53 without inventing epoch correspondence", () => {
  const input = fixture(), actual = input.effects[0].observation.native.result.calls[0];
  assert.ok(BigInt(actual.calledAtMonotonicNs) > 2n ** 53n);
  assert.equal(verifyOfficeLocalDirectoryReplayV2(input).kind, "graph_verified_only");
});
test("directory v2 replay consumes frozen input without mutating nested facts or repeated readback copies", () => {
  const input = deepFreeze(fixture()), before = JSON.stringify(input);
  assert.equal(verifyOfficeLocalDirectoryReplayV2(input).resourceCount, 12);
  assert.equal(JSON.stringify(input), before);
  assert.equal(result(input, "close_session").snapshot.readbacks.length, 2);
});
test("directory v2 replay accepts complete returned success with final cleanup-mode close_session", () => {
  const input = fixture(); input.effects.at(-1).effect.mode = "cleanup"; reseal(input);
  assert.equal(verifyOfficeLocalDirectoryReplayV2(input).kind, "graph_verified_only");
});
test("directory v2 replay accepts a finite EINTR retry of the actual EOF probe", () => {
  const input = fixture(), trace = result(input, "read_file").calls;
  const ordinal = trace.findIndex(value => value.syscall === "pread_eof_probe"), extra = clone(trace[ordinal]);
  const pivot = BigInt(extra.calledAtMonotonicNs); advanceClocks(input, pivot);
  Object.assign(extra, { calledAtMonotonicNs: String(pivot), returnedAtMonotonicNs: String(pivot + 1n),
    returned: -1, success: false, errno: 4 });
  trace.splice(ordinal, 0, extra);
  readbacks(input, "read_file", value => {
    value.calls.splice(ordinal, 0, clone(extra)); value.syscallAttempts = String(BigInt(value.syscallAttempts) + 1n);
  });
  reseal(input);
  assert.equal(verifyOfficeLocalDirectoryReplayV2(input).kind, "graph_verified_only");
});
test("directory v2 replay follows native mode-less original node guards while keeping read identity stable", () => {
  const input = fixture(), id = lifetime(input, "file"), observed = result(input, "read_file").calls[0].returnedAtMonotonicNs;
  calls(input, value => value.resourceLifetimeId === id && !!value.identity && BigInt(value.returnedAtMonotonicNs) >= BigInt(observed),
    value => { value.identity.mode = 0o100640; });
  resources(input, "file", value => {
    if (BigInt(value.observedAtMonotonicNs) >= BigInt(observed)) value.identity.mode = 0o100640;
  });
  readbacks(input, "read_file", value => { value.identityBefore.mode = 0o100640; value.identityAfter.mode = 0o100640; });
  reseal(input); assertBaseContracts(input);
  assert.equal(verifyOfficeLocalDirectoryReplayV2(input).kind, "graph_verified_only");
});

const negatives = [
  ["extra input authority field", input => { input.safeReceipt = {}; }],
  ["execution revision drift", input => { input.execution.revision = 1; }],
  ["effect revision drift", input => { input.effects[1].effect.revision = 1; }],
  ["source fence drift in observation", input => { input.effects[0].observation.source.fencingToken = "other-fence"; }],
  ["source fence drift in terminal", input => { input.terminal.source.fencingToken = "other-fence"; }],
  ["mismatched observation execution", input => { input.effects[0].observation.executionId = "other-execution"; }],
  ["effect execution drift", input => { input.effects[1].effect.executionId = "other-execution"; }],
  ["duplicate prepared and terminal artifact ID", input => { input.terminal.terminalArtifactId = input.execution.preparedArtifactId; }],
  ["duplicate observation artifact ID", input => { input.effects[1].effect.observationArtifactId = input.effects[0].effect.observationArtifactId; }],
  ["observation reuses prepared artifact ID", input => { input.effects[0].effect.observationArtifactId = input.execution.preparedArtifactId; }],
  ["duplicate effect ID", input => { input.effects[1].effect.effectId = input.effects[0].effect.effectId; }],
  ["missing observation", input => { input.effects[1].observation = null; }],
  ["noncontiguous ordinal", input => { input.effects[1].effect.ordinal = 2; }],
  ["unentered effect", input => { delete input.effects[1].effect.enteredAt; }],
  ["terminal sealing predates completion", input => { input.terminal.sealedAt = input.execution.preparedAt; }],
  ["terminal completion predates history", input => { input.terminal.completedAt = input.execution.preparedAt; }],
  ["entered wall time predates preparation", input => { input.effects[1].effect.enteredAt = input.execution.preparedAt; }],
  ["next preparation overlaps preceding completed wall envelope", input => { input.effects[1].effect.preparedAt = input.execution.preparedAt; }],
  ["native wall call predates effect entry", input => { input.effects[1].observation.native.calledAt = input.execution.preparedAt; }],
  ["returned wall time follows completion", input => { input.effects[1].observation.native.returnedAt = input.terminal.sealedAt; }],
  ["zero native monotonic clock", input => { input.effects[0].observation.native.result.calls[0].calledAtMonotonicNs = "0"; }],
  ["returned monotonic clock predates call", input => { input.effects[1].observation.native.result.calls[0].returnedAtMonotonicNs = "1"; }],
  ["cross-batch monotonic regression", input => {
    const call = result(input, "create_directory").calls[0]; call.calledAtMonotonicNs = "1"; call.returnedAtMonotonicNs = "2";
  }],
  ["failed terminal", input => { input.terminal.outcome = "failed"; }],
  ["unknown terminal", input => { input.terminal.outcome = "unknown"; }],
  ["non-close effect borrows cleanup mode", input => { input.effects[1].effect.mode = "cleanup"; }],
  ["failed result with superficially closed snapshot", input => { result(input, "close_session").success = false; }],
  ["returned blocker on aggregate success", input => { result(input, "close_session").blockerCode = "original_failure"; }],
  ["unconfirmed Host acknowledgment", input => { input.effects[0].observation.host = { state: "unconfirmed", errorCode: "host_reply_lost" }; }],
  ["native threw despite claimed final success", input => {
    input.effects[0].observation.native = { state: "threw", calledAt: input.effects[0].effect.enteredAt,
      completedAt: input.effects[0].observation.completedAt, errorCode: "native_exception" };
    input.effects[0].observation.host = { state: "unconfirmed", errorCode: "native_exception" };
  }],
  ["unknown actual call", input => {
    const call = result(input, "close_session").calls.at(-1);
    delete call.returned; delete call.success; delete call.errno;
    call.nativeReturnState = "not_returned"; call.returnedAtMonotonicNs = "0";
  }],
  ["snapshot upgrades coreSafe", input => { result(input, "close_session").snapshot.coreSafe = true; }],
  ["snapshot upgrades packaged", input => { result(input, "close_session").snapshot.packaged = true; }],
  ["snapshot binds serialized scope", input => { result(input, "close_session").snapshot.scopeBinding = "bound"; }],
  ["terminal claims canonical visibility", input => { input.terminal.canonicalVisibility.state = "verified"; }],
  ["missing required effect", input => { input.effects.splice(1, 1); }],
  ["reordered creation effects", input => { [input.effects[1], input.effects[2]] = [input.effects[2], input.effects[1]]; }],
  ["extra observer effect", input => { const extra = clone(input.effects[1]); extra.effect.effectId = "extra-observer"; input.effects.push(extra); }],
  ["duplicate install effect", input => { const extra = clone(entry(input, "install_tree")); extra.effect.effectId = "extra-install"; input.effects.splice(-1, 0, extra); }],
  ["creation uses wrong parent slot", input => { entry(input, "create_file").effect.parentResourceSlotId = input.execution.stage.parentResourceSlotId; }],
  ["creation uses wrong parent lifetime", input => { entry(input, "create_file").effect.parentNativeLifetimeId = lifetime(input, input.execution.stage.parentResourceSlotId); }],
  ["creation uses wrong basename", input => { entry(input, "create_file").effect.basename = "other.docx"; }],
  ["file operation borrows another lifetime", input => { entry(input, "write_file").effect.nativeLifetimeId = lifetime(input, "tree"); }],
  ["call borrows original parent lifetime", input => { result(input, "create_file").calls[0].parentLifetimeId = lifetime(input, "tree"); }],
  ["binding changes resource slot", input => { bindings(input, "file", value => { value.resourceSlotId = "tree"; }); }],
  ["binding changes acquired lifetime", input => { input.effects[1].observation.resourceBindings.at(-1).nativeLifetimeId = lifetime(input, input.execution.stage.parentResourceSlotId); }],
  ["borrowed acquisition call reference", input => { bindings(input, "file", value => { value.acquisitionCallRef.ordinal = 1; }); }],
  ["borrowed first fstat call reference", input => { bindings(input, "file", value => { value.firstFstatCallRef.ordinal = 0; }); }],
  ["first fstat incorrectly rewritten by later observation", input => {
    bindings(input, "file", value => { value.firstFstatCallRef = { effectId: entry(input, "read_file").effect.effectId, ordinal: 0 }; });
  }],
  ["new created directory aliases existing inode coherently", input => {
    const id = lifetime(input, "tree"), observer = lifetime(input, "tree-publication"), inode = input.execution.stage.ancestors.at(-1).identity.inode;
    calls(input, value => [id, observer].includes(value.resourceLifetimeId) && !!value.identity, value => { value.identity.inode = inode; });
    for (const slot of ["tree", "tree-publication"]) resources(input, slot, value => {
      value.inode = inode; value.initialIdentity.inode = inode; value.identity.inode = inode;
    });
  }, {}, true],
  ["new created directories alias each other coherently", input => {
    const inode = result(input, "create_directory", "tree").resourceFact.inode;
    const ids = [lifetime(input, "directory-1"), lifetime(input, "directory-1-publication")];
    calls(input, value => ids.includes(value.resourceLifetimeId) && !!value.identity, value => { value.identity.inode = inode; });
    for (const slot of ["directory-1", "directory-1-publication"]) resources(input, slot, value => {
      value.inode = inode; value.initialIdentity.inode = inode; value.identity.inode = inode;
    });
  }, {}, true],
  ["created file starts nonempty coherently", input => {
    const created = result(input, "create_file"), initial = created.calls[1].returnedAtMonotonicNs;
    calls(input, value => value.returnedAtMonotonicNs === initial, value => { value.identity.sizeBytes = "1"; });
    resources(input, "file", value => {
      value.initialIdentity.sizeBytes = "1";
      if (value.observedAtMonotonicNs === initial) value.identity.sizeBytes = "1";
    });
  }, {}, true],
  ["write skips an output offset", input => { entry(input, "write_file").effect.offset = 1; }],
  ["write returns zero progress", input => { result(input, "write_file").calls[0].returned = 0; }],
  ["write retries non-EINTR failure", input => { Object.assign(result(input, "write_file").calls[0], { returned: -1, success: false, errno: 5 }); }],
  ["write has unbounded attempt budget", input => { result(input, "write_file").maximumSyscallAttempts = "832"; }],
  ["write lacks aggregate syscall attempt count", input => { delete result(input, "write_file").syscallAttempts; }],
  ["write syscall returns more than requested", input => { result(input, "write_file").calls[0].returned = 65536; }],
  ["write snapshots invent bytes without actual call", input => { result(input, "write_file").calls = []; result(input, "write_file").syscallAttempts = "0"; }],
  ["read lacks true EOF", input => {
    readbacks(input, "read_file", value => { value.eofObserved = false; });
  }],
  ["read EOF probe returns additional byte", input => {
    const id = lifetime(input, "file"); calls(input, value => value.resourceLifetimeId === id && value.syscall === "pread_eof_probe", value => { value.returned = 1; });
  }],
  ["read reports wrong bytes hash", input => { entry(input, "read_file").observation.readbackBytes.bytesSha256 = "a".repeat(64); }],
  ["readback before and after identities differ", input => { readbacks(input, "read_file", value => { value.identityAfter.changedNs = "201"; }); }],
  ["read offset skips returned bytes", input => {
    const id = lifetime(input, "file"); calls(input, value => value.resourceLifetimeId === id && value.syscall === "pread", value => { value.offset = "1"; });
  }],
  ["read snapshots claim size before native fstat", input => { result(input, "fsync_resource", "file").snapshot.resources.at(-1).identity.sizeBytes = String(input.execution.output.sizeBytes); }],
  ["read returns zero before expected length", input => {
    const id = lifetime(input, "file"); calls(input, value => value.resourceLifetimeId === id && value.syscall === "pread", value => { value.returned = 0; });
  }],
  ["file fsync missing but snapshot says synced", input => { const at = input.effects.indexOf(entry(input, "fsync_resource", "file")); input.effects.splice(at, 1); }],
  ["file fsync result is only a snapshot flag", input => { result(input, "fsync_resource", "file").calls = []; }],
  ["post-install destination parent sync omitted", input => {
    const at = input.effects.indexOf(entry(input, "fsync_resource", input.execution.destination.parentResourceSlotId)); input.effects.splice(at, 1);
  }],
  ["install overwrites destination", input => { entry(input, "install_tree").effect.flags = "RENAME_REPLACE"; }],
  ["install member roster omits file", input => { walk(input, value => { if (value.treeLifetimeId && value.destinationName) value.entries.pop(); }); }],
  ["install parent scope drifts", input => { entry(input, "install_tree").effect.destinationParentNativeLifetimeId = lifetime(input, input.execution.stage.parentResourceSlotId); }],
  ["publication borrows pre-install read", input => {
    const read = clone(result(input, "read_file").readback);
    publications(input, value => { value.entries.at(-1).readback = clone(read); });
  }],
  ["publication reports wrong bytes hash", input => { entry(input, "observe_publication").observation.publicationBytes[0].bytesSha256 = "a".repeat(64); }],
  ["publication roster incomplete", input => { publications(input, value => { value.entries.pop(); }); }],
  ["publication observer open uses wrong name", input => {
    const id = lifetime(input, "tree-publication"); calls(input, value => value.resourceLifetimeId === id && value.syscall === "openat", value => { value.entryName = "other"; });
  }],
  ["publication first destination guard missing with refs adjusted", input => { removePublicationCall(input, 0); }, {}, true],
  ["publication second destination guard missing with refs adjusted", input => {
    const id = lifetime(input, input.execution.destination.parentResourceSlotId), trace = result(input, "observe_publication").calls;
    removePublicationCall(input, trace.findLastIndex(value => value.syscall === "fstat" && value.resourceLifetimeId === id));
  }, {}, true],
  ["publication name fence missing with refs adjusted", input => {
    removePublicationCall(input, result(input, "observe_publication").calls.findIndex(value => value.syscall === "fstatat_no_follow"));
  }, {}, true],
  ["publication file fence changes full identity", input => {
    const id = lifetime(input, "file-publication"); calls(input, value => value.resourceLifetimeId === id && value.syscall === "fstatat_no_follow", value => { value.identity.changedNs = "401"; });
  }, {}, true],
  ["publication directory name fence changes pinned mode", input => {
    const id = lifetime(input, "tree-publication");
    calls(input, value => value.resourceLifetimeId === id && value.syscall === "fstatat_no_follow", value => { value.identity.mode = 0o040750; });
  }, {}, true],
  ["publication observer close guard missing with refs adjusted", input => {
    const id = lifetime(input, "file-publication"), trace = result(input, "observe_publication").calls;
    removePublicationCall(input, trace.findLastIndex(value => value.syscall === "fstat" && value.resourceLifetimeId === id));
  }, {}, true],
  ["publication observer close missing despite closed snapshot", input => {
    removePublicationCall(input, result(input, "observe_publication").calls.findIndex(value => value.syscall === "close"));
  }],
  ["publication observer has wrong original inode", input => {
    const id = lifetime(input, "file-publication"); calls(input, value => value.resourceLifetimeId === id && !!value.identity, value => { value.identity.inode = "999"; });
  }],
  ["closed file reopened by changed snapshot lifetime", input => { result(input, "install_tree").snapshot.resources.at(-1).state = "retained"; }],
  ["terminal resource roster incomplete", input => { input.terminal.resources.pop(); }],
  ["terminal resource roster duplicate", input => { input.terminal.resources.push(clone(input.terminal.resources[0])); }],
  ["terminal claims not-acquired original resource", input => { input.terminal.resources[0] = { resourceSlotId: input.terminal.resources[0].resourceSlotId, state: "not_acquired" }; }],
  ["terminal claims unknown original lifetime", input => { input.terminal.resources[0].state = "unknown"; input.terminal.resources[0].unknownCause = "close_entered"; }],
  ["close_session has only closed phase with missing close", input => { result(input, "close_session").calls.pop(); }],
  ["close_session leaves one original retained", input => { result(input, "close_session").snapshot.resources[0].state = "retained"; }],
  ["close_session retries already closed file", input => {
    const trace = result(input, "close_session").calls, close = clone(result(input, "close_resource").calls[0]);
    const pivot = BigInt(trace[0].calledAtMonotonicNs); advanceClocks(input, pivot);
    close.calledAtMonotonicNs = String(pivot); close.returnedAtMonotonicNs = String(pivot + 1n); trace.unshift(close);
    const effectId = entry(input, "close_session").effect.effectId;
    walk(input, value => { if (value.closeCallRef?.effectId === effectId) value.closeCallRef.ordinal++; });
    input.terminal.resources.find(value => value.resourceSlotId === "file").closeCallRef = { effectId, ordinal: 0 };
  }, {}, true],
  ["close_session repeats one original close", input => {
    const trace = result(input, "close_session").calls, close = clone(trace.at(-1));
    close.calledAtMonotonicNs = String(BigInt(trace.at(-1).returnedAtMonotonicNs) + 1n);
    close.returnedAtMonotonicNs = String(BigInt(close.calledAtMonotonicNs) + 1n); trace.push(close);
  }],
  ["close_session unknown close return", input => { Object.assign(result(input, "close_session").calls[0], { returned: -1, success: false, errno: 4 }); }],
  ["terminal borrows another lifetime close ref", input => { input.terminal.resources[0].closeCallRef = clone(input.terminal.resources[1].closeCallRef); }],
  ["terminal omits original close ref", input => { delete input.terminal.resources[0].closeCallRef; }],
  ["history session nonce switches", input => { result(input, "close_session").snapshot.sessionNonce = "f".repeat(32); }],
  ["history loses a retained original snapshot resource", input => { result(input, "close_session").snapshot.resources.shift(); }],
  ["history silently reorders original resource roster", input => { result(input, "capture_parents").snapshot.resources.reverse(); }],
  ["bounded write uses a smaller syscall request than the native grammar", input => {
    const call = result(input, "write_file").calls[0]; call.requestedBytes = String(call.returned);
  }, { shortWrite: true }, true],
  ["bounded read uses a smaller syscall request than the native grammar", input => {
    const actual = result(input, "read_file").calls.find(value => value.syscall === "pread");
    calls(input, value => value.calledAtMonotonicNs === actual.calledAtMonotonicNs, value => { value.requestedBytes = String(value.returned); });
  }, { shortRead: true }, true],
  ["read inserts an extra successful fstat inside the contiguous I/O batch", input => {
    const trace = result(input, "read_file").calls, extra = clone(trace[0]), pivot = BigInt(trace[1].calledAtMonotonicNs);
    advanceClocks(input, pivot); extra.calledAtMonotonicNs = String(pivot); extra.returnedAtMonotonicNs = String(pivot + 1n);
    trace.splice(1, 0, extra); readbacks(input, "read_file", value => value.calls.splice(1, 0, clone(extra)));
  }, {}, true],
  ["publication inserts an extra destination guard before acquisition", input => { insertPublicationCall(input, 1, 0); }, {}, true],
  ["publication repeats one name fence", input => {
    const ordinal = result(input, "observe_publication").calls.findIndex(value => value.syscall === "fstatat_no_follow");
    insertPublicationCall(input, ordinal + 1, ordinal);
  }, {}, true],
  ["publication repeats an observer close guard", input => {
    const id = lifetime(input, "file-publication"), trace = result(input, "observe_publication").calls;
    const ordinal = trace.findLastIndex(value => value.syscall === "fstat" && value.resourceLifetimeId === id);
    insertPublicationCall(input, ordinal, ordinal);
  }, {}, true],
  ["directory durability effects are top-down despite individually valid packets", input => {
    const first = input.effects.indexOf(entry(input, "fsync_resource", "directory-2"));
    [input.effects[first], input.effects[first + 1]] = [input.effects[first + 1], input.effects[first]];
    restampReorderedHistory(input);
  }, {}, true],
  ["file is modified by another returned write after its durability boundary", input => {
    const extra = clone(entry(input, "write_file")); extra.effect.effectId = "write-after-sync";
    extra.effect.observationArtifactId = "write-after-sync-observation";
    extra.observation.effectId = extra.effect.effectId; extra.observation.native.result.operationId = extra.effect.effectId;
    extra.observation.native.result.calls.forEach((call, ordinal) => {
      call.calledAtMonotonicNs = String(2n ** 54n + BigInt(ordinal * 2));
      call.returnedAtMonotonicNs = String(2n ** 54n + BigInt(ordinal * 2 + 1));
    });
    input.effects.splice(input.effects.indexOf(entry(input, "fsync_resource", "file")) + 1, 0, extra);
    restampReorderedHistory(input);
  }, {}, true],
  ["original read returns a foreign node with stable full before/after identity", input => {
    const id = lifetime(input, "file"), observed = result(input, "read_file").calls[0].returnedAtMonotonicNs;
    calls(input, value => value.resourceLifetimeId === id && !!value.identity && BigInt(value.returnedAtMonotonicNs) >= BigInt(observed),
      value => { value.identity.inode = "999"; });
    resources(input, "file", value => {
      if (BigInt(value.observedAtMonotonicNs) >= BigInt(observed)) { value.identity.inode = "999"; value.inode = "999"; }
    });
    readbacks(input, "read_file", value => { value.identityBefore.inode = "999"; value.identityAfter.inode = "999"; });
  }, {}, true],
];
for (const [label, change, options, baseValid] of negatives) test(`directory v2 replay rejects resealed ${label}`, () => {
  const input = fixture(options); change(input); reseal(input);
  if (baseValid) assertBaseContracts(input);
  assert.throws(() => verifyOfficeLocalDirectoryReplayV2(input), invalid);
});

// Digests are deliberately corrupted AFTER reseal, so this tests the exact
// integrity gate instead of letting a test helper silently repair corruption.
for (const [label, change] of [
  ["prepared digest", input => { input.execution.preparedDigest = "a".repeat(64); }],
  ["execution identity digest", input => { input.execution.identityDigest = "a".repeat(64); }],
  ["effect domain digest", input => { input.effects[1].effect.effectDigest = "a".repeat(64); }],
  ["observation seal digest", input => { input.terminal.effects[0].observation.digest = "a".repeat(64); }],
  ["effect-set digest", input => { input.terminal.effectSetDigest = "a".repeat(64); }],
  ["terminal seal digest", input => { input.terminal.terminalDigest = "a".repeat(64); }],
  ["effect count", input => { input.terminal.effectCount++; }],
]) test(`directory v2 replay rejects corrupted ${label}`, () => {
  const input = reseal(fixture()); change(input);
  assert.throws(() => verifyOfficeLocalDirectoryReplayV2(input), invalid);
});
