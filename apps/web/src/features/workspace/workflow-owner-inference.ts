import type { ProposedPlanArtifact } from "../../types.js";

export type WorkflowOwnerConfidence = "high" | "medium" | "low" | "none";

export interface WorkflowOwnerInferenceTeammate {
  readonly id: string;
  readonly displayName: string;
  readonly roleKey?: string;
  readonly description?: string;
  readonly channelMember?: boolean;
}

export interface WorkflowOwnerInferenceHistoryStep {
  readonly title: string;
  readonly prompt: string;
  readonly toParticipantId: string;
  readonly toParticipantLabel: string;
}

export interface WorkflowStepOwnerPreview {
  readonly title: string;
  readonly suggestedOwnerId?: string;
  readonly suggestedOwnerLabel?: string;
  readonly ownerConfidence: WorkflowOwnerConfidence;
  readonly ownerReason?: string;
  readonly sourceSignals: readonly string[];
}

interface Candidate {
  readonly id: string;
  readonly label: string;
  readonly score: number;
  readonly signal: string;
}

const unassignedPreview = (title: string, reason: string, sourceSignals: readonly string[] = []): WorkflowStepOwnerPreview => ({
  title,
  ownerConfidence: sourceSignals.length > 0 ? "low" : "none",
  ownerReason: reason,
  sourceSignals,
});

export function inferWorkflowOwnerPreviews(input: {
  readonly plan: ProposedPlanArtifact;
  readonly steps: readonly string[];
  readonly teammates: readonly WorkflowOwnerInferenceTeammate[];
  readonly historicalWorkflowSteps: readonly WorkflowOwnerInferenceHistoryStep[];
}): readonly WorkflowStepOwnerPreview[] {
  const teammates = dedupeTeammates(input.teammates);
  const planExplicitOwner = extractGlobalExplicitOwner(input.plan.bodyMarkdown);
  return input.steps.map((step) => {
    const explicitOwner = extractExplicitOwner(step) ?? planExplicitOwner;
    if (explicitOwner) {
      return resolveExplicitOwner(step, explicitOwner, teammates);
    }
    const ownerAgent = resolveAgentOwner(step, input.plan.ownerAgentId, teammates, "plan.ownerAgentId");
    if (ownerAgent) {
      return ownerAgent;
    }
    const sourceAgent = resolveAgentOwner(step, input.plan.sourceAgentId, teammates, "plan.sourceAgentId");
    if (sourceAgent) {
      return sourceAgent;
    }
    const roleOwner = resolveRoleOwner(step, teammates);
    if (roleOwner) {
      return roleOwner;
    }
    const historyOwner = resolveHistoricalOwner(step, input.historicalWorkflowSteps);
    if (historyOwner) {
      return historyOwner;
    }
    return unassignedPreview(step, "No owner signal found.");
  });
}

function resolveExplicitOwner(
  title: string,
  ownerText: string,
  teammates: readonly WorkflowOwnerInferenceTeammate[],
): WorkflowStepOwnerPreview {
  const matched = findTeammateByText(ownerText, teammates);
  if (!matched) {
    return unassignedPreview(title, `Explicit owner "${ownerText}" did not match a channel teammate.`, ["explicit_owner"]);
  }
  return {
    title,
    suggestedOwnerId: matched.id,
    suggestedOwnerLabel: matched.displayName,
    ownerConfidence: "high",
    ownerReason: `Explicit owner "${ownerText}" in the plan.`,
    sourceSignals: ["explicit_owner"],
  };
}

function resolveAgentOwner(
  title: string,
  ownerId: string | undefined,
  teammates: readonly WorkflowOwnerInferenceTeammate[],
  signal: string,
): WorkflowStepOwnerPreview | undefined {
  if (!ownerId) {
    return undefined;
  }
  const matched = teammates.find((teammate) => teammate.id === ownerId);
  return {
    title,
    suggestedOwnerId: ownerId,
    suggestedOwnerLabel: matched?.displayName ?? ownerId,
    ownerConfidence: "high",
    ownerReason: `${signal} points at ${matched?.displayName ?? ownerId}.`,
    sourceSignals: [signal],
  };
}

function resolveRoleOwner(
  title: string,
  teammates: readonly WorkflowOwnerInferenceTeammate[],
): WorkflowStepOwnerPreview | undefined {
  const roleSignals = detectRoleSignals(title);
  if (roleSignals.length === 0) {
    return undefined;
  }
  const candidates = roleSignals.flatMap((signal) => findRoleCandidates(signal.role, teammates, signal.source));
  const winner = chooseUniqueCandidate(candidates);
  if (!winner) {
    return unassignedPreview(title, "Owner signal was ambiguous across teammates.", roleSignals.map((signal) => signal.source));
  }
  return {
    title,
    suggestedOwnerId: winner.id,
    suggestedOwnerLabel: winner.label,
    ownerConfidence: "medium",
    ownerReason: winner.signal,
    sourceSignals: roleSignals.map((signal) => signal.source),
  };
}

function resolveHistoricalOwner(
  title: string,
  historicalWorkflowSteps: readonly WorkflowOwnerInferenceHistoryStep[],
): WorkflowStepOwnerPreview | undefined {
  const titleRoles = detectRoleSignals(title).map((signal) => signal.role);
  const titleTokens = significantTokens(title);
  const matches = historicalWorkflowSteps.filter((step) => {
    if (!step.toParticipantId || step.toParticipantId === "local-user") {
      return false;
    }
    const historyText = `${step.title}\n${step.prompt}`;
    const historyRoles = new Set(detectRoleSignals(historyText).map((signal) => signal.role));
    if (titleRoles.some((role) => historyRoles.has(role))) {
      return true;
    }
    const historyTokens = new Set(significantTokens(historyText));
    return titleTokens.filter((token) => historyTokens.has(token)).length >= 2;
  });
  const owners = uniqueBy(matches.map((step) => ({
    id: step.toParticipantId,
    label: step.toParticipantLabel || step.toParticipantId,
  })), (owner) => owner.id);
  if (owners.length === 1) {
    return {
      title,
      suggestedOwnerId: owners[0].id,
      suggestedOwnerLabel: owners[0].label,
      ownerConfidence: "medium",
      ownerReason: `Same channel workflow history used ${owners[0].label}.`,
      sourceSignals: ["channel_workflow_history"],
    };
  }
  if (owners.length > 1) {
    return unassignedPreview(title, "Workflow history matched multiple owners.", ["channel_workflow_history"]);
  }
  return undefined;
}

function extractExplicitOwner(text: string): string | undefined {
  const match = /(?:^|\n|\b)(?:owner|assignee|负责人)\s*[:：]\s*([^\n]+)/iu.exec(text);
  const ownerText = match?.[1]
    ?.split(/\s+-\s+|[;；]/u)[0]
    ?.replace(/[.,，。]$/u, "")
    .trim();
  return ownerText || undefined;
}

function extractGlobalExplicitOwner(text: string): string | undefined {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (/^(?:owner|assignee|负责人)\s*[:：]/iu.test(trimmed)) {
      return extractExplicitOwner(trimmed);
    }
  }
  return undefined;
}

function detectRoleSignals(text: string): readonly { readonly role: string; readonly source: string }[] {
  const lower = text.toLowerCase();
  const signals: { role: string; source: string }[] = [];
  addRoleSignal(signals, lower, "frontend", ["frontend", "front-end", "ui", "react", "apps/web"]);
  addRoleSignal(signals, lower, "backend", ["backend", "back-end", "daemon", "server", "api", "packages/daemon"]);
  addRoleSignal(signals, lower, "docs", ["docs/", "documentation", "readme", "design doc", "文档"]);
  addRoleSignal(signals, lower, "qa", ["test", "tests", "qa", "playwright", "e2e", "verification", "验证"]);
  return uniqueBy(signals, (signal) => `${signal.role}:${signal.source}`);
}

function addRoleSignal(
  signals: { role: string; source: string }[],
  lowerText: string,
  role: string,
  patterns: readonly string[],
): void {
  const matched = patterns.find((pattern) => lowerText.includes(pattern));
  if (matched) {
    signals.push({ role, source: matched });
  }
}

function findRoleCandidates(
  role: string,
  teammates: readonly WorkflowOwnerInferenceTeammate[],
  source: string,
): readonly Candidate[] {
  return teammates
    .map((teammate) => {
      const searchable = `${teammate.roleKey ?? ""} ${teammate.displayName} ${teammate.description ?? ""}`.toLowerCase();
      const score = teammate.channelMember ? 20 : 10;
      if (role === "frontend" && /\b(frontend|front-end|web|ui|react|designer|design)\b/u.test(searchable)) {
        return { id: teammate.id, label: teammate.displayName, score, signal: `${source} matched frontend/UI ownership.` };
      }
      if (role === "backend" && /\b(backend|back-end|engineer|engineering|server|api|daemon|architect)\b/u.test(searchable)) {
        return { id: teammate.id, label: teammate.displayName, score, signal: `${source} matched backend/daemon ownership.` };
      }
      if (role === "docs" && /\b(docs|documentation|writer|technical writer|pm|product)\b/u.test(searchable)) {
        return { id: teammate.id, label: teammate.displayName, score, signal: `${source} matched documentation ownership.` };
      }
      if (role === "qa" && /\b(qa|test|testing|verification|quality)\b/u.test(searchable)) {
        return { id: teammate.id, label: teammate.displayName, score, signal: `${source} matched QA/testing ownership.` };
      }
      return undefined;
    })
    .filter((candidate): candidate is Candidate => Boolean(candidate));
}

function chooseUniqueCandidate(candidates: readonly Candidate[]): Candidate | undefined {
  if (candidates.length === 0) {
    return undefined;
  }
  const bestScore = Math.max(...candidates.map((candidate) => candidate.score));
  const best = uniqueBy(candidates.filter((candidate) => candidate.score === bestScore), (candidate) => candidate.id);
  return best.length === 1 ? best[0] : undefined;
}

function findTeammateByText(
  text: string,
  teammates: readonly WorkflowOwnerInferenceTeammate[],
): WorkflowOwnerInferenceTeammate | undefined {
  const normalized = normalizeOwnerText(text);
  return teammates.find((teammate) =>
    normalizeOwnerText(teammate.id) === normalized ||
    normalizeOwnerText(teammate.displayName) === normalized ||
    (teammate.roleKey ? normalizeOwnerText(teammate.roleKey) === normalized : false)
  );
}

function dedupeTeammates(teammates: readonly WorkflowOwnerInferenceTeammate[]): readonly WorkflowOwnerInferenceTeammate[] {
  return [...uniqueBy(teammates.filter((teammate) => teammate.id && teammate.displayName), (teammate) => teammate.id)]
    .sort((left, right) => Number(right.channelMember) - Number(left.channelMember));
}

function significantTokens(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_/.-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !["this", "that", "with", "from", "into", "step", "plan"].includes(token))
    .slice(0, 24);
}

function normalizeOwnerText(text: string): string {
  return text.trim().replace(/^@/u, "").toLowerCase();
}

function uniqueBy<T>(items: readonly T[], keyFor: (item: T) => string): readonly T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyFor(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}
