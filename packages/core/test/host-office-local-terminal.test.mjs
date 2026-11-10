import assert from "node:assert/strict";
import { closeSync, openSync } from "node:fs";
import test from "node:test";
import { digestHarnessToolValue } from "../dist/harness/tool-executions.js";
import { validateOfficeLocalTerminalPayload } from "../dist/storage/sqlite/host-office-local-terminal-payload.js";
import { officeTerminalFixture, officeTerminalNow, officeTerminalError as code } from "./support/host-office-local-terminal-fixture.mjs";

const copy = value => JSON.parse(JSON.stringify(value));
const evidenceInvalid = code("host_office_local_evidence_invalid");
const earlier = value => new Date(Date.parse(value) - 1).toISOString();
const later = value => new Date(Date.parse(value) + 1).toISOString();

test("Office terminal seals complete failed zero-effect facts without granting journal safety", async t => {
  const f = await officeTerminalFixture(t), manifest = f.manifest(), claim = f.claim(manifest);
  assert.equal(f.store.getHostOfficeLocalTerminal("missing"), undefined);
  assert.equal(f.store.getHostOfficeLocalTerminal(f.ticket.executionId), undefined);
  const terminal = f.store.sealHostOfficeLocalTerminal(f.ticket, claim);
  assert.equal(terminal.effectCount, 0); assert.equal(terminal.effectSetDigest, digestHarnessToolValue([]));
  assert.equal(terminal.terminalDigest, claim.terminalDigest); assert.equal(terminal.preparedDigest, f.preparation.contentSha256);
  assert.deepEqual(f.other.getHostOfficeLocalTerminal(f.ticket.executionId), terminal);
  assert.equal(terminal.sealedAt, f.store.database.prepare("SELECT created_at FROM artifacts WHERE id=?").get(claim.terminalArtifactId).created_at);
  assert.equal(f.other.listHostOperationBlockers(f.source).length, 2);
  assert.equal(f.other.getHostOperation(f.parent.operationId).phase, "admitted");
  assert.equal(f.other.getHostOperation(f.producer.operationId).phase, "admitted");
  assert.deepEqual(f.store.database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("Office terminal preserves real native binary effects, first open identity and final read-close lineage", async t => {
  const f = await officeTerminalFixture(t), manifest = f.published(), terminal = f.commit(manifest);
  assert.equal(terminal.outcome, "published"); assert.equal(terminal.effectCount, 6);
  assert.deepEqual(terminal.effects, f.effects()); assert.deepEqual(terminal.members, manifest.members);
  assert.deepEqual(terminal.resources, manifest.resources); assert.deepEqual(terminal.workspace, manifest.workspace);
  assert.equal(terminal.resources[0].identity.sizeBytes, 0); assert.equal(terminal.members[0].final.sizeBytes, f.bytes.length);
  assert.equal(terminal.members[0].readRef.completedAt, terminal.resources[1].closeReturnedAt);
  assert.equal(f.other.listHostOperationBlockers(f.source).length, 2);
});

for (const [label, mutate] of [
  ["missing effect", manifest => { manifest.effects.pop(); }],
  ["same-count foreign effect", manifest => { manifest.effects[0].effectId = "foreign"; manifest.resources[0].openEffectId = "foreign"; }],
  ["reordered effect set", manifest => { [manifest.effects[0], manifest.effects[1]] = [manifest.effects[1], manifest.effects[0]];
    manifest.effects.forEach((effect, index) => { effect.ordinal = index; }); }],
  ["descriptor digest substitution", manifest => { manifest.effects[0].effectDigest = "f".repeat(64); }],
  ["observation hash substitution", manifest => { manifest.effects[0].observation.digest = "f".repeat(64); }],
  ["observation artifact substitution", manifest => { manifest.effects[0].observation.artifactId = manifest.effects[1].observation.artifactId; }],
  ["null original observation", manifest => { manifest.effects[0].observation = null; }],
  ["null original entry", manifest => { manifest.effects[0].enteredAt = null; }],
  ["fabricated original entry", manifest => { manifest.effects[0].enteredAt = later(manifest.effects[0].enteredAt); }],
  ["duplicate ordinal", manifest => { manifest.effects[1].ordinal = 0; }],
  ["extra authority field", manifest => { manifest.safe = true; }],
  ["prepared digest substitution", manifest => { manifest.preparedDigest = "f".repeat(64); }],
  ["prepared artifact substitution", manifest => { manifest.preparedArtifactId = "foreign"; }],
  ["execution identity substitution", manifest => { manifest.executionIdentityDigest = "f".repeat(64); }],
  ["source extra authority", manifest => { manifest.source.safe = true; }],
  ["source substitution", manifest => { manifest.source.runtimeInstanceId = "successor"; }],
  ["array outcome enum", manifest => { manifest.outcome = ["published"]; }],
  ["array resource state enum", manifest => { manifest.resources[0].state = ["closed"]; }],
  ["array read purpose enum", manifest => { manifest.resources[1].purpose = ["final"]; }],
  ["workspace copied path", manifest => { manifest.workspace.path = "/today/root"; }],
  ["workspace extra safe field", manifest => { manifest.workspace.final.safe = true; }],
  ["missing original member", manifest => { manifest.members.pop(); }],
  ["member path substitution", manifest => { manifest.members[0].path = "/foreign/result.docx"; }],
  ["member role substitution", manifest => { manifest.members[0].role = "recovery"; }],
  ["missing file readRef", manifest => { delete manifest.members[0].readRef; }],
  ["raw descriptor authority", manifest => { manifest.resources[0].fd = 12; }],
  ["missing returned open resource", manifest => { manifest.resources.shift(); }],
  ["foreign open effect kind", manifest => { manifest.resources[0].openEffectId = manifest.effects[1].effectId; }],
  ["foreign close effect kind", manifest => { manifest.resources[0].closeEffectId = manifest.effects[2].effectId; }],
  ["cross-member effect lifetime", manifest => { manifest.resources[0].memberId = "target"; }],
  ["effect lifetime substitution", manifest => { manifest.resources[0].resourceLifetimeId = "foreign"; }],
  ["rewrite original open identity", manifest => { manifest.resources[0].identity.inode = "987654321"; }],
  ["rewrite original open time", manifest => { manifest.resources[0].identityObservedAt = later(manifest.resources[0].identityObservedAt); }],
  ["identity/time half pair", manifest => { delete manifest.resources[0].identityObservedAt; }],
  ["extra read identity authority", manifest => { manifest.resources[1].identity.safe = true; }],
  ["duplicate lifetime", manifest => { manifest.resources.push(copy(manifest.resources[0])); }],
  ["duplicate read ID", manifest => { manifest.resources.push({ ...copy(manifest.resources[1]), resourceLifetimeId: "another-read" }); }],
  ["refresh read final reference", manifest => { manifest.resources[1].purpose = "refresh"; }],
  ["readRef cross-member", manifest => { manifest.resources[1].memberId = "temp"; }],
  ["readRef lifetime substitution", manifest => { manifest.members[0].readRef.resourceLifetimeId = "foreign"; }],
  ["readRef read ID substitution", manifest => { manifest.members[0].readRef.readId = "foreign"; }],
  ["readRef not close-return time", manifest => { manifest.members[0].readRef.completedAt = earlier(manifest.resources[1].closeReturnedAt); }],
  ["read identity substitution", manifest => { manifest.resources[1].identity.inode = "987654321"; }],
  ["read close unknown with file final", manifest => { manifest.resources[1].state = "unknown"; delete manifest.resources[1].closeReturnedAt; }],
  ["read close retained with file final", manifest => { manifest.resources[1].state = "retained";
    delete manifest.resources[1].closeEnteredAt; delete manifest.resources[1].closeReturnedAt; }],
  ["file final without read identity", manifest => { delete manifest.resources[1].identity; delete manifest.resources[1].identityObservedAt; }],
  ["nonfile final with readRef", manifest => { manifest.members[0].final = { state: "absent" }; }],
  ["published without native publication latch", manifest => { manifest.publicationEntered = false; }],
  ["workspace observation after completion", manifest => { manifest.workspace.observedAt = later(manifest.completedAt); }],
  ["read opens backwards", manifest => { manifest.resources[1].openReturnedAt = earlier(manifest.resources[1].openCalledAt); }],
  ["read close backwards", manifest => { manifest.resources[1].closeReturnedAt = earlier(manifest.resources[1].closeEnteredAt); }],
  ["member observed after read close", manifest => { manifest.members[0].observedAt = later(manifest.resources[1].closeEnteredAt); }],
  ["noncanonical terminal time", manifest => { manifest.completedAt = manifest.completedAt.replace(".000Z", "Z");
    if (manifest.completedAt.endsWith("Z") && /\.\d{3}Z$/.test(manifest.completedAt)) manifest.completedAt = manifest.completedAt.slice(0, -1) + "+00:00"; }],
]) {
  test(`Office terminal rejects ${label} without persisting or freezing a bad claim`, async t => {
    const f = await officeTerminalFixture(t), original = f.published(), altered = copy(original);
    mutate(altered);
    assert.throws(() => f.commit(altered));
    assert.equal(f.other.getHostOfficeLocalTerminal(f.ticket.executionId), undefined);
    assert.equal(f.other.listHostOperationBlockers(f.source).length, 2);
    assert.equal(f.commit(original).terminalDigest.length, 64);
  });
}

test("Office terminal allows failed root unknown, retained effect and unknown read with missing first identity as facts only", async t => {
  const f = await officeTerminalFixture(t), effect = f.prepareEffect();
  let fd, native;
  f.store.launchHostOfficeLocalEffect(f.ticket, effect.effectId, () => {
    const calledAt = officeTerminalNow(); fd = openSync(f.tempPath, "wx"); f.opened.add(fd);
    native = { state: "returned", calledAt, returnedAt: officeTerminalNow(), result: { kind: "open", resourceLifetimeId: effect.resourceLifetimeId } };
  });
  f.observe(effect, native, { state: "unconfirmed", errorCode: "first-fstat.failed" });
  const at = officeTerminalNow(), manifest = f.manifest({
    members: f.prepared.members.map(member => ({ memberId: member.memberId, role: member.role, path: member.path,
      final: { state: "unobserved", errorCode: "read.failed" }, observedAt: at })),
    workspace: { final: { state: "unobserved", errorCode: "root.failed" }, observedAt: at },
    resources: [{ origin: "effect", memberId: "temp", resourceLifetimeId: effect.resourceLifetimeId, state: "retained", openEffectId: effect.effectId },
      { origin: "member_read", memberId: "temp", resourceLifetimeId: "failed-read", readId: "failed-read-id", purpose: "final", state: "unknown",
        openCalledAt: at, openReturnedAt: at, closeEnteredAt: at }],
  });
  const terminal = f.commit(manifest);
  assert.equal(terminal.outcome, "failed"); assert.equal(terminal.workspace.final.state, "unobserved");
  assert.equal(terminal.resources[0].state, "retained"); assert.equal(terminal.resources[1].state, "unknown");
  assert.equal(f.other.listHostOperationBlockers(f.source).length, 2);
  closeSync(fd); f.opened.delete(fd);
});

test("Office callback entry rejected by publication guard is not native publication entry", async t => {
  const f = await officeTerminalFixture(t), effect = f.prepareEffect({ kind: "link", memberId: "target", fromMemberId: "temp", resourceLifetimeId: undefined });
  assert.throws(() => f.store.launchHostOfficeLocalEffect(f.ticket, effect.effectId, () => { throw new Error("guard failed before native"); }), /guard failed/);
  f.observe(effect, { state: "not_entered" }, { state: "unconfirmed", errorCode: "guard.failed" });
  const terminal = f.commit(f.manifest());
  assert.ok(terminal.effects[0].enteredAt); assert.equal(terminal.publicationEntered, false);
  assert.equal(terminal.outcome, "failed"); assert.equal(f.other.listHostOperationBlockers(f.source).length, 2);
});

test("Office missing native observation remains null terminal fact rather than fabricated no-start", async t => {
  const f = await officeTerminalFixture(t), effect = f.prepareEffect();
  const terminal = f.commit(f.manifest());
  assert.equal(terminal.effects[0].effectId, effect.effectId); assert.equal(terminal.effects[0].enteredAt, null);
  assert.equal(terminal.effects[0].observation, null); assert.equal(f.other.listHostOperationBlockers(f.source).length, 2);
});

test("Office final member content observation precedes close; readRef completion need not equal member observation", async t => {
  const f = await officeTerminalFixture(t), manifest = f.published(), read = manifest.resources[1], member = manifest.members[0];
  const contentAt = member.observedAt, closeAt = later(manifest.completedAt);
  read.closeEnteredAt = closeAt; read.closeReturnedAt = closeAt; member.readRef.completedAt = closeAt;
  // Delaying the target's close also moves all later fixed-writer member observations.
  for (const subsequent of manifest.members.slice(1)) subsequent.observedAt = closeAt;
  manifest.workspace.observedAt = closeAt; manifest.completedAt = closeAt;
  // Pure validation proves the semantic timing boundary without pretending a future artifact already exists.
  assert.deepEqual(validateOfficeLocalTerminalPayload(f.execution(), manifest, closeAt), manifest);
  assert.notEqual(member.observedAt, member.readRef.completedAt);
});

test("Office closed read missing its first identity can be preserved only with unobserved final fact", async t => {
  const f = await officeTerminalFixture(t), manifest = f.published();
  manifest.outcome = "failed"; manifest.members[0].final = { state: "unobserved", errorCode: "first-fstat.failed" };
  delete manifest.members[0].readRef; delete manifest.resources[1].identity; delete manifest.resources[1].identityObservedAt;
  assert.equal(f.commit(manifest).resources[1].state, "closed");
  assert.equal(f.other.listHostOperationBlockers(f.source).length, 2);
});

test("Office native close returned with Host unconfirmed/owner unknown remains a failed fact, never safety", async t => {
  const f = await officeTerminalFixture(t), manifest = f.published({ closeHost: { state: "unconfirmed", errorCode: "host.return_lost" } });
  manifest.outcome = "failed"; manifest.resources[0].state = "unknown";
  assert.equal(f.commit(manifest).resources[0].state, "unknown");
  assert.equal(f.other.listHostOperationBlockers(f.source).length, 2);
});

test("Office failed outcome cannot hide a real native publication call behind a false latch", async t => {
  const f = await officeTerminalFixture(t), manifest = f.published();
  manifest.outcome = "failed"; manifest.publicationEntered = false;
  assert.throws(() => f.commit(manifest), evidenceInvalid);
  manifest.publicationEntered = true;
  assert.equal(f.commit(manifest).outcome, "failed");
  assert.equal(f.other.listHostOperationBlockers(f.source).length, 2);
});

for (const [label, mutate] of [
  ["effect count", row => { row.effectCount = 1; }],
  ["effect set digest", row => { row.effectSetDigest = "f".repeat(64); }],
  ["execution identity digest", row => { row.identityDigest = "f".repeat(64); }],
  ["terminal digest", row => { row.terminalDigest = "f".repeat(64); }],
  ["seal timestamp", row => { row.sealedAt = later(row.sealedAt); }],
]) {
  test(`Office historical read rejects a persisted row with wrong ${label}, not trusting row metadata as authority`, async t => {
    const f = await officeTerminalFixture(t), manifest = f.manifest(), claim = f.claim(manifest);
    const artifact = f.store.database.prepare("SELECT created_at FROM artifacts WHERE id=?").get(claim.terminalArtifactId);
    const row = { identityDigest: f.execution().identityDigest, terminalDigest: claim.terminalDigest,
      effectCount: 0, effectSetDigest: digestHarnessToolValue([]), sealedAt: artifact.created_at };
    mutate(row);
    // Deliberate isolated raw-row corruption: only the public reader is under test, not a restored capability.
    f.store.database.prepare(`INSERT INTO host_office_local_terminals(execution_id,schema_version,protocol,
      execution_identity_digest,terminal_artifact_id,terminal_digest,effect_set_digest,effect_count,sealed_at)
      VALUES(?,1,?,?,?,?,?,?,?)`).run(f.ticket.executionId, manifest.protocol, row.identityDigest,
        claim.terminalArtifactId, row.terminalDigest, row.effectSetDigest, row.effectCount, row.sealedAt);
    assert.throws(() => f.other.getHostOfficeLocalTerminal(f.ticket.executionId), evidenceInvalid);
    assert.equal(f.other.listHostOperationBlockers(f.source).length, 2);
  });
}

test("Office terminal rejects structural, foreign and reopened tickets even for an identical saved claim", async t => {
  const f = await officeTerminalFixture(t), claim = f.claim(f.manifest());
  f.store.sealHostOfficeLocalTerminal(f.ticket, claim);
  assert.throws(() => f.store.sealHostOfficeLocalTerminal({ ...f.ticket }, claim), code("host_office_local_invalid_ticket"));
  assert.throws(() => f.other.sealHostOfficeLocalTerminal(f.ticket, claim), code("host_office_local_invalid_ticket"));
  assert.throws(() => f.other.sealHostOfficeLocalTerminal({ executionId: f.ticket.executionId }, claim), code("host_office_local_invalid_ticket"));
  assert.deepEqual(f.store.sealHostOfficeLocalTerminal(f.ticket, claim), f.other.getHostOfficeLocalTerminal(f.ticket.executionId));
});

test("Office terminal same claim cannot bypass original owner replacement, though historical read remains available", async t => {
  const f = await officeTerminalFixture(t), claim = f.claim(f.manifest());
  const terminal = f.store.sealHostOfficeLocalTerminal(f.ticket, claim); f.replace();
  assert.throws(() => f.store.sealHostOfficeLocalTerminal(f.ticket, claim), code("host_operation_stale_owner"));
  assert.deepEqual(f.other.getHostOfficeLocalTerminal(f.ticket.executionId), terminal);
});

for (const afterCommit of [false, true]) {
  test(`Office terminal ${afterCommit ? "post-COMMIT return loss" : "COMMIT rollback"} irrevocably retains its original claim and blocks every mutable entrance`, async t => {
    const f = await officeTerminalFixture(t), effect = f.prepareEffect(), manifest = f.manifest(), claim = f.claim(manifest);
    const alternate = f.claim(manifest), exec = f.store.database.exec.bind(f.store.database); let inject = true, callbacks = 0;
    f.store.database.exec = sql => {
      if (sql === "COMMIT" && inject && f.store.database.prepare("SELECT count(*) AS n FROM host_office_local_terminals").get().n > 0) {
        inject = false; if (afterCommit) exec(sql); throw new Error("terminal commit fault");
      }
      return exec(sql);
    };
    try { assert.throws(() => f.store.sealHostOfficeLocalTerminal(f.ticket, claim), /terminal commit fault/); }
    finally { f.store.database.exec = exec; }
    assert.equal(!!f.other.getHostOfficeLocalTerminal(f.ticket.executionId), afterCommit);
    assert.throws(() => f.prepareEffect({ effectId: "after-seal" }), code("host_office_local_execution_sealed"));
    assert.throws(() => f.store.launchHostOfficeLocalEffect(f.ticket, effect.effectId, () => { callbacks++; }), code("host_office_local_execution_sealed"));
    assert.throws(() => f.store.recordHostOfficeLocalObservation(f.ticket, effect.effectId, "foreign"), code("host_office_local_execution_sealed"));
    assert.equal(callbacks, 0);
    assert.throws(() => f.store.sealHostOfficeLocalTerminal(f.ticket, alternate), code("host_office_local_terminal_claim_conflict"));
    const terminal = f.store.sealHostOfficeLocalTerminal(f.ticket, claim);
    assert.equal(terminal.terminalArtifactId, claim.terminalArtifactId);
    assert.deepEqual(f.store.sealHostOfficeLocalTerminal(f.ticket, claim), terminal);
    assert.equal(f.other.listHostOperationBlockers(f.source).length, 2);
  });
}

test("Office terminal INSERT failure also retains the irreversible claim, not only COMMIT faults", async t => {
  const f = await officeTerminalFixture(t), claim = f.claim(f.manifest()), alternate = f.claim(f.manifest());
  f.store.database.exec("CREATE TRIGGER test_terminal_abort BEFORE INSERT ON host_office_local_terminals BEGIN SELECT RAISE(ABORT,'terminal insert fault'); END");
  assert.throws(() => f.store.sealHostOfficeLocalTerminal(f.ticket, claim), /terminal insert fault/);
  assert.equal(f.other.getHostOfficeLocalTerminal(f.ticket.executionId), undefined);
  assert.throws(() => f.prepareEffect(), code("host_office_local_execution_sealed"));
  assert.throws(() => f.store.sealHostOfficeLocalTerminal(f.ticket, alternate), code("host_office_local_terminal_claim_conflict"));
  f.store.database.exec("DROP TRIGGER test_terminal_abort");
  assert.equal(f.store.sealHostOfficeLocalTerminal(f.ticket, claim).terminalArtifactId, claim.terminalArtifactId);
});

test("Office reentrant input getter cannot mutate after a rollback-retained terminal claim", async t => {
  const f = await officeTerminalFixture(t), claim = f.claim(f.manifest()), exec = f.store.database.exec.bind(f.store.database);
  const input = { get effectId() {
    f.store.database.exec = sql => { if (sql === "COMMIT") throw new Error("getter terminal commit fault"); return exec(sql); };
    try { assert.throws(() => f.store.sealHostOfficeLocalTerminal(f.ticket, claim), /getter terminal commit fault/); }
    finally { f.store.database.exec = exec; }
    return "reentrant-effect";
  }, ordinal: 0, kind: "open", mode: "forward", memberId: "temp", resourceLifetimeId: "effect-lifetime", preparedAt: officeTerminalNow() };
  assert.throws(() => f.store.prepareHostOfficeLocalEffect(f.ticket, input), code("host_office_local_execution_sealed"));
  assert.equal(f.other.listHostOfficeLocalEffects(f.ticket.executionId).length, 0);
  assert.equal(f.store.sealHostOfficeLocalTerminal(f.ticket, claim).effectCount, 0);
});

for (const [label, input] of [
  ["extra authority", { terminalArtifactId: "artifact", terminalDigest: "f".repeat(64), safe: true }],
  ["array claim", ["artifact", "f".repeat(64)]],
  ["missing digest", { terminalArtifactId: "artifact" }],
  ["non-digest", { terminalArtifactId: "artifact", terminalDigest: "wrong" }],
]) {
  test(`Office terminal rejects ${label} claim without freezing original ticket`, async t => {
    const f = await officeTerminalFixture(t);
    assert.throws(() => f.store.sealHostOfficeLocalTerminal(f.ticket, input), evidenceInvalid);
    assert.equal(f.commit(f.manifest()).effectCount, 0);
  });
}
