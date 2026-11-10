import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { digestHarnessToolValue } from "../dist/harness/tool-executions.js";
import { verifyOfficeLocalReplay } from "../dist/storage/sqlite/host-office-local-replay.js";

const protocol = "ling-office-local-binary-v1";
const hash = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value), "utf8").digest("hex");
const identity = (inode, sizeBytes, version = 1) => ({ device: "1", inode: String(inode), sizeBytes,
  modifiedNs: String(version), changedNs: String(version) });
const clone = value => JSON.parse(JSON.stringify(value));
const rejected = error => typeof error.code === "string" && /^host_(office_local_(replay|evidence)_invalid|operation_invalid_timestamp)$/.test(error.code);

/**
 * Deterministic sealed historical facts for the pure Core contract. No SQLite,
 * filesystem, native calls or writer outcome can supply missing historical facts.
 * Native writer/Host transaction integration is verified by the Daemon tests.
 */
function fixture({ overwrite = false, shortWrite = false, nested = false } = {}) {
  let clock = 0;
  const tick = () => new Date(Date.UTC(2026, 9, 5) + clock++).toISOString();
  const source = { runId: "run", workUnitId: "unit", attemptId: "attempt", runtimeInstanceId: "original", fencingToken: "fence" };
  const workspacePath = "/historical/office", parent = nested ? `${workspacePath}/reports` : workspacePath;
  const prepared = { schemaVersion: 1, protocol, executionId: "exec", source, parentOperationId: "parent", producerOperationId: "producer",
    toolCallId: "call", toolName: overwrite ? "office_edit_document" : "office_create_document", format: "docx", workspacePath,
    workspaceIdentity: identity(100, 4096), targetPath: `${parent}/result.docx`, overwrite,
    requestDigest: "a".repeat(64), policyDigest: "b".repeat(64),
    input: overwrite ? { state: "file", identity: identity(101, 3), sizeBytes: 3, bytesSha256: hash("old") } : { state: "absent" },
    output: { sizeBytes: 8, bytesSha256: hash("new-data") }, members: [], preparedAt: tick() };
  prepared.members = [
    { memberId: "target", role: "target", path: prepared.targetPath, initial: clone(prepared.input) },
    { memberId: "temporary", role: "temporary", path: `${parent}/.ling-office-exec.tmp`, initial: { state: "absent" } },
    ...(overwrite ? [{ memberId: "recovery", role: "recovery", path: `${parent}/.ling-office-recovery-exec.docx`, initial: { state: "absent" } }] : []),
    ...(nested ? [{ memberId: "directory-0", role: "directory", path: parent, initial: { state: "directory", identity: identity(110, 4096) } }] : []),
  ];
  const preparedArtifactId = "prepared-artifact", preparedDigest = hash(prepared);
  const execution = { ...prepared, preparedArtifactId, preparedDigest,
    identityDigest: digestHarnessToolValue({ prepared, preparedArtifactId, preparedDigest }), revision: 0 };
  const effects = [], resources = [], current = new Map();
  let readNumber = 0;
  const read = (memberId, purpose, observedIdentity) => {
    const readId = `read-${readNumber++}`, resourceLifetimeId = `${readId}-lifetime`;
    const item = { origin: "member_read", memberId, resourceLifetimeId, readId, purpose,
      openCalledAt: tick(), openReturnedAt: tick(), identity: clone(observedIdentity), identityObservedAt: tick(), state: "closed" };
    const observedAt = tick();
    item.closeEnteredAt = tick(); item.closeReturnedAt = tick(); resources.push(item);
    return { observedAt, readRef: { readId, resourceLifetimeId, completedAt: item.closeReturnedAt } };
  };
  const append = (kind, memberId, details = {}, afterNative = () => {}) => {
    const { bytesWritten, ...descriptorDetails } = details;
    const descriptor = { effectId: `effect-${effects.length}`, ordinal: effects.length, kind, mode: "forward", memberId,
      preparedAt: tick(), ...descriptorDetails };
    const effect = { ...descriptor, executionId: execution.executionId,
      effectDigest: digestHarnessToolValue({ executionIdentityDigest: execution.identityDigest, effect: descriptor }),
      enteredAt: tick(), observationArtifactId: `observation-${effects.length}`, revision: 2 };
    const calledAt = tick(), returnedAt = tick();
    const result = { kind, ...(["open", "write", "fsync", "close"].includes(kind) ? { resourceLifetimeId: details.resourceLifetimeId } : {}),
      ...(kind === "write" ? { bytesWritten } : {}) };
    const openResource = afterNative(effect);
    const observation = { schemaVersion: 1, protocol, kind: "office_local_effect_v1", executionId: execution.executionId,
      executionIdentityDigest: execution.identityDigest, source: clone(source), effectId: effect.effectId, effectDigest: effect.effectDigest,
      native: { state: "returned", calledAt, returnedAt, result }, host: { state: "returned" },
      ...(openResource ? { openResource } : {}), completedAt: tick() };
    effects.push({ effect, observation });
    return effect;
  };
  const writeFile = (memberId, expected, inode) => {
    const resourceLifetimeId = `${memberId}-lifetime`;
    let retained;
    append("open", memberId, { resourceLifetimeId }, effect => {
      const original = identity(inode, 0), observedAt = tick();
      retained = { origin: "effect", memberId, resourceLifetimeId, openEffectId: effect.effectId,
        identity: original, identityObservedAt: observedAt, state: "retained" };
      resources.push(retained); current.set(memberId, original); read(memberId, "refresh", original);
      return { resourceLifetimeId, identity: clone(original), observedAt };
    });
    let offset = 0;
    while (offset < expected.sizeBytes) {
      const bytesWritten = shortWrite ? Math.min(2, expected.sizeBytes - offset) : expected.sizeBytes - offset;
      append("write", memberId, { resourceLifetimeId, offset, sizeBytes: expected.sizeBytes - offset, bytesWritten }, () => {
        current.set(memberId, identity(inode, offset + bytesWritten, offset + bytesWritten + 1));
        read(memberId, "refresh", current.get(memberId));
      });
      offset += bytesWritten;
    }
    append("fsync", memberId, { resourceLifetimeId });
    append("close", memberId, { resourceLifetimeId }, effect => { retained.state = "closed"; retained.closeEffectId = effect.effectId; });
  };
  if (overwrite) writeFile("recovery", prepared.input, 201);
  writeFile("temporary", prepared.output, 202);
  append(overwrite ? "rename" : "link", "target", { fromMemberId: "temporary" }, () => {
    current.set("target", { ...current.get("temporary"), changedNs: "99" });
    current.set("temporary", current.get("target"));
    read("target", "refresh", current.get("target"));
    if (!overwrite) read("temporary", "refresh", current.get("temporary"));
  });
  if (!overwrite) append("unlink", "temporary", {}, () => {
    current.set("target", { ...current.get("target"), changedNs: "100" });
  });
  const members = prepared.members.map(member => {
    let final, observation;
    if (member.memberId === "target" || member.memberId === "recovery") {
      const expected = member.memberId === "target" ? prepared.output : prepared.input;
      final = { state: "file", identity: clone(current.get(member.memberId)), sizeBytes: expected.sizeBytes, bytesSha256: expected.bytesSha256 };
      observation = read(member.memberId, "final", final.identity);
    } else {
      final = member.role === "directory" ? clone(member.initial) : { state: "absent" };
      observation = { observedAt: tick() };
    }
    return { memberId: member.memberId, role: member.role, path: member.path, final, ...observation };
  });
  const workspace = { final: { state: "directory", identity: identity(100, 4096, 200) }, observedAt: tick() };
  const terminal = { schemaVersion: 1, protocol, kind: "office_local_terminal_v1", executionId: execution.executionId,
    executionIdentityDigest: execution.identityDigest, source: clone(source), preparedArtifactId, preparedDigest,
    outcome: "published", publicationEntered: true, effects: [], members, resources, workspace, completedAt: tick() };
  const result = { execution, terminal, effects };
  bindEffects(result);
  return result;
}

/** Re-seal modified semantics to ensure negative cases exercise replay, not just stale hashes. */
function bindEffects(input, reindex = false) {
  for (const [index, item] of input.effects.entries()) {
    if (reindex) item.effect.ordinal = index;
    const { executionId, effectDigest, enteredAt, observationArtifactId, revision, ...descriptor } = item.effect;
    item.effect.effectDigest = digestHarnessToolValue({ executionIdentityDigest: input.execution.identityDigest, effect: descriptor });
    if (item.observation) item.observation.effectDigest = item.effect.effectDigest;
  }
  input.terminal.effects = input.effects.map(({ effect, observation }) => ({ ordinal: effect.ordinal, effectId: effect.effectId,
    effectDigest: effect.effectDigest, enteredAt: effect.enteredAt ?? null,
    observation: effect.observationArtifactId && observation ? { artifactId: effect.observationArtifactId, digest: hash(observation) } : null }));
}
function bindPrepared(input) {
  const { preparedArtifactId, preparedDigest, identityDigest, revision, ...prepared } = input.execution;
  input.execution.preparedDigest = hash(prepared);
  input.execution.identityDigest = digestHarnessToolValue({ prepared, preparedArtifactId, preparedDigest: input.execution.preparedDigest });
  input.terminal.preparedDigest = input.execution.preparedDigest;
  input.terminal.executionIdentityDigest = input.execution.identityDigest;
  for (const item of input.effects) if (item.observation) item.observation.executionIdentityDigest = input.execution.identityDigest;
  bindEffects(input);
}
/** Equal millisecond clocks are valid; isolate causal grammar from timestamp-order failures. */
function equalizeTimes(input) {
  const same = input.execution.preparedAt;
  const visit = value => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key.endsWith("At") && typeof child === "string") value[key] = same;
      else visit(child);
    }
  };
  visit(input); bindPrepared(input);
}
const find = (input, kind, memberId = "temporary") => input.effects.find(item => item.effect.kind === kind && item.effect.memberId === memberId);
const finalMember = (input, memberId = "target") => input.terminal.members.find(member => member.memberId === memberId);
const finalRead = (input, memberId = "target") => input.terminal.resources.find(resource => resource.origin === "member_read"
  && resource.purpose === "final" && resource.memberId === memberId);

for (const options of [{}, { overwrite: true }, { shortWrite: true }, { overwrite: true, shortWrite: true }, { nested: true }]) {
  test(`Office pure replay accepts complete historical fixed writer ${JSON.stringify(options)}`, () => {
    const input = fixture(options), original = clone(input), result = verifyOfficeLocalReplay(input);
    assert.deepEqual(result, { kind: "office_local_published_verified", executionId: "exec",
      executionIdentityDigest: input.execution.identityDigest, effectCount: input.effects.length, targetMemberId: "target",
      ...(options.overwrite ? { recoveryMemberId: "recovery" } : {}) });
    assert.deepEqual(input, original, "verification never mutates sealed history");
    assert.equal(finalMember(input).final.identity.changedNs, options.overwrite ? "99" : "100",
      "publication may legitimately change ctime since the original zero-byte FD fstat");
  });
}
test("Office pure replay accepts canonical equal-millisecond historical boundaries", () => {
  const input = fixture({ overwrite: true, shortWrite: true }); equalizeTimes(input);
  assert.equal(verifyOfficeLocalReplay(input).kind, "office_local_published_verified");
});
test("Office pure replay accepts a fully bound immutable terminal getter record", () => {
  const input = fixture(), manifest = clone(input.terminal);
  input.terminal = { ...manifest, terminalArtifactId: "terminal-artifact", terminalDigest: hash(manifest),
    effectSetDigest: digestHarnessToolValue(manifest.effects), effectCount: manifest.effects.length, sealedAt: manifest.completedAt };
  assert.equal(verifyOfficeLocalReplay(input).kind, "office_local_published_verified");
  input.terminal.effectSetDigest = "f".repeat(64);
  assert.throws(() => verifyOfficeLocalReplay(input), rejected);
});

const negatives = [
  ["execution ID binding", input => { input.terminal.executionId = "foreign"; }],
  ["execution identity digest binding", input => { input.terminal.executionIdentityDigest = "f".repeat(64); }],
  ["prepared artifact binding", input => { input.terminal.preparedArtifactId = "foreign"; }],
  ["prepared digest binding", input => { input.terminal.preparedDigest = "f".repeat(64); }],
  ["successor source", input => { input.terminal.source.runtimeInstanceId = "successor"; }],
  ["source extra authority", input => { input.terminal.source.safe = true; }],
  ["terminal extra authority", input => { input.terminal.safe = true; }],
  ["foreign original observation source", input => { input.effects[0].observation.source.fencingToken = "successor"; bindEffects(input); }],
  ["missing terminal effect", input => { input.terminal.effects.pop(); }],
  ["stale effect digest", input => { input.effects[0].effect.effectDigest = "f".repeat(64); }],
  ["stale observation digest", input => { input.terminal.effects[0].observation.digest = "f".repeat(64); }],
  ["foreign observation artifact", input => { input.terminal.effects[0].observation.artifactId = "foreign"; }],
  ["same immutable observation artifact claims two different effect facts", input => {
    input.effects[1].effect.observationArtifactId = input.effects[0].effect.observationArtifactId; bindEffects(input); }],
  ["missing observation", input => { input.effects[0].observation = null; bindEffects(input); }],
  ["missing entered fact", input => { delete input.effects[0].effect.enteredAt; bindEffects(input); }],
  ["ordinal hole", input => { input.effects[1].effect.ordinal = 2; bindEffects(input); }],
  ["duplicate effect", input => { input.effects.push(clone(input.effects.at(-1))); bindEffects(input, true); }],
  ["effect preparation before previous completion", input => { input.effects[1].effect.preparedAt = input.execution.preparedAt; bindEffects(input); }],
  ["native not entered", input => { input.effects[0].observation.native = { state: "not_entered" };
    delete input.effects[0].observation.openResource; input.effects[0].observation.host = { state: "unconfirmed", errorCode: "guard" }; bindEffects(input); }],
  ["native threw", input => { const item = find(input, "write"); item.observation.native = { state: "threw",
    calledAt: item.observation.native.calledAt, completedAt: item.observation.native.returnedAt, errorCode: "native" };
    item.observation.host = { state: "unconfirmed", errorCode: "native" }; bindEffects(input); }],
  ["Host COMMIT unconfirmed", input => { input.effects[0].observation.host = { state: "unconfirmed", errorCode: "commit" }; bindEffects(input); }],
  ["missing first original open fstat", input => { delete input.effects[0].observation.openResource; bindEffects(input); }],
  ["post-write fstat replacing first open identity", input => { const item = input.effects[0], resource = input.terminal.resources[0];
    item.observation.openResource.identity.sizeBytes = 8; resource.identity.sizeBytes = 8; bindEffects(input); }],
  ["original lifetime mismatch", input => { input.effects[0].observation.openResource.resourceLifetimeId = "foreign"; bindEffects(input); }],
  ["write zero progress", input => { find(input, "write").observation.native.result.bytesWritten = 0; bindEffects(input); }],
  ["write incomplete bytes", input => { find(input, "write").observation.native.result.bytesWritten = 7; bindEffects(input); }],
  ["write offset hole", input => { const item = find(input, "write"); item.effect.offset = 1; item.effect.sizeBytes = 7;
    item.observation.native.result.bytesWritten = 7; bindEffects(input); }],
  ["wrong write lifetime", input => { const item = find(input, "write"); item.effect.resourceLifetimeId = "foreign";
    item.observation.native.result.resourceLifetimeId = "foreign"; bindEffects(input); }],
  ["missing fsync", input => { input.effects.splice(input.effects.indexOf(find(input, "fsync")), 1); bindEffects(input, true); }],
  ["missing close", input => { input.effects.splice(input.effects.indexOf(find(input, "close")), 1); bindEffects(input, true); }],
  ["forged close ID", input => { input.terminal.resources[0].closeEffectId = "foreign"; }],
  ["retained effect FD", input => { input.terminal.resources[0].state = "retained"; delete input.terminal.resources[0].closeEffectId; }],
  ["unknown original close", input => { input.terminal.resources[0].state = "unknown"; }],
  ["missing effect FD resource", input => { input.terminal.resources.splice(0, 1); }],
  ["extra effect FD resource", input => { const item = clone(input.terminal.resources[0]); item.resourceLifetimeId = "orphan";
    item.identity.inode = "999"; input.terminal.resources.push(item); }],
  ["serialized numeric FD", input => { input.terminal.resources[0].fd = 42; }],
  ["create uses rename", input => { const item = find(input, "link", "target"); item.effect.kind = "rename";
    item.observation.native.result.kind = "rename"; bindEffects(input); }],
  ["foreign publication producer member", input => { find(input, "link", "target").effect.fromMemberId = "target"; bindEffects(input); }],
  ["missing create temporary unlink", input => { input.effects.pop(); bindEffects(input); }],
  ["cleanup cannot masquerade as forward completion", input => { find(input, "close").effect.mode = "cleanup"; bindEffects(input); }],
  ["publication flag without actual graph", input => { input.effects = []; bindEffects(input); }],
  ["failed label is not a safe receipt", input => { input.terminal.outcome = "failed"; }],
  ["publication not entered", input => { input.terminal.publicationEntered = false; }],
  ["missing final member", input => { input.terminal.members.pop(); }],
  ["extra final member", input => { input.terminal.members.push(clone(input.terminal.members[0])); }],
  ["unobserved final member", input => { finalMember(input).final = { state: "unobserved", errorCode: "read" }; }],
  ["wrong final path", input => { finalMember(input).path = "/historical/foreign.docx"; }],
  ["wrong final hash", input => { finalMember(input).final.bytesSha256 = "f".repeat(64); }],
  ["wrong final byte count", input => { finalMember(input).final.sizeBytes = 7; }],
  ["same hash on externally replaced final node", input => { finalMember(input).final.identity.inode = "999";
    finalRead(input).identity.inode = "999"; }],
  ["temporary residue", input => { const member = finalMember(input, "temporary"); member.final = clone(finalMember(input).final);
    member.readRef = clone(finalMember(input).readRef); }],
  ["missing final readRef", input => { delete finalMember(input).readRef; }],
  ["foreign readRef", input => { finalMember(input).readRef.resourceLifetimeId = "foreign"; }],
  ["read completion confused with earlier observedAt", input => { finalMember(input).readRef.completedAt = finalMember(input).observedAt; }],
  ["missing final read FD", input => { input.terminal.resources.splice(input.terminal.resources.indexOf(finalRead(input)), 1); }],
  ["missing refresh read FD", input => { input.terminal.resources.splice(1, 1); }],
  ["refresh roster swapped", input => { [input.terminal.resources[1], input.terminal.resources[2]]
    = [input.terminal.resources[2], input.terminal.resources[1]]; }],
  ["refresh read has wrong intermediate size", input => { input.terminal.resources[1].identity.sizeBytes = 1; }],
  ["refresh read belongs to foreign node", input => { input.terminal.resources[1].identity.inode = "999"; }],
  ["first refresh begins before original FD identity observation", input => {
    input.terminal.resources[1].openCalledAt = input.effects[0].observation.native.returnedAt; }],
  ["refresh used as final read", input => { finalRead(input).purpose = "refresh"; }],
  ["unknown read close", input => { const read = finalRead(input); read.state = "unknown"; delete read.closeReturnedAt; }],
  ["duplicate read lifetime", input => { finalRead(input).resourceLifetimeId = input.terminal.resources[0].resourceLifetimeId; }],
  ["read FD identity differs from final path", input => { finalRead(input).identity.changedNs = "999"; }],
  ["read close precedes identity", input => { finalRead(input).closeEnteredAt = finalRead(input).openCalledAt; }],
  ["final observed after native close", input => { finalMember(input).observedAt = finalRead(input).closeReturnedAt; }],
  ["final observation later than terminal", input => { finalMember(input).observedAt = "2027-01-01T00:00:00.000Z"; }],
  ["absent final member observed before the preceding final read returned close", input => {
    finalMember(input, "temporary").observedAt = finalMember(input).observedAt; }],
  ["workspace replaced after all members", input => { input.terminal.workspace.final.identity.inode = "999"; }],
  ["workspace unobserved", input => { input.terminal.workspace.final = { state: "unobserved", errorCode: "root" }; }],
  ["workspace observed before the last read close", input => { input.terminal.workspace.observedAt = finalRead(input).openCalledAt; }],
  ["terminal precedes complete resources", input => { input.terminal.completedAt = finalRead(input).openCalledAt; }],
  ["renamed fixed temporary member", input => { input.execution.members[1].memberId = "other"; bindPrepared(input); }],
  ["noncanonical fixed temporary path", input => { input.execution.members[1].path = "/historical/office/.foreign.tmp"; bindPrepared(input); }],
];
for (const [label, change] of negatives) {
  test(`Office pure replay rejects ${label}`, () => {
    const input = fixture(); change(input); assert.throws(() => verifyOfficeLocalReplay(input), rejected);
  });
}

test("Office pure replay rejects a short-write overlapping offset even with matching final bytes", () => {
  const input = fixture({ shortWrite: true }), writes = input.effects.filter(item => item.effect.kind === "write");
  writes[1].effect.offset = 1; writes[1].effect.sizeBytes = 7; bindEffects(input);
  assert.throws(() => verifyOfficeLocalReplay(input), rejected);
});
test("Office pure replay rejects publication before the original temporary close", () => {
  const input = fixture(), close = input.effects.indexOf(find(input, "close")), publish = input.effects.indexOf(find(input, "link", "target"));
  [input.effects[close], input.effects[publish]] = [input.effects[publish], input.effects[close]];
  bindEffects(input, true); equalizeTimes(input); assert.throws(() => verifyOfficeLocalReplay(input), rejected);
});
test("Office pure overwrite replay rejects recovery read beginning before the preceding absent observation", () => {
  const input = fixture({ overwrite: true });
  finalMember(input, "temporary").observedAt = finalMember(input, "recovery").observedAt;
  assert.throws(() => verifyOfficeLocalReplay(input), rejected);
});
for (const label of ["missing recovery", "recovery wrong hash", "recovery external node", "overwrite uses link", "aliased recovery lifetime"]) {
  test(`Office pure overwrite replay rejects ${label}`, () => {
    const input = fixture({ overwrite: true });
    if (label === "missing recovery") { input.effects = input.effects.filter(item => item.effect.memberId !== "recovery"); bindEffects(input, true); }
    if (label === "recovery wrong hash") finalMember(input, "recovery").final.bytesSha256 = input.execution.output.bytesSha256;
    if (label === "recovery external node") { finalMember(input, "recovery").final.identity.inode = "999"; finalRead(input, "recovery").identity.inode = "999"; }
    if (label === "overwrite uses link") { const item = find(input, "rename", "target"); item.effect.kind = "link"; item.observation.native.result.kind = "link"; bindEffects(input); }
    if (label === "aliased recovery lifetime") input.terminal.resources.find(resource => resource.origin === "effect" && resource.memberId === "temporary").resourceLifetimeId = "recovery-lifetime";
    assert.throws(() => verifyOfficeLocalReplay(input), rejected);
  });
}
test("Office pure replay rejects initial-absent directory despite mkdir-return and final lstat identity", () => {
  const input = fixture({ nested: true }), directory = input.execution.members.at(-1);
  directory.initial = { state: "absent" }; bindPrepared(input);
  const mkdir = clone(input.effects[0]); mkdir.effect.effectId = "mkdir-directory"; mkdir.effect.memberId = directory.memberId;
  mkdir.effect.kind = "mkdir"; delete mkdir.effect.resourceLifetimeId;
  mkdir.observation.effectId = mkdir.effect.effectId; mkdir.observation.native.result = { kind: "mkdir" }; delete mkdir.observation.openResource;
  input.effects.unshift(mkdir); bindEffects(input, true);
  assert.throws(() => verifyOfficeLocalReplay(input), rejected, "post-mkdir stat cannot mint native creator authority");
});
test("Office pure replay rejects missing ancestor roster and changed existing directory ownership", () => {
  const omitted = fixture({ nested: true }); omitted.execution.members.pop(); omitted.terminal.members.pop(); bindPrepared(omitted);
  assert.throws(() => verifyOfficeLocalReplay(omitted), rejected);
  const replaced = fixture({ nested: true }); replaced.terminal.members.at(-1).final.identity.inode = "999";
  assert.throws(() => verifyOfficeLocalReplay(replaced), rejected);
  const earlyDirectory = fixture({ nested: true }); earlyDirectory.terminal.members.at(-1).observedAt = finalMember(earlyDirectory).observedAt;
  assert.throws(() => verifyOfficeLocalReplay(earlyDirectory), rejected);
});
test("Office pure replay rejects an extra closed read, not just missing or leaked descriptors", () => {
  const input = fixture(), extra = clone(finalRead(input)); extra.readId = "orphan"; extra.resourceLifetimeId = "orphan-lifetime";
  extra.openCalledAt = extra.openReturnedAt = extra.identityObservedAt = extra.closeEnteredAt = extra.closeReturnedAt = input.terminal.workspace.observedAt;
  input.terminal.resources.push(extra); assert.throws(() => verifyOfficeLocalReplay(input), rejected);
});
test("Office pure replay rejects cleanup rmdir without native creator provenance", () => {
  const input = fixture({ nested: true }), directory = input.execution.members.at(-1);
  directory.initial = { state: "absent" }; bindPrepared(input);
  const item = clone(input.effects.at(-1)); item.effect.effectId = "cleanup-rmdir"; item.effect.kind = "rmdir";
  item.effect.mode = "cleanup"; item.effect.memberId = directory.memberId;
  item.observation.effectId = item.effect.effectId; item.observation.native.result = { kind: "rmdir" };
  input.effects.push(item); bindEffects(input, true); equalizeTimes(input);
  assert.throws(() => verifyOfficeLocalReplay(input), rejected);
});
test("Office pure overwrite replay rejects a new open pretending to own the original target inode", () => {
  const input = fixture({ overwrite: true }), open = find(input, "open"), original = input.execution.input.identity;
  open.observation.openResource.identity = { ...original, sizeBytes: 0 };
  const resource = input.terminal.resources.find(item => item.origin === "effect" && item.memberId === "temporary");
  resource.identity = clone(open.observation.openResource.identity); bindEffects(input);
  assert.throws(() => verifyOfficeLocalReplay(input), rejected);
});
