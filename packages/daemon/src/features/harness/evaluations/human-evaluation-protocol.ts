import type {
  RunEvaluationHumanHostBindingV1,
  RunEvaluationHumanConfirmationV1,
  RunEvaluationHumanSubmissionV1,
  RunEvaluationSeverity,
  RunEvaluationVerdict,
} from "@ling-stack/contracts";
import { RUN_EVALUATION_SEVERITIES, RUN_EVALUATION_VERDICTS } from "@ling-stack/contracts";
import { qaModelRecord, qaModelString } from "./qa-model-json.js";

/** Private Main transport protocol. These fields never belong to Renderer IPC. */
export type HumanEvaluationAuthority = RunEvaluationHumanHostBindingV1;
export interface HumanEvaluationHandshakeInput {
  readonly platform: "darwin";
  readonly desktopInstanceId: string;
  readonly desktopEpoch: string;
  readonly workspaceCwd: string;
  readonly session: {
    readonly osSessionId: string;
    readonly osUserId: string;
    readonly lockEpoch: string;
    readonly locked: false;
  };
}
export interface HumanEvaluationHandshake {
  readonly authority: HumanEvaluationAuthority;
  readonly workspaceCwd: string;
  /** Ephemeral Main-only key; never persist, log or return through Renderer IPC. */
  readonly confirmationKey: string;
}
export interface HumanEvaluationCommitInput {
  readonly authority: HumanEvaluationAuthority;
  readonly intentId: string;
  readonly confirmation: RunEvaluationHumanConfirmationV1;
  readonly signature: string;
}

export const HUMAN_EVALUATION_ROOT = "/harness/evaluations/human";
export const HUMAN_EVALUATION_DESKTOP_ROOT = `${HUMAN_EVALUATION_ROOT}/desktop`;
export const HUMAN_EVALUATION_INTENT_TTL_MS = 120_000;
export const HUMAN_EVALUATION_MAX_BODY_BYTES = 32_768;

/** Fixed ordered tuple avoids key-order ambiguity and binds one final OS receipt. */
export function humanEvaluationConfirmationBytes(
  authority: HumanEvaluationAuthority,
  intentId: string,
  confirmation: RunEvaluationHumanConfirmationV1,
): Buffer {
  return Buffer.from(JSON.stringify([
    "ling.human-evaluation.confirmation.v1",
    authority.daemonEpoch, authority.desktopInstanceId, authority.desktopEpoch,
    authority.connectionEpoch, authority.osSessionId, authority.osUserId, authority.lockEpoch,
    intentId, confirmation.kind, confirmation.requestId, confirmation.payloadDigest,
    confirmation.confirmedAt,
  ]), "utf8");
}

export function readHumanEvaluationHandshake(value: unknown): HumanEvaluationHandshakeInput {
  const body = qaModelRecord(value, ["platform", "desktopInstanceId", "desktopEpoch", "workspaceCwd", "session"]);
  const session = qaModelRecord(body.session, ["osSessionId", "osUserId", "lockEpoch", "locked"]);
  if (body.platform !== "darwin" || session.locked !== false) return invalid();
  return Object.freeze({
    platform: "darwin", desktopInstanceId: authorityText(body.desktopInstanceId), desktopEpoch: authorityText(body.desktopEpoch),
    workspaceCwd: qaModelString(body.workspaceCwd, 4_096),
    session: Object.freeze({ osSessionId: authorityText(session.osSessionId), osUserId: authorityText(session.osUserId),
      lockEpoch: authorityText(session.lockEpoch), locked: false }),
  });
}

export function readHumanEvaluationAuthority(value: unknown): HumanEvaluationAuthority {
  const body = qaModelRecord(value, ["daemonEpoch", "desktopInstanceId", "desktopEpoch", "connectionEpoch",
    "osSessionId", "osUserId", "lockEpoch"]);
  return Object.freeze({ daemonEpoch: authorityText(body.daemonEpoch), desktopInstanceId: authorityText(body.desktopInstanceId),
    desktopEpoch: authorityText(body.desktopEpoch), connectionEpoch: authorityText(body.connectionEpoch),
    osSessionId: authorityText(body.osSessionId), osUserId: authorityText(body.osUserId), lockEpoch: authorityText(body.lockEpoch) });
}

export function readHumanEvaluationIntentInput(value: unknown): {
  readonly authority: HumanEvaluationAuthority; readonly taskId: string; readonly requestId: string;
  readonly submission: RunEvaluationHumanSubmissionV1;
} {
  const body = qaModelRecord(value, ["authority", "taskId", "requestId", "submission"]);
  return Object.freeze({ authority: readHumanEvaluationAuthority(body.authority), taskId: text(body.taskId),
    requestId: text(body.requestId), submission: readSubmission(body.submission) });
}

export function readHumanEvaluationCommit(value: unknown): HumanEvaluationCommitInput {
  const body = qaModelRecord(value, ["authority", "intentId", "confirmation", "signature"]);
  const receipt = qaModelRecord(body.confirmation, ["kind", "requestId", "payloadDigest", "confirmedAt"]);
  if (receipt.kind !== "macos_device_owner_authentication" || !sha256(body.signature)
    || !sha256(receipt.payloadDigest) || !timestamp(receipt.confirmedAt)) return invalid();
  return Object.freeze({ authority: readHumanEvaluationAuthority(body.authority), intentId: text(body.intentId),
    confirmation: Object.freeze({ kind: "macos_device_owner_authentication", requestId: text(receipt.requestId),
      payloadDigest: receipt.payloadDigest, confirmedAt: receipt.confirmedAt }), signature: body.signature });
}

export function readHumanEvaluationSnapshot(value: unknown): {
  readonly authority: HumanEvaluationAuthority; readonly taskId: string;
  readonly afterRevision?: number; readonly intentId?: string;
  readonly reportRef?: { readonly taskId: string; readonly eventId: string; readonly revision: number };
} {
  const body = qaModelRecord(value, ["authority", "taskId"], ["afterRevision", "intentId", "reportRef"]);
  if (body.afterRevision !== undefined && (typeof body.afterRevision !== "number"
    || !Number.isSafeInteger(body.afterRevision) || body.afterRevision < 0
    || body.afterRevision >= Number.MAX_SAFE_INTEGER)) return invalid();
  const ref = body.reportRef === undefined ? undefined : qaModelRecord(body.reportRef, ["taskId", "eventId", "revision"]);
  if (ref && (ref.taskId !== body.taskId || !Number.isSafeInteger(ref.revision) || Number(ref.revision) < 1)) return invalid();
  return Object.freeze({ authority: readHumanEvaluationAuthority(body.authority), taskId: text(body.taskId),
    ...(body.afterRevision === undefined ? {} : { afterRevision: body.afterRevision as number }),
    ...(body.intentId === undefined ? {} : { intentId: text(body.intentId) }),
    ...(ref ? { reportRef: Object.freeze({ taskId: text(ref.taskId), eventId: text(ref.eventId), revision: Number(ref.revision) }) } : {}) });
}

export function readHumanEvaluationRevocation(value: unknown): HumanEvaluationAuthority {
  return readHumanEvaluationAuthority(qaModelRecord(value, ["authority"]).authority);
}

/** The Host composition owns workspace/namespace; the caller only supplies a bounded page cursor. */
export function readHumanEvaluationList(value: unknown): {
  readonly authority: HumanEvaluationAuthority; readonly afterEnrollmentId?: string; readonly limit?: number;
} {
  const body = qaModelRecord(value, ["authority"], ["afterEnrollmentId", "limit"]);
  if (body.limit !== undefined && (!Number.isSafeInteger(body.limit) || Number(body.limit) < 1 || Number(body.limit) > 50)) return invalid();
  return Object.freeze({ authority: readHumanEvaluationAuthority(body.authority),
    ...(body.afterEnrollmentId === undefined ? {} : { afterEnrollmentId: text(body.afterEnrollmentId) }),
    ...(body.limit === undefined ? {} : { limit: Number(body.limit) }) });
}

/** Explicit immutable report selection, never a caller-provided grade or adjudicator. */
export function readHumanEvaluationReport(value: unknown): {
  readonly authority: HumanEvaluationAuthority; readonly taskId: string; readonly eventId: string; readonly revision: number;
} {
  const body = qaModelRecord(value, ["authority", "taskId", "eventId", "revision"]);
  if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 1) return invalid();
  return Object.freeze({ authority: readHumanEvaluationAuthority(body.authority), taskId: text(body.taskId),
    eventId: text(body.eventId), revision: Number(body.revision) });
}

function readSubmission(value: unknown): RunEvaluationHumanSubmissionV1 {
  // Copy and validate before inspecting discriminants; unknown fields cannot claim authority.
  const body = qaModelRecord(value, ["kind"], ["decision", "supersedesEventId", "revokesEventId", "rationale"]);
  if (body.kind === "revoke") {
    const exact = qaModelRecord(body, ["kind", "revokesEventId", "rationale"]);
    return Object.freeze({ kind: "revoke", revokesEventId: text(exact.revokesEventId),
      rationale: qaModelString(exact.rationale, 4_000) });
  }
  if (body.kind !== "adjudicate" && body.kind !== "correct") return invalid();
  const exact = qaModelRecord(body, body.kind === "correct"
    ? ["kind", "supersedesEventId", "decision"] : ["kind", "decision"]);
  const decision = qaModelRecord(exact.decision, ["verdict", "rationale"], ["score", "severity"]);
  if (!(RUN_EVALUATION_VERDICTS as readonly unknown[]).includes(decision.verdict)) return invalid();
  if (decision.score !== undefined && (typeof decision.score !== "number" || !Number.isFinite(decision.score)
    || decision.score < 0 || decision.score > 1)) return invalid();
  if (decision.severity !== undefined && !(RUN_EVALUATION_SEVERITIES as readonly unknown[]).includes(decision.severity)) return invalid();
  const copied = Object.freeze({ verdict: decision.verdict as RunEvaluationVerdict,
    rationale: qaModelString(decision.rationale, 4_000),
    ...(decision.score === undefined ? {} : { score: decision.score as number }),
    ...(decision.severity === undefined ? {} : { severity: decision.severity as RunEvaluationSeverity }) });
  return body.kind === "correct"
    ? Object.freeze({ kind: "correct", supersedesEventId: text(exact.supersedesEventId), decision: copied })
    : Object.freeze({ kind: "adjudicate", decision: copied });
}

function boundedIdentity(value: unknown, maximum: number): string {
  const result = qaModelString(value, maximum);
  if (result.trim() !== result) return invalid();
  return result;
}
const text = (value: unknown): string => boundedIdentity(value, 256);
const authorityText = (value: unknown): string => boundedIdentity(value, 160);
function sha256(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function invalid(): never { throw new Error("evaluation_human_request_invalid"); }
