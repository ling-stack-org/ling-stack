import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({ resolve(specifier, context, next) {
  if (/^\.{1,2}\//u.test(specifier) && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
    const source = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(source))) return { url: source.href, shortCircuit: true };
  }
  return next(specifier, context);
} });

export const t = (key, values = {}) => key.replace(/\{([^}]+)\}/gu, (_, name) => String(values[name] ?? `{${name}}`));
export const workflow = (overrides = {}) => ({ id: "workflow-qa", workspaceId: "workspace-qa", channelId: "channel-qa",
  title: "Review two branch results", objective: "Integrate the changes", status: "succeeded", createdBy: "local-user",
  createdAt: "2026-11-03T00:00:00.000Z", updatedAt: "2026-11-03T00:01:00.000Z", ...overrides });
export const round = (overrides = {}) => ({ roundId: "round-qa", generation: 1, revision: 3, phase: "awaiting_approval",
  lastConfirmedPhase: "awaiting_approval", mode: "apply_to_target", maxConcurrentSteps: 2,
  participants: [{ workflowStepId: "step-1", required: true }, { workflowStepId: "step-2", required: true }],
  candidate: { commit: "a".repeat(40), tree: "b".repeat(40) }, approval: { approvalId: "approval-qa", status: "pending" },
  application: { status: "not_started" }, effects: [{ id: "effect-qa", kind: "candidate_verify", status: "confirmed", artifactIds: ["artifact-qa"] }],
  updatedAt: "2026-11-03T00:02:00.000Z", ...overrides });
export const evidence = (overrides = {}) => ({ schemaVersion: 1, status: "available", rounds: [round()],
  gitEffects: "confirmed", hostOperationPending: false, completion: "blocked", ...overrides });
export const observed = (isolation = evidence(), overrides = {}) => ({ status: "loaded", expected: true, isolation, ...overrides });
export function steps(owner = workflow(), { pinned = true, narration = true } = {}) {
  return [1, 2].map((position) => ({ id: `step-${position}`, workspaceId: owner.workspaceId, channelId: owner.channelId, workflowId: owner.id,
    position, title: `Participant ${position}`, prompt: "Inspect the result", toParticipantId: `participant-${position}`,
    toParticipantLabel: `Participant ${position}`, runId: `run-${position}`, status: "succeeded",
    createdAt: owner.createdAt, updatedAt: owner.updatedAt,
    ...(pinned ? { metadata: { isolationScopePlan: { planId: `plan-${position}` } } } : {}),
    ...(narration ? { runNarration: { runId: `run-${position}`, participantId: `participant-${position}`, workflowStepId: `step-${position}`,
      threadId: "thread-qa", turnId: "turn-qa", sourceItemId: "source-qa", sourceItemSequence: 1, attemptId: `attempt-${position}`,
      segments: [{ content: `Participant ${position} recorded result`, firstEventId: `event-${position}`, lastEventId: `event-${position}`,
        startEventSequence: 1, endEventSequence: 1, completed: true }] } } : {}),
  }));
}
export function progressInput(overrides = {}) {
  const owner = overrides.workflow ?? workflow();
  return { workflow: owner, steps: steps(owner), runs: [], approvals: [], artifactsByRun: {}, executionActions: [], t, ...overrides };
}

export const hookTransforms = {
  "features/workspace/useWorkflowIsolationEvidence.ts": [
    { anchor: 'import { useEffect, useMemo, useRef, useState } from "react";',
      replace: key => `const { useEffect, useMemo, useRef, useState } = globalThis[${JSON.stringify(key)}].ports.hooks;` },
    { anchor: 'import { getChannelWorkflowEvidence } from "../../api/channels.js";',
      replace: key => `const getChannelWorkflowEvidence = (...args) => globalThis[${JSON.stringify(key)}].ports.request(...args);` },
    { anchor: 'import { isDaemonObservationPausedForWorkspace, useDaemonObservation } from "../../shared/conversation/observation/daemon-observation.js";',
      replace: key => `import { isDaemonObservationPausedForWorkspace } from "../../shared/conversation/observation/daemon-observation.js";
        const useDaemonObservation = () => globalThis[${JSON.stringify(key)}].ports.observation;` },
  ],
};
