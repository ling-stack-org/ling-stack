import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { digestHarnessToolValue } from "../../dist/harness/tool-executions.js";
import { hostOperationDomainIdentity, readHostOperation, verifyHostOperationSafe } from "../../dist/storage/sqlite/host-operation-journal-evidence.js";
import { SqliteHostOperationJournalStore } from "../../dist/storage/sqlite/host-operation-journal-store.js";

export const officeJournalClone = value => JSON.parse(JSON.stringify(value));
export const officeJournalHash = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value), "utf8").digest("hex");
const identity = (inode, sizeBytes, version = 1) => ({ device: "1", inode: String(inode), sizeBytes,
  modifiedNs: String(version), changedNs: String(version) });

/**
 * Independent consumer-only SQLite history. Its workspace intentionally does
 * not exist; no writer/store mutation or present-day filesystem can fill gaps.
 * This narrow schema tests read consumers, not production migrations/triggers.
 */
export async function officeJournalFixture(t, { overwrite = false, shortWrite = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ling-office-journal-consumer-")), databasePath = join(directory, "history.sqlite");
  const database = new DatabaseSync(databasePath), readers = [];
  t.after(async () => { for (const reader of readers) reader.close(); database.close(); await rm(directory, { recursive: true, force: true }); });
  database.exec(`
    CREATE TABLE run_sessions(id TEXT PRIMARY KEY, work_unit_id TEXT, cwd TEXT);
    CREATE TABLE work_unit_attempts(id TEXT PRIMARY KEY, work_unit_id TEXT, runtime_instance_id TEXT, fencing_token TEXT);
    CREATE TABLE artifacts(id TEXT PRIMARY KEY, run_id TEXT, media_job_id TEXT, type TEXT,
      sealed_payload_json TEXT, content_sha256 TEXT, created_at TEXT);
    CREATE TABLE host_operations(operation_id TEXT PRIMARY KEY, schema_version INTEGER, run_id TEXT, work_unit_id TEXT,
      attempt_id TEXT, runtime_instance_id TEXT, fencing_token TEXT, kind TEXT, tool_call_id TEXT,
      parent_operation_id TEXT, producer_id TEXT, phase TEXT, admitted_at TEXT, launched_at TEXT,
      settled_at TEXT, settlement_kind TEXT, evidence_kind TEXT, evidence_id TEXT,
      domain_identity_digest TEXT, evidence_digest TEXT, settlement_signature TEXT, code TEXT, revision INTEGER DEFAULT 0);
    CREATE TABLE host_office_local_executions(execution_id TEXT PRIMARY KEY, schema_version INTEGER, protocol TEXT,
      run_id TEXT, work_unit_id TEXT, attempt_id TEXT, runtime_instance_id TEXT, fencing_token TEXT,
      parent_operation_id TEXT, producer_operation_id TEXT, tool_call_id TEXT, tool_name TEXT, prepared_at TEXT,
      prepared_artifact_id TEXT, prepared_digest TEXT, identity_digest TEXT, revision INTEGER);
    CREATE TABLE host_office_local_effects(execution_id TEXT, effect_id TEXT PRIMARY KEY, ordinal INTEGER,
      descriptor_json TEXT, effect_digest TEXT, entered_at TEXT, observation_artifact_id TEXT, revision INTEGER);
    CREATE TABLE host_office_local_terminals(execution_id TEXT PRIMARY KEY, schema_version INTEGER, protocol TEXT,
      execution_identity_digest TEXT, terminal_artifact_id TEXT, terminal_digest TEXT,
      effect_set_digest TEXT, effect_count INTEGER, sealed_at TEXT);
  `);
  let clock = 0;
  const tick = () => new Date(Date.UTC(2026, 8, 1) + clock++ * 10).toISOString();
  const source = { runId: "run", workUnitId: "unit", attemptId: "attempt", runtimeInstanceId: "original", fencingToken: "fence" };
  const workspacePath = "/historical/office-consumer-no-current-disk";
  const prepared = { schemaVersion: 1, protocol: "ling-office-local-binary-v1", executionId: "exec", source,
    parentOperationId: "parent", producerOperationId: "producer", toolCallId: "call",
    toolName: overwrite ? "office_edit_document" : "office_create_document", format: "docx", workspacePath,
    workspaceIdentity: identity(100, 4096), targetPath: `${workspacePath}/result.docx`, overwrite,
    requestDigest: "a".repeat(64), policyDigest: "b".repeat(64),
    input: overwrite ? { state: "file", identity: identity(101, 3), sizeBytes: 3, bytesSha256: officeJournalHash("old") } : { state: "absent" },
    output: { sizeBytes: 8, bytesSha256: officeJournalHash("new-data") }, members: [], preparedAt: tick() };
  prepared.members = [
    { memberId: "target", role: "target", path: prepared.targetPath, initial: officeJournalClone(prepared.input) },
    { memberId: "temporary", role: "temporary", path: `${workspacePath}/.ling-office-exec.tmp`, initial: { state: "absent" } },
    ...(overwrite ? [{ memberId: "recovery", role: "recovery", path: `${workspacePath}/.ling-office-recovery-exec.docx`, initial: { state: "absent" } }] : []),
  ];
  const preparedArtifactId = "prepared-artifact", preparedDigest = officeJournalHash(prepared);
  const execution = { ...prepared, preparedArtifactId, preparedDigest,
    identityDigest: digestHarnessToolValue({ prepared, preparedArtifactId, preparedDigest }), revision: 0 };
  const effects = [], resources = [], current = new Map();
  let readNumber = 0;
  const read = (memberId, purpose, observedIdentity) => {
    const readId = `read-${readNumber++}`, resourceLifetimeId = `${readId}-lifetime`;
    const resource = { origin: "member_read", memberId, resourceLifetimeId, readId, purpose,
      openCalledAt: tick(), openReturnedAt: tick(), identity: officeJournalClone(observedIdentity), identityObservedAt: tick(), state: "closed" };
    const observedAt = tick(); resource.closeEnteredAt = tick(); resource.closeReturnedAt = tick(); resources.push(resource);
    return { observedAt, readRef: { readId, resourceLifetimeId, completedAt: resource.closeReturnedAt } };
  };
  const append = (kind, memberId, details = {}, afterNative = () => {}) => {
    const { bytesWritten, ...descriptorDetails } = details;
    const descriptor = { effectId: `effect-${effects.length}`, ordinal: effects.length, kind, mode: "forward", memberId,
      preparedAt: tick(), ...descriptorDetails };
    const effect = { ...descriptor, executionId: execution.executionId,
      effectDigest: digestHarnessToolValue({ executionIdentityDigest: execution.identityDigest, effect: descriptor }),
      enteredAt: tick(), observationArtifactId: `observation-${effects.length}`, revision: 2 };
    const calledAt = tick(), returnedAt = tick(), openResource = afterNative(effect);
    const observation = { schemaVersion: 1, protocol: prepared.protocol, kind: "office_local_effect_v1",
      executionId: execution.executionId, executionIdentityDigest: execution.identityDigest, source: officeJournalClone(source),
      effectId: effect.effectId, effectDigest: effect.effectDigest,
      native: { state: "returned", calledAt, returnedAt, result: { kind,
        ...(["open", "write", "fsync", "close"].includes(kind) ? { resourceLifetimeId: details.resourceLifetimeId } : {}),
        ...(kind === "write" ? { bytesWritten } : {}) } }, host: { state: "returned" },
      ...(openResource ? { openResource } : {}), completedAt: tick() };
    effects.push({ effect, observation }); return effect;
  };
  const writeFile = (memberId, expected, inode) => {
    const resourceLifetimeId = `${memberId}-lifetime`; let retained;
    append("open", memberId, { resourceLifetimeId }, effect => {
      const original = identity(inode, 0), observedAt = tick();
      retained = { origin: "effect", memberId, resourceLifetimeId, openEffectId: effect.effectId,
        identity: original, identityObservedAt: observedAt, state: "retained" };
      resources.push(retained); current.set(memberId, original); read(memberId, "refresh", original);
      return { resourceLifetimeId, identity: officeJournalClone(original), observedAt };
    });
    let offset = 0;
    while (offset < expected.sizeBytes) {
      const bytesWritten = shortWrite ? Math.min(2, expected.sizeBytes - offset) : expected.sizeBytes - offset;
      append("write", memberId, { resourceLifetimeId, offset, sizeBytes: expected.sizeBytes - offset, bytesWritten }, () => {
        current.set(memberId, identity(inode, offset + bytesWritten, offset + bytesWritten + 1));
        read(memberId, "refresh", current.get(memberId));
      }); offset += bytesWritten;
    }
    append("fsync", memberId, { resourceLifetimeId });
    append("close", memberId, { resourceLifetimeId }, effect => { retained.state = "closed"; retained.closeEffectId = effect.effectId; });
  };
  if (overwrite) writeFile("recovery", prepared.input, 201);
  writeFile("temporary", prepared.output, 202);
  append(overwrite ? "rename" : "link", "target", { fromMemberId: "temporary" }, () => {
    current.set("target", { ...current.get("temporary"), changedNs: "99" }); current.set("temporary", current.get("target"));
    read("target", "refresh", current.get("target")); if (!overwrite) read("temporary", "refresh", current.get("temporary"));
  });
  if (!overwrite) append("unlink", "temporary", {}, () => current.set("target", { ...current.get("target"), changedNs: "100" }));
  const members = prepared.members.map(member => {
    const expected = member.memberId === "target" ? prepared.output : prepared.input;
    const final = member.memberId === "target" || member.memberId === "recovery"
      ? { state: "file", identity: officeJournalClone(current.get(member.memberId)), sizeBytes: expected.sizeBytes, bytesSha256: expected.bytesSha256 }
      : { state: "absent" };
    return { memberId: member.memberId, role: member.role, path: member.path, final,
      ...(final.state === "file" ? read(member.memberId, "final", final.identity) : { observedAt: tick() }) };
  });
  const terminal = { schemaVersion: 1, protocol: prepared.protocol, kind: "office_local_terminal_v1", executionId: execution.executionId,
    executionIdentityDigest: execution.identityDigest, source: officeJournalClone(source), preparedArtifactId, preparedDigest,
    outcome: "published", publicationEntered: true, effects: [], members, resources,
    workspace: { final: { state: "directory", identity: identity(100, 4096, 200) }, observedAt: tick() }, completedAt: tick() };
  const admittedAt = new Date(Date.parse(prepared.preparedAt) - 10).toISOString();
  const launchedAt = new Date(Date.parse(effects[0].effect.enteredAt) + 1).toISOString(), settledAt = tick();
  database.prepare("INSERT INTO run_sessions VALUES(?,?,?)").run(source.runId, source.workUnitId, workspacePath);
  database.prepare("INSERT INTO work_unit_attempts VALUES(?,?,?,?)").run(source.attemptId, source.workUnitId, source.runtimeInstanceId, source.fencingToken);
  const insertOperation = (id, kind, parentId = null, producerId = null) => database.prepare(`INSERT INTO host_operations
    (operation_id,schema_version,run_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token,kind,tool_call_id,
    parent_operation_id,producer_id,phase,admitted_at) VALUES(?,1,?,?,?,?,?,?,?,?,?,'admitted',?)`)
    .run(id, source.runId, source.workUnitId, source.attemptId, source.runtimeInstanceId, source.fencingToken,
      kind, prepared.toolCallId, parentId, producerId, admittedAt);
  insertOperation("parent", "mcp"); insertOperation("producer", "file_mutation", "parent", "office-local-binary");
  const seal = (id, payload, createdAt) => database.prepare("INSERT OR REPLACE INTO artifacts VALUES(?,?,NULL,'json',?,?,?)")
    .run(id, source.runId, JSON.stringify(payload), officeJournalHash(payload), createdAt);
  const writeHistory = () => {
    const { preparedArtifactId: artifactId, preparedDigest: _digest, identityDigest: _identity, revision: _revision, ...currentPrepared } = execution;
    execution.preparedDigest = officeJournalHash(currentPrepared);
    execution.identityDigest = digestHarnessToolValue({ prepared: currentPrepared, preparedArtifactId: artifactId, preparedDigest: execution.preparedDigest });
    seal(artifactId, currentPrepared, currentPrepared.preparedAt);
    database.prepare("INSERT OR REPLACE INTO host_office_local_executions VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(execution.executionId, execution.protocol, source.runId, source.workUnitId, source.attemptId, source.runtimeInstanceId, source.fencingToken,
        execution.parentOperationId, execution.producerOperationId, execution.toolCallId, execution.toolName, execution.preparedAt,
        artifactId, execution.preparedDigest, execution.identityDigest, execution.revision);
    database.prepare("DELETE FROM host_office_local_effects WHERE execution_id=?").run(execution.executionId);
    for (const item of effects) {
      const { executionId, effectDigest: _effectDigest, enteredAt, observationArtifactId, revision, ...descriptor } = item.effect;
      item.effect.effectDigest = digestHarnessToolValue({ executionIdentityDigest: execution.identityDigest, effect: descriptor });
      if (item.observation) {
        item.observation.executionIdentityDigest = execution.identityDigest; item.observation.effectDigest = item.effect.effectDigest;
        seal(observationArtifactId, item.observation, item.observation.completedAt);
      }
      database.prepare("INSERT INTO host_office_local_effects VALUES(?,?,?,?,?,?,?,?)").run(executionId, descriptor.effectId, descriptor.ordinal,
        JSON.stringify(descriptor), item.effect.effectDigest, enteredAt ?? null, observationArtifactId ?? null, revision);
    }
    terminal.preparedDigest = execution.preparedDigest; terminal.executionIdentityDigest = execution.identityDigest;
    terminal.effects = effects.map(({ effect, observation }) => ({ ordinal: effect.ordinal, effectId: effect.effectId,
      effectDigest: effect.effectDigest, enteredAt: effect.enteredAt ?? null,
      observation: effect.observationArtifactId && observation ? { artifactId: effect.observationArtifactId, digest: officeJournalHash(observation) } : null }));
    seal("terminal-artifact", terminal, terminal.completedAt);
    database.prepare("INSERT OR REPLACE INTO host_office_local_terminals VALUES(?,1,?,?,?,?,?,?,?)").run(execution.executionId, execution.protocol,
      execution.identityDigest, "terminal-artifact", officeJournalHash(terminal), digestHarnessToolValue(terminal.effects), terminal.effects.length, terminal.completedAt);
  };
  // Bind before writing the effect/terminal roster, exactly as the live pair gate does.
  seal(preparedArtifactId, prepared, prepared.preparedAt);
  database.prepare("INSERT INTO host_office_local_executions VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(execution.executionId, execution.protocol, source.runId, source.workUnitId, source.attemptId, source.runtimeInstanceId, source.fencingToken,
      execution.parentOperationId, execution.producerOperationId, execution.toolCallId, execution.toolName, execution.preparedAt,
      preparedArtifactId, preparedDigest, execution.identityDigest, execution.revision);
  for (const [id, kind] of [["parent", "office_local_chain_execution"], ["producer", "office_local_binary_execution"]]) {
    const operation = readHostOperation(database, id), evidence = { kind, id: execution.executionId };
    const digest = hostOperationDomainIdentity(database, operation, evidence, true);
    database.prepare("UPDATE host_operations SET evidence_kind=?,evidence_id=?,domain_identity_digest=? WHERE operation_id=?")
      .run(kind, execution.executionId, digest, id);
  }
  writeHistory();
  database.prepare("UPDATE host_operations SET phase='launched',launched_at=?").run(launchedAt);
  const store = new SqliteHostOperationJournalStore({ database });
  const settleRecord = (id, kind = id === "parent" ? "office_local_chain_completed" : "office_local_binary_completed") => {
    const candidate = { ...readHostOperation(database, id), phase: "safe", settlementKind: kind, settledAt,
      settlementSignature: JSON.stringify({ kind, settledAt }) };
    const digest = verifyHostOperationSafe(database, candidate);
    database.prepare("UPDATE host_operations SET phase='safe',settled_at=?,settlement_kind=?,evidence_digest=?,settlement_signature=? WHERE operation_id=?")
      .run(settledAt, kind, digest, candidate.settlementSignature, id);
    return readHostOperation(database, id);
  };
  const reopen = () => { const reader = new DatabaseSync(databasePath); readers.push(reader); return new SqliteHostOperationJournalStore({ database: reader }); };
  return { database, store, execution, terminal, effects, source, launchedAt, settledAt, admittedAt,
    read: id => readHostOperation(database, id), writeHistory, seal, settleRecord, insertOperation, reopen };
}
