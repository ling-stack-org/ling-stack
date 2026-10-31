import type {
  DelegationCompletionEvidenceV1,
  RunSession,
  RunStore,
  TerminalReportEvidenceRisk,
  TerminalReportEvidenceStep,
  TerminalReportEvidenceParticipant,
  TerminalReportSourceRef,
} from "@ling-stack/core";

export interface TerminalReportDelegationEvidence {
  readonly basis: DelegationCompletionEvidenceV1;
  readonly runs: readonly RunSession[];
  readonly steps: readonly TerminalReportEvidenceStep[];
  readonly participants: readonly TerminalReportEvidenceParticipant[];
  readonly references: readonly TerminalReportSourceRef[];
  readonly risks: readonly TerminalReportEvidenceRisk[];
}

/**
 * Only Host-sealed lineage is projected. Objective/permission artifacts, result
 * bodies, credentials and model claims never become completion authority.
 * The canonical reader bounds the subtree; the final report budgets bound its
 * visible rows independently, without weakening the full publication barrier.
 */
export function collectTerminalReportDelegationEvidence(
  store: RunStore,
  input: {
    readonly rootRunIds: readonly string[];
    readonly workspaceId: string;
    readonly channelId?: string;
    readonly threadId?: string;
  },
): TerminalReportDelegationEvidence {
  const basis = store.getDelegationCompletionEvidence({ rootRunIds: input.rootRunIds });
  const runs: RunSession[] = [];
  const steps: TerminalReportEvidenceStep[] = [];
  const participants: TerminalReportEvidenceParticipant[] = [];
  const references: TerminalReportSourceRef[] = [];
  const risks: TerminalReportEvidenceRisk[] = [];
  for (const row of basis.steps) {
    const run = row.childRun ? store.getRun(row.childRun.id) : undefined;
    const scopeValid = Boolean(run && row.workUnit?.workspaceId === input.workspaceId
      && row.childRun?.channelId === input.channelId && run.channelId === input.channelId
      && (!input.threadId || row.childRun?.threadId === input.threadId && run.threadId === input.threadId));
    if (run && !scopeValid) {
      risks.push({ id: `delegation-scope:${row.step.id}`, severity: "critical", status: "unverified",
        summary: "A delegated child is outside the report's conversation scope; its content was withheld.", sourceRefs: [ref("delegation_step", row.step.id)] });
      continue;
    }
    const stepRefs = [ref("delegation_step", row.step.id)];
    if (row.reservation) stepRefs.push(ref("delegation_budget_reservation", row.reservation.id));
    if (row.childRun) stepRefs.push(ref("run", row.childRun.id));
    if (row.attempt) stepRefs.push(ref("runtime_attempt", row.attempt.sourceFence.attemptId));
    if (row.hostCompletion) stepRefs.push(ref("host_attempt_completion", row.hostCompletion.source.attemptId));
    for (const charge of row.charges) stepRefs.push(ref("delegation_budget_charge", charge.id));
    // The typed result is independently checked by the canonical Host reader.
    // Its artifact id remains an audit anchor, not a public artifact payload.
    for (const result of row.results) if (result.payload) {
      stepRefs.push(ref("delegation_result", result.message.id));
      // Keep this audit-only artifact out of the visible row's refs: shared
      // privacy filtering correctly hides a whole row with a restricted ref.
      references.push({ kind: "artifact", id: result.artifactId, visibility: "developer_only", sensitivity: "normal" });
    }
    references.push(...stepRefs);
    if (scopeValid && run) runs.push(run);
    const verified = scopeValid && basis.issues.length === 0 && row.step.state === "succeeded" && row.quiescence === "verified"
      && row.results.some(result => result.payload?.outcome === "succeeded");
    const status = verified ? "succeeded" : row.step.state === "failed" || row.step.state === "lost" ? "failed"
      : row.step.state === "cancelled" ? "cancelled" : "blocked";
    steps.push({ id: `delegation-step:${row.step.id}`, title: "Delegated task", status,
      ...(scopeValid && run ? { runId: run.id, teammateId: run.teammateId } : {}),
      resultSummary: verified ? "Host verified the delegated result, execution completion and budget settlement." : undefined,
      blocker: status === "blocked" ? "The Host has not verified a complete delegated result." : undefined,
      changedPaths: [], artifactIds: [], sourceRefs: stepRefs });
    if (scopeValid && run) {
      const teammate = run.teammateId ? store.getAiTeammate(run.teammateId) : undefined;
      participants.push({ agentId: run.teammateId ?? row.step.id,
        displayName: teammate?.displayName ?? run.teammateId ?? "Delegated agent",
        roleKey: teammate?.roleKey, status: status === "succeeded" ? "completed" : status,
        workflowStepIds: run.workflowStepId ? [run.workflowStepId] : [], runIds: [run.id],
        contributionSummaries: verified ? ["Host verified the delegated result, execution completion and budget settlement."] : [],
        sourceRefs: stepRefs });
    }
  }
  if (basis.status !== "satisfied") {
    const visibleReferences = references.filter(reference => reference.visibility !== "developer_only");
    risks.push({ id: "delegation-completion-barrier", severity: "critical", status: "unverified",
      summary: `Required delegated work is ${basis.status}; the Host has not certified successful completion.`,
      sourceRefs: visibleReferences.length ? visibleReferences.slice(0, 8) : basis.rootRunIds.map(id => ref("run", id)) });
  }
  return { basis, runs: [...new Map(runs.map(run => [run.id, run])).values()], steps, participants, references, risks };
}

function ref(kind: TerminalReportSourceRef["kind"], id: string): TerminalReportSourceRef {
  return { kind, id, visibility: "folded_evidence", sensitivity: "normal" };
}
