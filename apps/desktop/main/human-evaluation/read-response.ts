import { createHash } from "node:crypto";
import { RUN_EVALUATION_TASK_STATES } from "@ling-stack/contracts";
import type { RunEvaluationHumanQaRowV1, RunEvaluationHumanReportV1,
  RunEvaluationHumanReportSourceV1 } from "@ling-stack/contracts";

type ListResponse = { readonly canonicalWorkspaceCwd: string; readonly items: readonly RunEvaluationHumanQaRowV1[];
  readonly nextAfterEnrollmentId?: string };
type ReportResponse = { readonly canonicalWorkspaceCwd: string; readonly report: RunEvaluationHumanReportV1;
  readonly head: RunEvaluationHumanReportSourceV1["head"]; readonly currentness: "current" | "stale" };

/** Exact bounded private DTOs: unknown fields cannot smuggle identity, paths, credentials or grades. */
export function parseHumanEvaluationListResponse(value: unknown, limit = 25): ListResponse {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) invalid();
  const body = record(value, ["accepted", "canonicalWorkspaceCwd", "items"], ["nextAfterEnrollmentId"]);
  if (body.accepted !== true || !Array.isArray(body.items) || body.items.length > limit) invalid();
  const items = body.items as unknown[];
  const seen = new Set<string>();
  for (const item of items) {
    const row = record(item, ["enrollmentId", "taskId", "evaluationId", "createdAt", "taskState",
      "suiteId", "suiteVersion", "caseId", "caseVersion"], ["head"]);
    for (const field of ["enrollmentId", "taskId", "evaluationId", "suiteId", "suiteVersion", "caseId", "caseVersion"]) text(row[field], 500);
    if (seen.has(row.enrollmentId as string)) invalid();
    seen.add(row.enrollmentId as string);
    timestamp(row.createdAt);
    if (!(RUN_EVALUATION_TASK_STATES as readonly unknown[]).includes(row.taskState)) invalid();
    if (row.head !== undefined) head(row.head);
  }
  if (body.nextAfterEnrollmentId !== undefined && (items.length !== limit
    || text(body.nextAfterEnrollmentId, 500) !== (items[items.length - 1] as Record<string, unknown>)?.enrollmentId)) invalid();
  return { canonicalWorkspaceCwd: workspace(body.canonicalWorkspaceCwd), items: items as unknown as RunEvaluationHumanQaRowV1[],
    ...(body.nextAfterEnrollmentId === undefined ? {} : { nextAfterEnrollmentId: body.nextAfterEnrollmentId as string }) };
}

export function parseHumanEvaluationReportResponse(value: unknown, ref: {
  readonly taskId: string; readonly eventId: string; readonly revision: number;
}): ReportResponse {
  const body = record(value, ["accepted", "canonicalWorkspaceCwd", "report", "head", "currentness"]);
  if (body.accepted !== true || !["current", "stale"].includes(String(body.currentness))) invalid();
  const report = record(body.report, ["schemaVersion", "authority", "ref", "event", "intent", "lineage", "audit", "reportDigest"]);
  if (report.schemaVersion !== 1 || report.authority !== "report-only") invalid();
  const selected = record(report.ref, ["taskId", "eventId", "revision"]);
  text(selected.taskId, 500); text(selected.eventId, 500); integer(selected.revision);
  if (selected.taskId !== ref.taskId || selected.eventId !== ref.eventId || selected.revision !== ref.revision) invalid();
  const event = record(report.event, ["schemaVersion", "id", "taskId", "enrollmentId", "evaluationId", "intentId", "revision",
    "submission", "payloadDigest", "confirmation", "auditSeq", "createdAt"]);
  if (event.schemaVersion !== 1 || event.id !== ref.eventId || event.taskId !== ref.taskId || event.revision !== ref.revision) invalid();
  for (const field of ["enrollmentId", "evaluationId", "intentId"]) text(event[field], 500);
  integer(event.revision);
  integer(event.auditSeq); hash(event.payloadDigest); timestamp(event.createdAt); submission(event.submission);
  const confirmation = record(event.confirmation, ["kind", "requestId", "payloadDigest", "confirmedAt"]);
  if (confirmation.kind !== "macos_device_owner_authentication" || confirmation.payloadDigest !== event.payloadDigest) invalid();
  text(confirmation.requestId, 500); timestamp(confirmation.confirmedAt);
  const intent = record(report.intent, ["id", "payloadDigest"]);
  if (intent.id !== event.intentId || intent.payloadDigest !== event.payloadDigest) invalid();
  const lineage = record(report.lineage, ["enrollmentId", "batchId", "evaluationId", "evaluationKey", "artifactPins",
    "configArtifact", "configDigest", "frozenGraderDigest", "rubric", "rubricDigest"]);
  if (lineage.enrollmentId !== event.enrollmentId || lineage.evaluationId !== event.evaluationId) invalid();
  text(lineage.batchId, 500); text(lineage.evaluationKey, 500);
  for (const field of ["configDigest", "frozenGraderDigest", "rubricDigest"]) hash(lineage[field]);
  const pins = record(lineage.artifactPins, ["suite", "case", "baseline", "candidate", "frozen"]);
  for (const pin of Object.values(pins)) artifactPin(pin);
  artifactPin(lineage.configArtifact);
  const rubric = record(lineage.rubric, ["id", "version", "instructions"]);
  text(rubric.id, 500); text(rubric.version, 500); text(rubric.instructions, 4_096);
  const audit = record(report.audit, ["seq", "action", "createdAt"]);
  if (audit.seq !== event.auditSeq) invalid();
  text(audit.action, 500); timestamp(audit.createdAt);
  const currentHead = head(body.head);
  if (currentHead.revision < ref.revision) invalid();
  const current = currentHead.state === "active" && currentHead.eventId === ref.eventId && currentHead.revision === ref.revision;
  if (body.currentness !== (current ? "current" : "stale")) invalid();
  hash(report.reportDigest);
  const { reportDigest, ...content } = report;
  if (createHash("sha256").update(JSON.stringify(sorted(content)), "utf8").digest("hex") !== reportDigest) invalid();
  return { canonicalWorkspaceCwd: workspace(body.canonicalWorkspaceCwd), report: report as unknown as RunEvaluationHumanReportV1,
    head: currentHead, currentness: body.currentness as "current" | "stale" };
}

function submission(value: unknown): void {
  const input = record(value, ["kind"], ["decision", "supersedesEventId", "revokesEventId", "rationale"]);
  if (input.kind === "revoke") {
    const revoke = record(input, ["kind", "revokesEventId", "rationale"]);
    text(revoke.revokesEventId, 500); text(revoke.rationale, 4_096); return;
  }
  if (input.kind !== "adjudicate" && input.kind !== "correct") invalid();
  const data = record(input, input.kind === "adjudicate" ? ["kind", "decision"] : ["kind", "decision", "supersedesEventId"]);
  if (input.kind === "correct") text(data.supersedesEventId, 500);
  const decision = record(data.decision, ["verdict", "rationale"], ["score", "severity"]);
  if (!["pass", "fail", "abstain", "error"].includes(String(decision.verdict))) invalid();
  text(decision.rationale, 4_096);
  if (decision.score !== undefined && (typeof decision.score !== "number" || !Number.isFinite(decision.score)
    || decision.score < 0 || decision.score > 1)) invalid();
  if (decision.severity !== undefined && !["info", "warning", "error", "critical"].includes(String(decision.severity))) invalid();
}
function artifactPin(value: unknown): void {
  const pin = record(value, ["artifactId", "contentSha256"]); text(pin.artifactId, 500); hash(pin.contentSha256);
}
function head(value: unknown): RunEvaluationHumanReportSourceV1["head"] {
  const data = record(value, ["eventId", "revision", "state"]);
  text(data.eventId, 500); integer(data.revision);
  if (!["active", "revoked"].includes(String(data.state))) invalid();
  return data as unknown as RunEvaluationHumanReportSourceV1["head"];
}
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string" || ![...required, ...optional].includes(key)
    || !Object.hasOwn(descriptors[key]!, "value")) || required.some(key => !Object.hasOwn(descriptors, key))) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim().length < 1) return invalid();
  return value;
}
function workspace(value: unknown): string {
  const path = text(value, 4_096);
  if (!path.startsWith("/") || /[\u0000-\u001f\u007f]/u.test(path)) invalid();
  return path;
}
function integer(value: unknown): void { if (!Number.isSafeInteger(value) || Number(value) < 1) invalid(); }
function hash(value: unknown): void { if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) invalid(); }
function timestamp(value: unknown): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => [key, sorted(item)]));
  return value;
}
function invalid(): never { throw new Error("human_daemon_response_invalid"); }
