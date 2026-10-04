import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeSync, openSync } from "node:fs";
import { HOST_OFFICE_LOCAL_PROTOCOL, type HostOfficeFileIdentity, type PrepareHostOfficeLocalEffect } from "@ling-stack/core";
import { officeLocalWriteState, type OfficeLocalWritePlan, type OfficeLocalWriteState } from "./office-local-authority.js";
import { officeBytesDigest, officeErrorCode, officeFileIdentity, sameOfficeNode, type OfficeLocalMemberFinal } from "./office-local-members.js";

export interface OfficeLocalWriteObservation {
  readonly schemaVersion: 1;
  readonly protocol: typeof HOST_OFFICE_LOCAL_PROTOCOL;
  readonly kind: "office_local_writer_observation_v1";
  readonly executionId: string;
  readonly executionIdentityDigest: string;
  readonly source: OfficeLocalWriteState["execution"]["source"];
  readonly outcome: "published" | "failed";
  readonly publicationEntered: boolean;
  readonly members: readonly OfficeLocalMemberFinal[];
  readonly descriptors: readonly { readonly memberId: string; readonly identity?: HostOfficeFileIdentity;
    readonly state: "closed" | "retained"; readonly closeEntered: boolean }[];
  readonly effectIds: readonly string[];
  readonly completedAt: string;
}
interface Descriptor { readonly memberId: string; readonly fd: number; identity?: HostOfficeFileIdentity; closed: boolean; closeEntered: boolean }
export class OfficeLocalWriterError extends Error {
  constructor(readonly cause: unknown, readonly observationArtifactId: string | undefined,
    readonly observation: OfficeLocalWriteObservation) { super("office_local_write_failed"); this.name = "OfficeLocalWriterError"; }
}

/**
 * Fixed synchronous byte writer. Each syscall reenters the exact Core/tracker
 * gate. No SDK path writes, hidden copyFile, automatic retry or generic callback
 * executor. This produces observations, NOT independent Core safe receipts.
 */
export function executeOfficeLocalWrite(plan: OfficeLocalWritePlan): {
  readonly path: string; readonly recoveryPath?: string; readonly observationArtifactId: string; readonly observation: OfficeLocalWriteObservation;
} {
  const state = officeLocalWriteState(plan);
  if (state.used) throw new Error("office_local_write_already_entered");
  state.used = true; // Never reset after syscall or SQLite COMMIT failures.
  const descriptors: Descriptor[] = [], effects: string[] = [];
  let publicationEntered = false, published = false, failure: unknown;
  const runEffect = <T>(memberId: string, kind: PrepareHostOfficeLocalEffect["kind"], syscall: () => T,
    details: Partial<Pick<PrepareHostOfficeLocalEffect, "fromMemberId" | "offset" | "sizeBytes">> = {}, mode: "forward" | "cleanup" = "forward"): T => {
    const descriptor = state.tracker.prepareOfficeLocalEffect(state.ticket, { effectId: randomUUID(), ordinal: effects.length,
      memberId, kind, mode, preparedAt: new Date().toISOString(), ...details });
    effects.push(descriptor.effectId);
    let returned: T | undefined, actualError: unknown, entered = false;
    try {
      state.tracker.launchOfficeLocalEffect(state.ticket, descriptor.effectId, () => {
        entered = true;
        // Closing the exact still-owned descriptor does not traverse a path.
        // A displaced member must not prevent release of that original FD.
        if (kind !== "close") state.ledger.assertCurrent();
        returned = syscall();
        return returned;
      }, mode);
    } catch (error) { actualError = error; }
    try {
      // Durable entry can survive even if the local barrier refused the syscall.
      const row = state.store.listHostOfficeLocalEffects(plan.executionId).find(effect => effect.effectId === descriptor.effectId)!;
      const outcome = actualError ? entered || row.enteredAt ? "failed" : "not_entered" : "returned";
      const seal = state.store.createArtifact({ runId: state.execution.source.runId, type: "json",
        path: `office/${plan.executionId}/effect-${descriptor.ordinal}.json`, createdAt: new Date().toISOString(), sealedPayload: {
          schemaVersion: 1, protocol: HOST_OFFICE_LOCAL_PROTOCOL, kind: "office_local_effect_v1", executionId: plan.executionId,
          executionIdentityDigest: state.identityDigest, source: state.execution.source, effectId: descriptor.effectId,
          effectDigest: descriptor.effectDigest, outcome, ...(outcome === "failed" ? { errorCode: officeErrorCode(actualError) } : {}),
          completedAt: new Date().toISOString(),
        } });
      state.tracker.recordOfficeLocalObservation(state.ticket, descriptor.effectId, seal.id);
    } catch (error) {
      actualError = actualError ? new AggregateError([actualError, error], "office_local_observation_unconfirmed") : error;
    }
    if (actualError) throw actualError;
    return returned!;
  };
  const close = (descriptor: Descriptor, mode: "forward" | "cleanup"): void => {
    runEffect(descriptor.memberId, "close", () => {
      assertDescriptor(descriptor);
      // An EINTR/throw may have already released this number. Never replay it,
      // even if a new descriptor now points to the same inode.
      descriptor.closeEntered = true;
      closeSync(descriptor.fd);
      descriptor.closed = true;
    }, {}, mode);
  };
  const writeMember = (memberId: string, bytes: Buffer): void => {
    let owned: Descriptor | undefined;
    runEffect(memberId, "open", () => {
      const fd = openSync(state.ledger.member(memberId).path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      // Retain the actual fd before any following observation/COMMIT can throw.
      owned = { memberId, fd, closed: false, closeEntered: false };
      descriptors.push(owned);
      owned.identity = officeFileIdentity(fstatSync(fd, { bigint: true }));
      state.ledger.refresh(memberId, { state: "file", identity: owned.identity });
    });
    const descriptor = owned!;
    let offset = 0;
    while (offset < bytes.length) {
      const at = offset;
      const count = runEffect(memberId, "write", () => {
        assertDescriptor(descriptor);
        const written = writeSync(descriptor.fd, bytes, at, bytes.length - at, at);
        state.ledger.refresh(memberId);
        if (written === 0) throw new Error("office_local_write_no_progress");
        return written;
      }, { offset: at, sizeBytes: bytes.length - at });
      offset += count;
    }
    runEffect(memberId, "fsync", () => { assertDescriptor(descriptor); fsyncSync(descriptor.fd); });
    close(descriptor, "forward");
    const final = state.ledger.expected(memberId);
    if (final.state !== "file" || final.sizeBytes !== bytes.length || final.bytesSha256 !== officeBytesDigest(bytes)) {
      throw new Error("office_local_bytes_changed");
    }
  };
  try {
    const record = state.store.getHostOfficeLocalExecution(plan.executionId);
    if (!record || record.identityDigest !== state.identityDigest || officeBytesDigest(state.bytes) !== record.output.bytesSha256
      || state.bytes.length !== record.output.sizeBytes || (record.input.state === "file"
        && (!state.inputBytes || officeBytesDigest(state.inputBytes) !== record.input.bytesSha256))) throw new Error("office_local_bytes_changed");
    state.ledger.assertCurrent();
    for (const member of state.execution.members.filter(item => item.role === "directory" && item.initial.state === "absent")) {
      runEffect(member.memberId, "mkdir", () => {
        mkdirSync(member.path, { mode: 0o700 });
        state.ledger.refresh(member.memberId, { state: "directory", identity: officeFileIdentity(lstatSync(member.path, { bigint: true })) });
      });
    }
    if (state.inputBytes) writeMember("recovery", state.inputBytes);
    writeMember("temporary", state.bytes);
    const kind = state.execution.input.state === "absent" ? "link" : "rename";
    runEffect("target", kind, () => {
      publicationEntered = true;
      const temporary = state.ledger.member("temporary").path;
      const owned = state.ledger.expected("temporary");
      if (owned.state !== "file") throw new Error("office_local_snapshot_changed");
      if (kind === "link") linkSync(temporary, state.execution.targetPath);
      else renameSync(temporary, state.execution.targetPath);
      published = true;
      state.ledger.refresh("target", { state: "file", identity: owned.identity });
      state.ledger.refresh("temporary", kind === "rename" ? { state: "absent" } : undefined);
    }, { fromMemberId: "temporary" });
    if (kind === "link") runEffect("temporary", "unlink", () => { unlinkSync(state.ledger.member("temporary").path); state.ledger.refresh("temporary", { state: "absent" }); });
  } catch (error) { failure = error; }
  if (failure) {
    // Exact original descriptors only; no reopening, successor source, or retry
    // of failed close. Unknown close outcome stays retained, never FD-number replay.
    for (const descriptor of descriptors.filter(item => !item.closed && !item.closeEntered)) {
      try { close(descriptor, "cleanup"); } catch (error) { failure = new AggregateError([failure, error], "office_local_cleanup_unconfirmed"); }
    }
    if (state.ledger.expected("temporary").state === "file") {
      try { runEffect("temporary", "unlink", () => { unlinkSync(state.ledger.member("temporary").path); state.ledger.refresh("temporary", { state: "absent" }); }, {}, "cleanup"); }
      catch (error) { failure = new AggregateError([failure, error], "office_local_cleanup_unconfirmed"); }
    }
    // Recovery/target bytes are preserved. mkdirSync does not return the created
    // node's identity, so its subsequent path observation cannot authorize rmdir.
    // Preserve directory residue in the final manifest until a native creator
    // receipt can prove cleanup authority; this layer never grants safe settlement.
  }
  const observation: OfficeLocalWriteObservation = { schemaVersion: 1, protocol: HOST_OFFICE_LOCAL_PROTOCOL,
    kind: "office_local_writer_observation_v1", executionId: plan.executionId, executionIdentityDigest: state.identityDigest,
    source: state.execution.source, outcome: !failure && published ? "published" : "failed", publicationEntered,
    members: state.ledger.observeFinal(), descriptors: descriptors.map(item => ({ memberId: item.memberId,
      ...(item.identity ? { identity: item.identity } : {}), state: item.closed ? "closed" : "retained", closeEntered: item.closeEntered })),
    effectIds: effects, completedAt: new Date().toISOString() };
  let observationArtifactId: string | undefined;
  try {
    observationArtifactId = state.store.createArtifact({ runId: state.execution.source.runId, type: "json",
      path: `office/${plan.executionId}/writer.json`, createdAt: new Date().toISOString(), sealedPayload: observation }).id;
  } catch (error) { failure = failure ? new AggregateError([failure, error], "office_local_final_observation_unconfirmed") : error; }
  if (failure) throw new OfficeLocalWriterError(failure, observationArtifactId, observation);
  return { path: state.execution.targetPath, ...(state.inputBytes ? { recoveryPath: state.ledger.member("recovery").path } : {}),
    observationArtifactId: observationArtifactId!, observation };
}

function assertDescriptor(descriptor: Descriptor): void {
  if (descriptor.closed || descriptor.closeEntered) throw new Error("office_local_descriptor_changed");
  const current = officeFileIdentity(fstatSync(descriptor.fd, { bigint: true }));
  if (descriptor.identity && !sameOfficeNode(descriptor.identity, current)) {
    throw new Error("office_local_descriptor_changed");
  }
  // A first fstat failure did not close the FD returned by open. It remains in
  // this synchronous writer's owned set; its first successful observation can
  // identify it for the one permitted close, not reopen or borrow a path.
  descriptor.identity ??= current;
}
