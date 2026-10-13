import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { RunEvaluationHumanConfirmationV1 } from "@ling-stack/contracts";
import type { DesktopHumanEvaluationRequest, DesktopHumanEvaluationResult,
  DesktopHumanEvaluationInspectRequest, DesktopHumanEvaluationSnapshot, DesktopHumanEvaluationListRequest,
  DesktopHumanEvaluationListResult, DesktopHumanEvaluationReportRef, DesktopHumanEvaluationReportResult } from "../../shared/human-evaluation-capabilities.js";
import { signHumanEvaluationConfirmation, type HumanEvaluationConnection,
  type HumanEvaluationDaemonClient } from "./daemon-client.js";
import { sameHumanSession, type HumanEvaluationNativeBridge } from "./native-bridge.js";
import { readWithHumanEvaluationAuthority } from "./read-operation.js";

export class HumanEvaluationCoordinator {
  private desktopEpoch = randomUUID();
  private lockEpoch = randomUUID();
  private generation = 0;
  private disposed = false;
  private readonly unknownIntents = new Map<string, string>();
  private active: { readonly requestId: string; readonly controller: AbortController; readonly drained: Promise<void> } | undefined;

  constructor(private readonly options: {
    readonly desktopInstanceId: string;
    readonly workspaceCwd: string;
    readonly displayWorkspaceCwd?: string;
    readonly scopeCurrent?: () => boolean;
    readonly native: HumanEvaluationNativeBridge;
    readonly daemon: HumanEvaluationDaemonClient;
    readonly now?: () => number;
  }) {}

  /** Lock, suspend, owner navigation/destruction and shutdown synchronously fence all in-flight work. */
  invalidate(): void {
    this.generation++;
    this.lockEpoch = randomUUID();
    this.desktopEpoch = randomUUID();
    this.active?.controller.abort();
  }

  cancel(requestId: string): { readonly accepted: boolean } {
    if (!this.active || this.active.requestId !== requestId) return { accepted: false };
    this.active.controller.abort();
    return { accepted: true };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.invalidate();
    await this.active?.drained;
  }

  async submit(request: DesktopHumanEvaluationRequest, isOwnerCurrent: () => boolean): Promise<DesktopHumanEvaluationResult> {
    if (this.disposed || !isOwnerCurrent()) return failure("unauthorized_sender");
    if (this.active) return failure("busy");
    let release!: () => void;
    const drained = new Promise<void>((resolve) => { release = resolve; });
    const controller = new AbortController();
    this.active = { requestId: request.requestId, controller, drained };
    const generation = this.generation, desktopEpoch = this.desktopEpoch, lockEpoch = this.lockEpoch;
    const signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), 120_000);
    let connection: HumanEvaluationConnection | undefined;
    let commitStarted = false;
    let intentId: string | undefined;
    const current = (): boolean => !this.disposed && !signal.aborted && this.generation === generation && isOwnerCurrent();
    const retireConnection = async (): Promise<void> => {
      const retiring = connection;
      connection = undefined;
      if (retiring) { try { await this.options.daemon.revoke(retiring.authority); } catch { /* Retiring is not a rollback. */ } }
    };
    try {
      const before = await this.options.native.readSession(signal);
      if (!current() || !before.active || before.locked) return failure("authority_changed");
      connection = await this.options.daemon.handshake({ desktopInstanceId: this.options.desktopInstanceId,
        desktopEpoch, workspaceCwd: this.options.workspaceCwd, platform: "darwin",
        session: { osSessionId: before.osSessionId, osUserId: before.osUserId, lockEpoch, locked: false } }, signal);
      const authority = connection.authority;
      if (!current() || authority.desktopInstanceId !== this.options.desktopInstanceId
        || authority.desktopEpoch !== desktopEpoch || authority.lockEpoch !== lockEpoch
        || authority.osSessionId !== before.osSessionId || authority.osUserId !== before.osUserId
        || connection.workspaceCwd !== this.options.workspaceCwd) return failure("authority_changed");
      const intent = await this.options.daemon.intent({ authority, taskId: request.taskId,
        requestId: request.requestId, submission: request.submission }, signal);
      intentId = intent.id;
      const payload = intent.payload;
      const payloadJson = JSON.stringify(payload);
      const now = this.options.now ?? Date.now;
      const expiry = Date.parse(payload.expiresAt), created = Date.parse(intent.createdAt);
      if (!current() || payload.intentId !== intent.id || payload.requestId !== request.requestId
        || payload.taskId !== request.taskId || payload.canonicalWorkspaceCwd !== this.options.workspaceCwd
        || !isDeepStrictEqual(payload.binding, authority)
        || !isDeepStrictEqual(payload.submission, request.submission)
        || createHash("sha256").update(payloadJson, "utf8").digest("hex") !== intent.payloadDigest
        || !Number.isFinite(expiry) || !Number.isFinite(created) || created > now()
        || expiry <= now() || expiry - created > 120_000) return failure("authority_changed");
      const beforePrompt = await this.options.native.readSession(signal);
      if (!current() || !sameHumanSession(before, beforePrompt)) return failure("authority_changed");
      const result = await this.options.native.confirm({ intentId: intent.id, requestId: request.requestId,
        payloadDigest: intent.payloadDigest, payloadJson, signal });
      if (!current()) return failure("cancelled");
      if (result.status !== "confirmed") return failure(result.status === "cancelled" ? "cancelled"
        : result.status === "unavailable" ? "native_unavailable" : "confirmation_failed");
      const after = await this.options.native.readSession(signal);
      if (!current() || expiry <= now() || !sameHumanSession(before, result.sessionBefore)
        || !sameHumanSession(before, result.sessionAfter) || !sameHumanSession(before, after)
        || result.intentId !== intent.id || result.requestId !== request.requestId
        || result.payloadDigest !== intent.payloadDigest) return failure("authority_changed");
      const confirmation: RunEvaluationHumanConfirmationV1 = { kind: "macos_device_owner_authentication",
        requestId: request.requestId, payloadDigest: intent.payloadDigest, confirmedAt: new Date(now()).toISOString() };
      const signature = signHumanEvaluationConfirmation(connection, intent.id, confirmation);
      if (!current()) return failure("authority_changed");
      commitStarted = true;
      // Daemon re-reads frozen pins/head and atomically consumes intent + CAS + event + audit.
      const committed = await this.options.daemon.commit({ authority, intentId: intent.id, confirmation, signature }, signal);
      await retireConnection();
      // Revocation can yield while the owner/session changes. An already committed
      // fact survives, but no success is delivered under that stale authority.
      if (!current()) {
        this.rememberUnknownIntent(request.taskId, intent.id);
        return failure("submission_unknown");
      }
      this.unknownIntents.delete(request.taskId);
      return { accepted: true, eventId: committed.event.id, revision: committed.head.revision, state: committed.head.state };
    } catch {
      if (commitStarted && intentId) {
        this.rememberUnknownIntent(request.taskId, intentId);
      }
      // A lost commit response is unknown, never an automatic resend or a false rollback promise.
      return failure(commitStarted ? "submission_unknown" : signal.aborted ? "cancelled" : "host_rejected");
    } finally {
      clearTimeout(timer);
      if (connection) await retireConnection();
      this.active = undefined;
      release();
    }
  }

  /** Reconcile a lost receipt through read-only Host facts; never resend the submission. */
  async inspect(request: DesktopHumanEvaluationInspectRequest, isOwnerCurrent: () => boolean): Promise<DesktopHumanEvaluationSnapshot> {
    if (this.disposed || !isOwnerCurrent()) return failure("unauthorized_sender") as DesktopHumanEvaluationSnapshot;
    if (this.active) return failure("busy") as DesktopHumanEvaluationSnapshot;
    if (!this.readScopeCurrent()) return { accepted: false, reason: "authority_changed" };
    let release!: () => void;
    const drained = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController();
    this.active = { requestId: `inspect:${request.taskId}`, controller, drained };
    const generation = this.generation, signal = controller.signal;
    let connection: HumanEvaluationConnection | undefined;
    const current = (): boolean => !this.disposed && !signal.aborted && generation === this.generation && isOwnerCurrent() && this.readScopeCurrent();
    const retireConnection = async (): Promise<void> => {
      const retiring = connection;
      connection = undefined;
      if (retiring) { try { await this.options.daemon.revoke(retiring.authority); } catch { /* Never authorize on read errors. */ } }
    };
    try {
      const before = await this.options.native.readSession(signal);
      if (!current() || !before.active || before.locked) return { accepted: false, reason: "authority_changed" };
      connection = await this.options.daemon.handshake({ desktopInstanceId: this.options.desktopInstanceId,
        desktopEpoch: this.desktopEpoch, workspaceCwd: this.options.workspaceCwd, platform: "darwin",
        session: { osSessionId: before.osSessionId, osUserId: before.osUserId, lockEpoch: this.lockEpoch, locked: false } }, signal);
      const a = connection.authority;
      if (!current() || connection.workspaceCwd !== this.options.workspaceCwd || a.desktopEpoch !== this.desktopEpoch
        || a.desktopInstanceId !== this.options.desktopInstanceId || a.lockEpoch !== this.lockEpoch
        || a.osSessionId !== before.osSessionId || a.osUserId !== before.osUserId) return { accepted: false, reason: "authority_changed" };
      const intentId = this.unknownIntents.get(request.taskId);
      const snapshot = await this.options.daemon.snapshot({ authority: a, taskId: request.taskId,
        ...(request.afterRevision !== undefined ? { afterRevision: request.afterRevision } : {}),
        ...(request.reportRef ? { reportRef: request.reportRef } : {}),
        ...(intentId ? { intentId } : {}) }, signal);
      const after = await this.options.native.readSession(signal);
      if (!current() || !sameHumanSession(before, after)) return { accepted: false, reason: "authority_changed" };
      await retireConnection();
      if (!current()) return { accepted: false, reason: "authority_changed" };
      const finalSession = await this.options.native.readSession(signal);
      if (!current() || !sameHumanSession(before, finalSession)) return { accepted: false, reason: "authority_changed" };
      const lastSubmission = !intentId ? "none" : !snapshot.intent ? "unknown"
        : snapshot.intent.state === "consumed" ? "committed" : "pending";
      const head = snapshot.head;
      // Private Host atomic lineage validation, not a head-tuple approximation.
      const reportCurrentness = request.reportRef ? snapshot.reportCurrentness ?? "unavailable" : undefined;
      return { accepted: true, taskId: request.taskId, ...(head ? { head } : {}),
        ...(snapshot.headEvent ? { headEvent: snapshot.headEvent } : {}), events: snapshot.events,
        ...(snapshot.nextAfterRevision !== undefined ? { nextAfterRevision: snapshot.nextAfterRevision } : {}),
        lastSubmission, ...(reportCurrentness ? { reportCurrentness } : {}) };
    } catch { return { accepted: false, reason: signal.aborted ? "cancelled" : "host_rejected" }; }
    finally {
      if (connection) await retireConnection();
      this.active = undefined;
      release();
    }
  }

  private rememberUnknownIntent(taskId: string, intentId: string): void {
    if (!this.unknownIntents.has(taskId) && this.unknownIntents.size >= 32) {
      this.unknownIntents.delete(this.unknownIntents.keys().next().value!);
    }
    this.unknownIntents.set(taskId, intentId);
  }

  list(request: DesktopHumanEvaluationListRequest, isOwnerCurrent: () => boolean): Promise<DesktopHumanEvaluationListResult> {
    return this.readQa("list", isOwnerCurrent, (connection, signal) => this.options.daemon.list({
      authority: connection.authority, ...request }, signal));
  }

  generateReport(request: DesktopHumanEvaluationReportRef, isOwnerCurrent: () => boolean): Promise<DesktopHumanEvaluationReportResult> {
    return this.readQa(`report:${request.taskId}`, isOwnerCurrent, (connection, signal) => this.options.daemon.report({
      authority: connection.authority, ...request }, signal));
  }

  private async readQa<T extends { readonly canonicalWorkspaceCwd: string }>(
    requestId: string, isOwnerCurrent: () => boolean,
    read: (connection: HumanEvaluationConnection, signal: AbortSignal) => Promise<T>,
  ): Promise<({ readonly accepted: true; readonly workspaceCwd: string } & T) | Extract<DesktopHumanEvaluationResult, { accepted: false }>> {
    if (this.disposed || !isOwnerCurrent()) return { accepted: false, reason: "unauthorized_sender" };
    if (this.active) return { accepted: false, reason: "busy" };
    if (!this.readScopeCurrent()) return { accepted: false, reason: "authority_changed" };
    let release!: () => void;
    const drained = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController(), signal = controller.signal, generation = this.generation;
    this.active = { requestId, controller, drained };
    const timer = setTimeout(() => controller.abort(), 30_000);
    const current = (): boolean => !this.disposed && !signal.aborted && generation === this.generation && isOwnerCurrent() && this.readScopeCurrent();
    try {
      const result = await readWithHumanEvaluationAuthority({ ...this.options,
        desktopEpoch: this.desktopEpoch, lockEpoch: this.lockEpoch, signal, current,
        read: async connection => {
          const value = await read(connection, signal);
          if (value.canonicalWorkspaceCwd !== this.options.workspaceCwd) throw new Error("human_read_authority_changed");
          return value;
        } });
      if (!current()) return { accepted: false, reason: "authority_changed" };
      return { accepted: true, ...result, workspaceCwd: this.options.displayWorkspaceCwd ?? this.options.workspaceCwd };
    } catch (error) {
      return { accepted: false, reason: !current() || (error instanceof Error && error.message === "human_read_authority_changed")
        ? "authority_changed" : "host_rejected" };
    } finally { clearTimeout(timer); this.active = undefined; release(); }
  }

  private readScopeCurrent(): boolean {
    try { return this.options.scopeCurrent?.() ?? true; }
    catch { return false; }
  }
}

function failure(reason: Extract<DesktopHumanEvaluationResult, { accepted: false }>["reason"]): DesktopHumanEvaluationResult {
  return { accepted: false, reason };
}
