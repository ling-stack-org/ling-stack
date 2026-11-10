import type { RunEvaluationHumanSubmissionV1 } from "@ling-stack/contracts";
import type {
  DesktopHumanEvaluationCapabilities, DesktopHumanEvaluationListResult,
  DesktopHumanEvaluationReportResult, DesktopHumanEvaluationSnapshot,
} from "../../../../../desktop/shared/human-evaluation-capabilities.js";

type QaList = Extract<DesktopHumanEvaluationListResult, { accepted: true }>;
type QaSnapshot = Extract<DesktopHumanEvaluationSnapshot, { accepted: true }>;
type QaReport = Extract<DesktopHumanEvaluationReportResult, { accepted: true }>;
export type HumanQaReportView = Omit<QaReport, "currentness"> & { readonly currentness: "current" | "stale" | "unavailable" };
export type HumanQaIssue = "unavailable" | "scope_mismatch" | "invalid_response" | "invalid_submission"
  | "submission_unknown" | "cancelled" | "native_unavailable" | "confirmation_failed" | "authority_changed"
  | "host_rejected" | "busy" | "unauthorized_sender" | "invalid_request";
export interface HumanQaState {
  readonly phase: "idle" | "loading" | "ready" | "error" | "unavailable";
  readonly items: QaList["items"];
  readonly nextAfterEnrollmentId?: string;
  readonly selectedTaskId?: string;
  readonly snapshot?: QaSnapshot;
  readonly report?: HumanQaReportView;
  readonly busy?: "list" | "inspect" | "history" | "submit" | "report";
  readonly issue?: HumanQaIssue;
}

/** One explicit QA item at a time. No background enrollment, model calls or automatic retry. */
export function createHumanQaController(capability: DesktopHumanEvaluationCapabilities | undefined,
  cwd: string, newRequestId: () => string = () => `human-qa:${crypto.randomUUID()}`) {
  let active = false;
  let generation = 0;
  let requestId: string | undefined;
  const unresolved = new Map<string, string>();
  let state: HumanQaState = { phase: capability ? "idle" : "unavailable", items: [] };
  const listeners = new Set<() => void>();
  function publish(next: HumanQaState): void {
    state = next;
    for (const listener of listeners) listener();
  }
  const current = (ticket: number): boolean => active && generation === ticket;
  const issue = (reason: unknown): HumanQaIssue => typeof reason === "string" && ["invalid_request", "unauthorized_sender",
    "busy", "cancelled", "native_unavailable", "confirmation_failed", "authority_changed", "host_rejected",
    "submission_unknown"].includes(reason) ? reason as HumanQaIssue : "unavailable";
  const fail = (problem: HumanQaIssue): void => publish({ ...state, phase: "error", busy: undefined, issue: problem });

  async function list(more = false): Promise<void> {
    if (!active || !capability || state.busy || (more && !state.nextAfterEnrollmentId)) return;
    const cursor = more ? state.nextAfterEnrollmentId : undefined;
    const prior = more ? state.items : [];
    const ticket = ++generation;
    publish({ phase: "loading", items: prior, busy: "list", ...(cursor ? { nextAfterEnrollmentId: cursor } : {}) });
    try {
      const result = await capability.list({ limit: 25, ...(cursor ? { afterEnrollmentId: cursor } : {}) });
      if (!current(ticket)) return;
      if (!result.accepted) { fail(issue(result.reason)); return; }
      if (result.canonicalWorkspaceCwd !== cwd && result.workspaceCwd !== cwd) { fail("scope_mismatch"); return; }
      const ids = new Set(prior.map(row => row.enrollmentId));
      const tasks = new Set(prior.map(row => row.taskId));
      if (!Array.isArray(result.items) || result.items.length > 25 || result.items.some(row =>
        !row || !row.enrollmentId || !row.taskId || ids.has(row.enrollmentId) || tasks.has(row.taskId)
        || !ids.add(row.enrollmentId) || !tasks.add(row.taskId))
        || (result.nextAfterEnrollmentId !== undefined && (!result.items.length
          || result.nextAfterEnrollmentId !== result.items.at(-1)?.enrollmentId || result.nextAfterEnrollmentId === cursor))) {
        fail("invalid_response"); return;
      }
      publish({ phase: "ready", items: [...prior, ...result.items], nextAfterEnrollmentId: result.nextAfterEnrollmentId });
    } catch { if (current(ticket)) fail("unavailable"); }
  }

  async function inspect(more = false): Promise<void> {
    const taskId = state.selectedTaskId;
    if (!active || !capability || !taskId || state.busy) return;
    const prior = state.snapshot;
    const afterRevision = more ? prior?.nextAfterRevision : undefined;
    if (more && afterRevision === undefined) return;
    const ticket = ++generation;
    const fixedReport = state.report;
    publish({ ...state, busy: more ? "history" : "inspect", issue: undefined, snapshot: more ? prior : undefined,
      report: fixedReport ? { ...fixedReport, currentness: "unavailable" } : undefined });
    try {
      const result = await capability.inspect({ taskId, ...(afterRevision !== undefined ? { afterRevision } : {}),
        ...(fixedReport ? { reportRef: fixedReport.report.ref } : {}) });
      if (!current(ticket)) return;
      if (!result.accepted) { fail(issue(result.reason)); return; }
      const row = state.items.find(item => item.taskId === taskId);
      const head = result.head, headEvent = result.headEvent;
      const events = result.events;
      if (!row || result.taskId !== taskId || !Array.isArray(events) || events.length > 100
        || !["none", "pending", "committed", "unknown"].includes(result.lastSubmission)
        || (!!head !== !!headEvent) || (head && (head.taskId !== taskId || head.enrollmentId !== row.enrollmentId
          || head.evaluationId !== row.evaluationId || head.eventId !== headEvent?.id || head.revision !== headEvent?.revision))
        || (headEvent && (headEvent.taskId !== taskId || headEvent.enrollmentId !== row.enrollmentId
          || headEvent.evaluationId !== row.evaluationId))
        || events.some((event, index) => event.taskId !== taskId || event.enrollmentId !== row.enrollmentId
          || event.evaluationId !== row.evaluationId || event.revision <= (index ? events[index - 1]!.revision : afterRevision ?? 0))
        || (result.nextAfterRevision !== undefined && (!events.length || result.nextAfterRevision !== events.at(-1)?.revision
          || result.nextAfterRevision <= (afterRevision ?? 0)))) { fail("invalid_response"); return; }
      const report = fixedReport ? { ...fixedReport, currentness: result.reportCurrentness ?? "unavailable" } : undefined;
      const unknownId = unresolved.get(taskId);
      if (unknownId && [...events, ...(headEvent ? [headEvent] : [])].some(event => event.confirmation.requestId === unknownId)) {
        unresolved.delete(taskId);
      }
      publish({ ...state, phase: "ready", busy: undefined, issue: undefined,
        snapshot: { ...result, lastSubmission: unresolved.has(taskId) ? "unknown" : result.lastSubmission,
          events: [...(more ? prior?.events ?? [] : []), ...events] }, report });
    } catch { if (current(ticket)) fail("unavailable"); }
  }

  async function submit(submission: RunEvaluationHumanSubmissionV1): Promise<void> {
    if (!active || !capability || state.busy || !canSubmitHumanQa(state) || unresolved.has(state.selectedTaskId!)) return;
    if (unresolved.size >= 32) { fail("submission_unknown"); return; }
    const snapshot = state.snapshot!;
    const head = snapshot.head;
    if ((submission.kind === "adjudicate" ? !!head : !head || head.state !== "active"
      || (submission.kind === "correct" ? submission.supersedesEventId : submission.revokesEventId) !== head.eventId)
      || !validHumanQaRationale(submission.kind === "revoke" ? submission.rationale : submission.decision.rationale)) {
      fail("invalid_submission"); return;
    }
    const ticket = ++generation;
    const taskId = snapshot.taskId;
    const submittedRequestId = newRequestId();
    requestId = submittedRequestId;
    // Preserve uncertainty before dispatch, even if the disclosure closes before acknowledgement.
    unresolved.set(taskId, submittedRequestId);
    publish({ ...state, busy: "submit", issue: undefined });
    try {
      const result = await capability.submit({ taskId, requestId, submission });
      const uncertain = !result.accepted && ["submission_unknown", "authority_changed", "unauthorized_sender"].includes(result.reason);
      if (!result.accepted && !uncertain && unresolved.get(taskId) === submittedRequestId) unresolved.delete(taskId);
      if (!current(ticket)) return;
      publish({ ...state, busy: undefined, issue: result.accepted ? undefined : issue(result.reason) });
      if (result.accepted || uncertain) {
        // The native button/HTTP response is not a persistence readback. Unknown never resubmits.
        publish({ ...state, snapshot: { ...snapshot, lastSubmission: "unknown" } });
        await inspect();
      }
    } catch {
      if (current(ticket)) {
        unresolved.set(taskId, submittedRequestId);
        publish({ ...state, busy: undefined, issue: "submission_unknown", snapshot: { ...snapshot, lastSubmission: "unknown" } });
      }
    } finally { if (requestId === submittedRequestId) requestId = undefined; }
  }

  async function generateReport(): Promise<void> {
    if (!active || !capability || state.busy || !state.snapshot?.headEvent) return;
    const event = state.snapshot.headEvent;
    const ref = { taskId: event.taskId, eventId: event.id, revision: event.revision };
    const ticket = ++generation;
    publish({ ...state, busy: "report", issue: undefined });
    try {
      const result = await capability.generateReport(ref);
      if (!current(ticket)) return;
      if (!result.accepted) { fail(issue(result.reason)); return; }
      if (result.canonicalWorkspaceCwd !== cwd && result.workspaceCwd !== cwd) { fail("scope_mismatch"); return; }
      if (result.report.authority !== "report-only" || result.report.ref.taskId !== ref.taskId
        || result.report.ref.eventId !== ref.eventId || result.report.ref.revision !== ref.revision) {
        fail("invalid_response"); return;
      }
      publish({ ...state, busy: undefined, report: result });
    } catch { if (current(ticket)) fail("unavailable"); }
  }

  return {
    getSnapshot: (): HumanQaState => state,
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    activate(): Promise<void> { active = true; return state.phase === "idle" ? list() : Promise.resolve(); },
    suspend(): void {
      active = false; generation += 1;
      if (requestId) void capability?.cancel(requestId).catch(() => undefined);
      requestId = undefined;
      publish({ phase: capability ? "idle" : "unavailable", items: [] });
    },
    async select(taskId: string): Promise<void> {
      if (!active || state.busy || !state.items.some(row => row.taskId === taskId)) return;
      generation += 1;
      publish({ ...state, selectedTaskId: taskId, snapshot: undefined, report: undefined, issue: undefined });
      await inspect();
    },
    refresh: (): Promise<void> => list(), loadMore: (): Promise<void> => list(true),
    inspect: (): Promise<void> => inspect(), loadMoreHistory: (): Promise<void> => inspect(true), submit, generateReport,
    async cancel(): Promise<void> {
      if (requestId && state.busy === "submit") {
        try { await capability?.cancel(requestId); } catch { /* Submission outcome remains unknown until readback. */ }
      }
    },
  };
}

export function canSubmitHumanQa(state: HumanQaState): boolean {
  return !!state.snapshot && !state.busy && state.phase === "ready" && state.snapshot.taskId === state.selectedTaskId
    && ["none", "committed"].includes(state.snapshot.lastSubmission) && state.snapshot.head?.state !== "revoked";
}
export function validHumanQaRationale(value: string): boolean {
  return value.trim().length > 0 && value.length <= 2000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}
