import type {
  TerminalReportEvidenceSnapshot,
  TerminalReportSourceRef,
} from "@ling-stack/core";

export const TERMINAL_REPORT_PROMPT_VERSION = "terminal-report-v1";

export const TERMINAL_REPORT_SYSTEM_PROMPT = [
  "You are Ling Agent's terminal report synthesizer.",
  "Return one strict JSON object matching the requested terminal report content schema.",
  "Use only supplied evidence and source refs.",
  "Do not claim tests, changes, participants, approvals, commits, pull requests, deployments, or service state without matching evidence.",
  "Do not reveal secrets or developer-only evidence.",
  "Do not call tools or propose additional execution.",
].join(" ");

export interface TerminalReportPrompt {
  readonly prompt: string;
  readonly allowedSourceRefKeys: readonly string[];
}

export function buildTerminalReportPrompt(
  snapshot: TerminalReportEvidenceSnapshot,
  repair?: { readonly validationCodes: readonly string[]; readonly previousOutput: string },
): TerminalReportPrompt {
  const safeSnapshot = modelVisibleSnapshot(snapshot);
  const allowedSourceRefKeys = collectAllowedRefs(safeSnapshot).map((ref) => `${ref.kind}:${ref.id}`);
  const schema = {
    outcome: {
      status: "succeeded|partially_succeeded|blocked|failed|cancelled",
      title: "string",
      summary: "string",
      corrections: [{ id: "string", originalAssumption: "string", correctedFact: "string", confidence: "high|medium", sourceRefs: [sourceRefShape()] }],
      sourceRefs: [sourceRefShape()],
    },
    changes: [{ id: "string", kind: "behavior|code|configuration|documentation|data|other", title: "string", summary: "string", paths: ["string"], sourceRefs: [sourceRefShape()] }],
    verification: [{ id: "string", title: "string", status: "passed|failed|blocked|cancelled|skipped|not_run|unknown", summary: "string optional", command: "string optional", sourceRefs: [sourceRefShape()] }],
    participants: [{ agentId: "string", displayName: "string", roleKey: "string optional", status: "completed|failed|blocked|cancelled", contribution: "string", sourceRefs: [sourceRefShape()] }],
    artifacts: [{ id: "string", kind: "file|diff|document|image|test_result|commit|pull_request|deployment|external|other", title: "string", path: "string optional", href: "string optional", summary: "string optional", sourceRefs: [sourceRefShape()] }],
    risks: [{ id: "string", severity: "info|warning|critical", status: "unresolved|mitigated|accepted|unverified", approvalDecision: "pending|approved|denied|expired|cancelled optional", summary: "string", nextAction: "string optional", sourceRefs: [sourceRefShape()] }],
    references: [sourceRefShape()],
  };
  const repairBlock = repair
    ? [
        "Repair the previous invalid output.",
        `Validation codes: ${repair.validationCodes.join(", ") || "terminal_report_schema_invalid"}`,
        `Previous output: ${repair.previousOutput}`,
      ].join("\n")
    : "";
  return {
    allowedSourceRefKeys,
    prompt: [
      `Prompt version: ${TERMINAL_REPORT_PROMPT_VERSION}`,
      `Language: ${snapshot.language}`,
      `Objective: ${snapshot.objective}`,
      `Allowed source refs: ${allowedSourceRefKeys.join(", ")}`,
      "Return JSON only. Keep every section as an array, using [] when empty.",
      `Exact content shape: ${JSON.stringify(schema)}`,
      `Evidence snapshot: ${JSON.stringify(safeSnapshot)}`,
      repairBlock,
    ].filter(Boolean).join("\n\n"),
  };
}

function modelVisibleSnapshot(snapshot: TerminalReportEvidenceSnapshot): TerminalReportEvidenceSnapshot {
  const visibleRef = (ref: TerminalReportSourceRef) =>
    ref.visibility !== "developer_only" && ref.sensitivity !== "secret_adjacent";
  const filterRefs = (refs: readonly TerminalReportSourceRef[]) => refs.filter(visibleRef);
  return {
    ...snapshot,
    steps: snapshot.steps.map((item) => ({ ...item, sourceRefs: filterRefs(item.sourceRefs) })),
    operations: snapshot.operations.map((item) => ({ ...item, sourceRefs: filterRefs(item.sourceRefs) })),
    checks: snapshot.checks.map((item) => ({ ...item, sourceRefs: filterRefs(item.sourceRefs) })),
    participants: snapshot.participants.map((item) => ({ ...item, sourceRefs: filterRefs(item.sourceRefs) })),
    artifacts: snapshot.artifacts
      .filter((item) => item.sourceRefs.some((ref) => ref.kind === "artifact" && ref.id === item.id && visibleRef(ref)))
      .map((item) => ({ ...item, sourceRefs: filterRefs(item.sourceRefs) })),
    approvals: snapshot.approvals.map((item) => ({ ...item, sourceRefs: filterRefs(item.sourceRefs) })),
    risks: snapshot.risks.map((item) => ({ ...item, sourceRefs: filterRefs(item.sourceRefs) })),
    references: filterRefs(snapshot.references),
  };
}

function collectAllowedRefs(snapshot: TerminalReportEvidenceSnapshot): TerminalReportSourceRef[] {
  const refs = [
    ...snapshot.references,
    ...snapshot.steps.flatMap((item) => item.sourceRefs),
    ...snapshot.operations.flatMap((item) => item.sourceRefs),
    ...snapshot.checks.flatMap((item) => item.sourceRefs),
    ...snapshot.participants.flatMap((item) => item.sourceRefs),
    ...snapshot.artifacts.flatMap((item) => item.sourceRefs),
    ...snapshot.approvals.flatMap((item) => item.sourceRefs),
    ...snapshot.risks.flatMap((item) => item.sourceRefs),
  ];
  return [...new Map(refs.map((ref) => [`${ref.kind}:${ref.id}`, ref])).values()];
}

function sourceRefShape(): Record<string, string> {
  return {
    kind: "source ref kind",
    id: "allowed source ref id",
    label: "string optional",
    href: "string optional",
    visibility: "conversation|folded_evidence|developer_only",
    sensitivity: "normal|private|secret_adjacent optional",
  };
}
