import { randomUUID } from "node:crypto";
import { constants, closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeSync, openSync } from "node:fs";
import { HOST_OFFICE_LOCAL_PROTOCOL, type HostOfficeLocalEffectRecord, type HostOfficeLocalNativeObservation,
  type HostOfficeLocalNativeResult, type PrepareHostOfficeLocalEffect } from "@ling-stack/core";
import { officeLocalWriteState, type OfficeLocalWritePlan, type OfficeLocalWriteState } from "./office-local-authority.js";
import { officeBytesDigest, officeErrorCode, officeFileIdentity, type OfficeLocalMemberFinal } from "./office-local-members.js";
import { OfficeLocalResourceOwner, type OfficeLocalResource, type OfficeLocalResourceFinal } from "./office-local-resources.js";

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
  readonly resources: readonly OfficeLocalResourceFinal[];
  readonly effectIds: readonly string[];
  readonly completedAt: string;
}
interface EffectHooks<T> {
  readonly guard?: () => void;
  readonly beforeNative?: (effect: HostOfficeLocalEffectRecord) => void;
  readonly afterNative?: (value: T, effect: HostOfficeLocalEffectRecord) => void;
}
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
  const resources = new OfficeLocalResourceOwner(plan.executionId, state.execution.source), effects: string[] = [];
  let publicationEntered = false, published = false, failed = false, failure: unknown;
  const captureFailure = (error: unknown, message: string): void => {
    failure = failed ? new AggregateError([failure, error], message) : error;
    failed = true;
  };
  const runEffect = <T>(memberId: string, kind: PrepareHostOfficeLocalEffect["kind"], syscall: () => T,
    details: Partial<Pick<PrepareHostOfficeLocalEffect, "fromMemberId" | "resourceLifetimeId" | "offset" | "sizeBytes">> = {},
    mode: "forward" | "cleanup" = "forward", hooks: EffectHooks<T> = {}): T => {
    const descriptor = state.tracker.prepareOfficeLocalEffect(state.ticket, { effectId: randomUUID(), ordinal: effects.length,
      memberId, kind, mode, preparedAt: new Date().toISOString(), ...details });
    effects.push(descriptor.effectId);
    let returned: T | undefined, actualError: unknown, hostFailed = false;
    let native: HostOfficeLocalNativeObservation = { state: "not_entered" };
    try {
      state.tracker.launchOfficeLocalEffect(state.ticket, descriptor.effectId, () => {
        // Closing the exact still-owned descriptor does not traverse a path.
        // A displaced member must not prevent release of that original FD.
        if (kind !== "close") state.ledger.assertCurrent();
        hooks.guard?.();
        hooks.beforeNative?.(descriptor);
        const calledAt = new Date().toISOString();
        try { returned = syscall(); }
        catch (error) {
          native = { state: "threw", calledAt, completedAt: new Date().toISOString(), errorCode: officeErrorCode(error) };
          throw error;
        }
        // Latch the native API's actual return BEFORE fstat/readback/Host COMMIT.
        native = { state: "returned", calledAt, returnedAt: new Date().toISOString(),
          result: nativeResult(descriptor, returned) };
        hooks.afterNative?.(returned, descriptor);
        return returned;
      }, mode);
    } catch (error) { actualError = error; hostFailed = true; }
    try {
      // Core restores only this live ticket's callback-entry fact after rollback.
      // Native not_entered never rewrites the original operation as no-start.
      const seal = state.store.createArtifact({ runId: state.execution.source.runId, type: "json",
        path: `office/${plan.executionId}/effect-${descriptor.ordinal}.json`, createdAt: new Date().toISOString(), sealedPayload: {
          schemaVersion: 1, protocol: HOST_OFFICE_LOCAL_PROTOCOL, kind: "office_local_effect_v1", executionId: plan.executionId,
          executionIdentityDigest: state.identityDigest, source: state.execution.source, effectId: descriptor.effectId,
          effectDigest: descriptor.effectDigest, native,
          host: hostFailed ? { state: "unconfirmed", errorCode: officeErrorCode(actualError) } : { state: "returned" },
          completedAt: new Date().toISOString(),
        } });
      state.tracker.recordOfficeLocalObservation(state.ticket, descriptor.effectId, seal.id);
    } catch (error) {
      actualError = hostFailed ? new AggregateError([actualError, error], "office_local_observation_unconfirmed") : error;
      hostFailed = true;
    }
    if (hostFailed) throw actualError;
    return returned!;
  };
  const close = (resource: OfficeLocalResource, mode: "forward" | "cleanup"): void => {
    runEffect(resource.memberId, "close", () => closeSync(resource.fd), { resourceLifetimeId: resource.resourceLifetimeId }, mode, {
      guard: () => { resources.assertUsable(resource); },
      beforeNative: effect => resources.beginClose(resource, effect.effectId),
      afterNative: () => resources.markClosed(resource),
    });
  };
  const writeMember = (memberId: string, bytes: Buffer): void => {
    const resourceLifetimeId = randomUUID(), path = state.ledger.member(memberId).path;
    let resource: OfficeLocalResource | undefined;
    runEffect(memberId, "open", () => openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600),
      { resourceLifetimeId }, "forward", { afterNative: (fd, effect) => {
        resource = resources.retainOpened({ resourceLifetimeId, memberId, openEffectId: effect.effectId, fd });
        state.ledger.refresh(memberId, { state: "file", identity: resources.assertUsable(resource) });
      } });
    const owned = resource!;
    let offset = 0;
    while (offset < bytes.length) {
      const at = offset;
      const count = runEffect(memberId, "write", () => writeSync(owned.fd, bytes, at, bytes.length - at, at),
        { resourceLifetimeId, offset: at, sizeBytes: bytes.length - at }, "forward", {
          guard: () => { resources.assertUsable(owned); },
          afterNative: written => {
            if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - at) {
              throw Object.assign(new Error("office_local_write_no_progress"), { code: "office_local_write_no_progress" });
            }
            state.ledger.refresh(memberId);
          },
        });
      offset += count;
    }
    runEffect(memberId, "fsync", () => fsyncSync(owned.fd), { resourceLifetimeId }, "forward", {
      guard: () => { resources.assertUsable(owned); },
    });
    close(owned, "forward");
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
      runEffect(member.memberId, "mkdir", () => mkdirSync(member.path, { mode: 0o700 }), {}, "forward", { afterNative: () => {
        state.ledger.refresh(member.memberId, { state: "directory", identity: officeFileIdentity(lstatSync(member.path, { bigint: true })) });
      } });
    }
    if (state.inputBytes) writeMember("recovery", state.inputBytes);
    writeMember("temporary", state.bytes);
    const kind = state.execution.input.state === "absent" ? "link" : "rename";
    const temporary = state.ledger.member("temporary").path, owned = state.ledger.expected("temporary");
    if (owned.state !== "file") throw new Error("office_local_snapshot_changed");
    runEffect("target", kind, () => kind === "link" ? linkSync(temporary, state.execution.targetPath) : renameSync(temporary, state.execution.targetPath),
      { fromMemberId: "temporary" }, "forward", {
        beforeNative: () => { publicationEntered = true; },
        afterNative: () => {
          published = true;
          state.ledger.refresh("target", { state: "file", identity: owned.identity });
          state.ledger.refresh("temporary", kind === "rename" ? { state: "absent" } : undefined);
        },
      });
    if (kind === "link") runEffect("temporary", "unlink", () => unlinkSync(temporary), {}, "forward", {
      afterNative: () => { state.ledger.refresh("temporary", { state: "absent" }); },
    });
  } catch (error) { captureFailure(error, "office_local_write_unconfirmed"); }
  if (failed) {
    // Exact original descriptors only; no reopening, successor source, or retry
    // of failed close. Unknown close outcome stays retained, never FD-number replay.
    for (const resource of resources.cleanupCandidates()) {
      try { close(resource, "cleanup"); } catch (error) { captureFailure(error, "office_local_cleanup_unconfirmed"); }
    }
    if (state.ledger.expected("temporary").state === "file") {
      const temporary = state.ledger.member("temporary").path;
      try { runEffect("temporary", "unlink", () => unlinkSync(temporary), {}, "cleanup", {
        afterNative: () => { state.ledger.refresh("temporary", { state: "absent" }); },
      }); }
      catch (error) { captureFailure(error, "office_local_cleanup_unconfirmed"); }
    }
    // Recovery/target bytes are preserved. mkdirSync does not return the created
    // node's identity, so its subsequent path observation cannot authorize rmdir.
    // Preserve directory residue in the final manifest until a native creator
    // receipt can prove cleanup authority; this layer never grants safe settlement.
  }
  const observation: OfficeLocalWriteObservation = { schemaVersion: 1, protocol: HOST_OFFICE_LOCAL_PROTOCOL,
    kind: "office_local_writer_observation_v1", executionId: plan.executionId, executionIdentityDigest: state.identityDigest,
    source: state.execution.source, outcome: !failed && published ? "published" : "failed", publicationEntered,
    members: state.ledger.observeFinal(), resources: resources.snapshots(),
    effectIds: effects, completedAt: new Date().toISOString() };
  let observationArtifactId: string | undefined;
  try {
    observationArtifactId = state.store.createArtifact({ runId: state.execution.source.runId, type: "json",
      path: `office/${plan.executionId}/writer.json`, createdAt: new Date().toISOString(), sealedPayload: observation }).id;
  } catch (error) { captureFailure(error, "office_local_final_observation_unconfirmed"); }
  if (failed) throw new OfficeLocalWriterError(failure, observationArtifactId, observation);
  return { path: state.execution.targetPath, ...(state.inputBytes ? { recoveryPath: state.ledger.member("recovery").path } : {}),
    observationArtifactId: observationArtifactId!, observation };
}

function nativeResult(effect: HostOfficeLocalEffectRecord, value: unknown): HostOfficeLocalNativeResult {
  if (effect.kind === "write") return { kind: "write", resourceLifetimeId: effect.resourceLifetimeId!, bytesWritten: value as number };
  if (effect.kind === "open" || effect.kind === "fsync" || effect.kind === "close") {
    return { kind: effect.kind, resourceLifetimeId: effect.resourceLifetimeId! };
  }
  return { kind: effect.kind };
}
