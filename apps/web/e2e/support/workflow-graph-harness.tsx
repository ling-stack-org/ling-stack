import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { WorkflowGraphStepInput } from "@ling-stack/conversation-ui-core";
import { applyResolvedTheme, ThemeRegistry } from "@ling-stack/ui-react/theme";
import { I18nProvider } from "../../src/i18n.js";
import { Field, LingUiProvider, Select } from "../../src/shared/ui/index.js";
import { WorkflowGraphDetail } from "../../src/features/workspace/workflow-graph/WorkflowGraphDetail.js";

const phases = {
  running: "Parallel execution", joining: "Joining results", succeeded: "Completed",
  waiting: "Waiting for approval", failed: "Failed", stale: "Stale snapshot",
} as const;
type Phase = keyof typeof phases;
const workflowId = "graph-motion-fixture";

function stepsFor(phase: Phase): readonly WorkflowGraphStepInput[] {
  const statuses = phase === "succeeded" ? ["succeeded", "succeeded", "succeeded", "succeeded"]
    : phase === "joining" ? ["succeeded", "succeeded", "succeeded", "running"]
    : phase === "waiting" ? ["succeeded", "succeeded", "waiting_for_approval", "queued"]
    : phase === "failed" ? ["succeeded", "succeeded", "failed", "queued"]
    : ["succeeded", "running", "running", "queued"];
  return [
    { id: "plan", title: "Review the implementation", toParticipantLabel: "Architect", dependencies: [] },
    { id: "build", title: "Implement the API", toParticipantLabel: "Engineer", dependencies: ["plan"] },
    { id: "verify", title: "Verify boundary cases", toParticipantLabel: "QA", dependencies: ["plan"] },
    { id: "join", title: "Collect the results", toParticipantLabel: "Architect", dependencies: ["build", "verify"] },
  ].map((step, index) => ({ id: step.id, title: step.title, toParticipantLabel: step.toParticipantLabel,
    workflowId, position: index + 1, status: statuses[index]!, metadata: { dependsOnStepIds: step.dependencies } }));
}

function Fixture(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("running");
  const [longTitles, setLongTitles] = useState(false);
  const steps = stepsFor(phase).map(step => longTitles ? { ...step,
    title: `${step.title}: ${"long-unbroken-boundary-name".repeat(4)}` } : step);
  return <main style={{ maxWidth: 880, margin: "32px auto", padding: "0 20px", color: "var(--ling-text-default)" }}>
    <header style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 16,
      paddingBottom: 24, marginBottom: 20, borderBottom: "1px solid var(--ling-border-default)" }}>
      <strong>Graph motion fixture</strong>
      <Field label="Fixture state"><Select aria-label="Fixture state" value={phase} onChange={event => setPhase(event.target.value as Phase)}>
        {Object.entries(phases).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </Select></Field>
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
        <input type="checkbox" checked={longTitles} onChange={event => setLongTitles(event.target.checked)} />Long titles
      </label>
    </header>
    <WorkflowGraphDetail workflowId={workflowId} steps={steps} timelineItems={[]} daemonHealthy observationReady={phase !== "stale"} />
  </main>;
}

export function mountWorkflowGraphFixture(): () => void {
  const themeId = new URLSearchParams(location.search).get("theme") === "dark" ? "ling-dark" : "ling-light";
  applyResolvedTheme(document.documentElement, new ThemeRegistry().resolve({ mode: "fixed", themeId }, "light"));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  root.render(<I18nProvider><LingUiProvider><Fixture /></LingUiProvider></I18nProvider>);
  return () => { root.unmount(); container.remove(); };
}
