import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, HOST_OFFICE_LOCAL_PROTOCOL, toRuntimeAttemptFence } from "../../dist/index.js";
import { createSqliteRunStoreFixture } from "./sqlite-run-store-fixture.mjs";

export const officeTerminalNow = () => new Date().toISOString();
export const officeTerminalHash = bytes => createHash("sha256").update(bytes).digest("hex");
export const officeTerminalIdentity = stats => ({ device: String(stats.dev), inode: String(stats.ino), sizeBytes: Number(stats.size),
  modifiedNs: String(stats.mtimeNs), changedNs: String(stats.ctimeNs) });
export const officeTerminalError = expected => error => error.code === expected;

/** Independent, isolated real SQLite/native-file fixture; importing this helper registers no tests. */
export async function officeTerminalFixture(t, runtime, { fixedWriter = false } = {}) {
  const cwd = runtime?.cwd ?? await mkdtemp(join(tmpdir(), "ling-office-local-terminal-"));
  const store = runtime?.store ?? createSqliteRunStoreFixture(cwd), other = createSqliteRunStore(cwd), opened = new Set();
  t.after(async () => {
    for (const fd of opened) { try { closeSync(fd); } catch {} }
    other.close();
    if (!runtime) { store.close(); await rm(cwd, { recursive: true, force: true }); }
  });
  const at = officeTerminalNow();
  const unit = runtime?.unit ?? store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run",
    idempotencyKey: "terminal-unit", status: "running", createdByActor: "system", request: {}, now: at });
  const attempt = runtime?.attempt ?? store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "terminal-original", runnerId: "pi", status: "started", now: at });
  const fence = toRuntimeAttemptFence(attempt), thread = store.createLingThread({ kind: "conversation", title: "Terminal", objective: "Facts" }, at);
  const turn = store.appendConversationUserTurn({ threadId: thread.id, title: "Create", userInstruction: "Create", idempotencyKey: "terminal-turn",
    payload: { body: "Create", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, at);
  const run = runtime?.run ?? store.createRun({ id: "run", cwd, workUnitId: unit.id, threadId: thread.id, turnId: turn.turnId, taskId: "task",
    providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: at });
  if (!runtime) { store.linkRunToWorkUnit(run.id, unit.id, at); store.markRunStarted(run.id, at); }
  const source = { runId: run.id, ...fence }, toolCallId = "terminal-office-call";
  const parent = store.admitHostOperation({ operationId: "terminal-parent", source, kind: "mcp", toolCallId });
  const producer = store.admitHostOperation({ operationId: "terminal-producer", source, kind: "file_mutation", toolCallId,
    parentOperationId: parent.operationId, producerId: "office-local-binary" });
  const temporaryMemberId = fixedWriter ? "temporary" : "temp";
  const bytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0xff, 0x80]), targetPath = join(cwd, "result.docx");
  const tempPath = join(cwd, fixedWriter ? ".ling-office-terminal-execution.tmp" : ".result.office.tmp");
  const prepared = { schemaVersion: 1, protocol: HOST_OFFICE_LOCAL_PROTOCOL, executionId: "terminal-execution", source,
    parentOperationId: parent.operationId, producerOperationId: producer.operationId, toolCallId, toolName: "office_create_document", format: "docx",
    workspacePath: cwd, workspaceIdentity: officeTerminalIdentity(lstatSync(cwd, { bigint: true })), targetPath, overwrite: false,
    requestDigest: "a".repeat(64), policyDigest: "b".repeat(64), input: { state: "absent" },
    output: { bytesSha256: officeTerminalHash(bytes), sizeBytes: bytes.length }, members: [
      { memberId: "target", role: "target", path: targetPath, initial: { state: "absent" } },
      { memberId: temporaryMemberId, role: "temporary", path: tempPath, initial: { state: "absent" } },
    ], preparedAt: officeTerminalNow() };
  const seal = payload => store.createArtifact({ runId: run.id, type: "json", path: "office/terminal-facts.json",
    sealedPayload: payload, createdAt: officeTerminalNow() });
  const preparation = seal(prepared), ticket = store.prepareHostOfficeLocalExecution(parent, producer, {
    executionId: prepared.executionId, preparedArtifactId: preparation.id, preparedDigest: preparation.contentSha256,
  });
  const execution = () => store.getHostOfficeLocalExecution(ticket.executionId);
  const f = { cwd, store, other, unit, fence, source, parent, producer, ticket, prepared, preparation, targetPath, tempPath, bytes, seal, execution, opened };
  f.prepareEffect = (change = {}) => store.prepareHostOfficeLocalEffect(ticket, { effectId: `effect-${store.listHostOfficeLocalEffects(ticket.executionId).length}`,
    ordinal: store.listHostOfficeLocalEffects(ticket.executionId).length, kind: "open", mode: "forward", memberId: temporaryMemberId,
    resourceLifetimeId: "effect-lifetime", preparedAt: officeTerminalNow(), ...change });
  f.observe = (effect, native, host = { state: "returned" }, openResource) => {
    const artifact = seal({ schemaVersion: 1, protocol: HOST_OFFICE_LOCAL_PROTOCOL, kind: "office_local_effect_v1", executionId: ticket.executionId,
      executionIdentityDigest: execution().identityDigest, source, effectId: effect.effectId, effectDigest: effect.effectDigest, native, host,
      ...(openResource ? { openResource } : {}), completedAt: officeTerminalNow() });
    store.recordHostOfficeLocalObservation(ticket, effect.effectId, artifact.id);
    return artifact;
  };
  f.effects = () => store.listHostOfficeLocalEffects(ticket.executionId).map(effect => ({ ordinal: effect.ordinal, effectId: effect.effectId,
    effectDigest: effect.effectDigest, enteredAt: effect.enteredAt ?? null, observation: effect.observationArtifactId ? {
      artifactId: effect.observationArtifactId,
      digest: String(store.database.prepare("SELECT content_sha256 FROM artifacts WHERE id=?").get(effect.observationArtifactId).content_sha256),
    } : null }));
  f.manifest = (change = {}) => ({ schemaVersion: 1, protocol: HOST_OFFICE_LOCAL_PROTOCOL, kind: "office_local_terminal_v1",
    executionId: ticket.executionId, executionIdentityDigest: execution().identityDigest, source,
    preparedArtifactId: preparation.id, preparedDigest: preparation.contentSha256, outcome: "failed", publicationEntered: false,
    effects: f.effects(), members: prepared.members.map(member => ({ memberId: member.memberId, role: member.role, path: member.path,
      final: { state: "absent" }, observedAt: officeTerminalNow() })), resources: [],
    workspace: { final: { state: "directory", identity: officeTerminalIdentity(lstatSync(cwd, { bigint: true })) }, observedAt: officeTerminalNow() },
    completedAt: officeTerminalNow(), ...change });
  f.claim = payload => { const artifact = seal(payload); return { terminalArtifactId: artifact.id, terminalDigest: artifact.contentSha256 }; };
  f.commit = payload => store.sealHostOfficeLocalTerminal(ticket, f.claim(payload));
  f.replace = () => store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 2,
    runtimeInstanceId: "terminal-successor", runnerId: "pi", status: "started", now: officeTerminalNow() });

  /** Valid published facts use native open/write/fsync/close/link/unlink and final read/close, not success-shaped stubs. */
  f.published = (options = {}) => {
    let fd, firstIdentity, identityObservedAt, openEffect, closeEffect;
    const resources = [];
    let readNumber = 0, effectResource;
    const readMember = (memberId, path, purpose) => {
      const readId = purpose === "final" ? "target-final-read" : `refresh-${readNumber++}`;
      const resourceLifetimeId = purpose === "final" ? "read-lifetime" : `${readId}-lifetime`;
      const openCalledAt = officeTerminalNow(), readFd = openSync(path, "r"), openReturnedAt = officeTerminalNow();
      opened.add(readFd);
      const identity = officeTerminalIdentity(fstatSync(readFd, { bigint: true })), identityObservedAt = officeTerminalNow();
      const readBytes = Buffer.alloc(identity.sizeBytes);
      let offset = 0;
      while (offset < readBytes.length) {
        const count = readSync(readFd, readBytes, offset, readBytes.length - offset, offset);
        assert.ok(count > 0, "the native member read must produce all observed bytes");
        offset += count;
      }
      const observedAt = officeTerminalNow(), closeEnteredAt = officeTerminalNow();
      closeSync(readFd); opened.delete(readFd);
      const closeReturnedAt = officeTerminalNow();
      resources.push({ origin: "member_read", memberId, resourceLifetimeId, readId, purpose, state: "closed",
        identity, identityObservedAt, openCalledAt, openReturnedAt, closeEnteredAt, closeReturnedAt });
      return { identity, readBytes, observedAt, readRef: { readId, resourceLifetimeId, completedAt: closeReturnedAt } };
    };
    const invoke = (change, nativeCall, afterNative) => {
      const effect = f.prepareEffect(change);
      let result, native;
      store.launchHostOfficeLocalEffect(ticket, effect.effectId, () => {
        const calledAt = officeTerminalNow(); result = nativeCall();
        native = { state: "returned", calledAt, returnedAt: officeTerminalNow(), result: { kind: effect.kind,
          ...(["open", "write", "fsync", "close"].includes(effect.kind) ? { resourceLifetimeId: effect.resourceLifetimeId } : {}),
          ...(effect.kind === "write" ? { bytesWritten: result } : {}) } };
        afterNative?.(effect);
      });
      f.observe(effect, native, effect.kind === "close" ? options.closeHost : undefined, effect.kind === "open" ? { resourceLifetimeId: effect.resourceLifetimeId,
        identity: firstIdentity, observedAt: identityObservedAt } : undefined);
      return effect;
    };
    openEffect = invoke({}, () => { fd = openSync(tempPath, "wx", 0o600); opened.add(fd); return fd; }, effect => {
      firstIdentity = officeTerminalIdentity(fstatSync(fd, { bigint: true })); identityObservedAt = officeTerminalNow();
      if (fixedWriter) {
        effectResource = { origin: "effect", memberId: temporaryMemberId, resourceLifetimeId: "effect-lifetime", state: "retained",
          openEffectId: effect.effectId, identity: firstIdentity, identityObservedAt };
        resources.push(effectResource);
        readMember(temporaryMemberId, tempPath, "refresh");
      }
    });
    invoke({ kind: "write", offset: 0, sizeBytes: bytes.length }, () => writeSync(fd, bytes, 0, bytes.length, 0), () => {
      if (fixedWriter) readMember(temporaryMemberId, tempPath, "refresh");
    });
    invoke({ kind: "fsync" }, () => fsyncSync(fd));
    closeEffect = invoke({ kind: "close" }, () => { closeSync(fd); opened.delete(fd); });
    if (fixedWriter) { effectResource.state = "closed"; effectResource.closeEffectId = closeEffect.effectId; }
    invoke({ kind: "link", memberId: "target", fromMemberId: temporaryMemberId, resourceLifetimeId: undefined }, () => linkSync(tempPath, targetPath), () => {
      if (fixedWriter) { readMember("target", targetPath, "refresh"); readMember(temporaryMemberId, tempPath, "refresh"); }
    });
    invoke({ kind: "unlink", resourceLifetimeId: undefined }, () => unlinkSync(tempPath));
    if (!fixedWriter) resources.push({ origin: "effect", memberId: temporaryMemberId, resourceLifetimeId: "effect-lifetime", state: "closed",
      openEffectId: openEffect.effectId, closeEffectId: closeEffect.effectId, identity: firstIdentity, identityObservedAt });
    const { identity, readBytes, observedAt, readRef } = readMember("target", targetPath, "final");
    return f.manifest({ outcome: "published", publicationEntered: true, resources,
      members: [{ memberId: "target", role: "target", path: targetPath,
        final: { state: "file", identity, bytesSha256: officeTerminalHash(readBytes), sizeBytes: readBytes.length }, observedAt,
        readRef },
      { memberId: temporaryMemberId, role: "temporary", path: tempPath, final: { state: "absent" }, observedAt: officeTerminalNow() }],
    });
  };
  return f;
}
