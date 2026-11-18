import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AutomationDefinition,
  AutomationRun,
  RunArtifact,
  RunExecutionStoreFacet,
  RunSession,
  RunStorePathsFacet,
} from "@ling-stack/core";
import { automationMonitorFingerprint as createMonitorFingerprint } from "@ling-stack/core";
import type { AutomationContextBuildResult } from "./context.js";

type AutomationArtifactStore = RunStorePathsFacet & RunExecutionStoreFacet;

export function createAutomationContextArtifact(input: {
  readonly store: AutomationArtifactStore;
  readonly automation: AutomationDefinition;
  readonly automationRun: AutomationRun;
  readonly run: RunSession;
  readonly context: AutomationContextBuildResult;
  readonly now: string;
}): RunArtifact {
  const relativePath = join("automation-context", `${input.run.id}-${input.automationRun.id}.md`);
  const absolutePath = join(input.store.paths.artifactsDir, relativePath);
  const content = renderAutomationContextArtifact(input);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
  return input.store.createArtifact({
    runId: input.run.id,
    type: "markdown",
    path: relativePath,
    title: `Automation context: ${input.automation.title}`,
    contentType: "text/markdown; charset=utf-8",
    sizeBytes: Buffer.byteLength(content, "utf8"),
    createdAt: input.now,
  });
}

/**
 * Persist the bounded facts that caused a monitor trigger next to the Run that
 * will process them. The artifact is deliberately markdown so it is visible
 * through the existing Run artifact surface, while the sealed payload keeps
 * the exact JSON facts available to future projections.
 */
export function createAutomationMonitorFindingArtifact(input: {
  readonly store: AutomationArtifactStore;
  readonly automation: AutomationDefinition;
  readonly automationRun: AutomationRun;
  readonly run: RunSession;
  readonly snapshot: Record<string, unknown>;
  readonly now: string;
}): RunArtifact {
  if (input.automation.trigger.type !== "monitor") {
    throw new Error("Monitor finding artifacts require a monitor automation");
  }
  const fingerprint = createMonitorFingerprint(input.automation.trigger.source, input.snapshot);
  const relativePath = join("automation-monitor-findings", `${input.run.id}-${input.automationRun.id}.md`);
  const absolutePath = join(input.store.paths.artifactsDir, relativePath);
  const content = renderAutomationMonitorFindingArtifact({
    automation: input.automation,
    automationRun: input.automationRun,
    fingerprint,
    snapshot: input.snapshot,
  });
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
  return input.store.createArtifact({
    runId: input.run.id,
    type: "markdown",
    path: relativePath,
    title: `Monitor finding: ${input.automation.title}`,
    contentType: "text/markdown; charset=utf-8",
    sizeBytes: Buffer.byteLength(content, "utf8"),
    sealedPayload: {
      automationId: input.automation.id,
      automationRunId: input.automationRun.id,
      fingerprint,
      source: input.automation.trigger.source,
      condition: input.automation.trigger.condition,
      snapshot: input.snapshot,
    },
    createdAt: input.now,
  });
}

function renderAutomationContextArtifact(input: {
  readonly automation: AutomationDefinition;
  readonly automationRun: AutomationRun;
  readonly context: AutomationContextBuildResult;
}): string {
  return [
    `# Automation Context Preview`,
    "",
    `Automation: ${input.automation.title}`,
    `Automation ID: ${input.automation.id}`,
    `Automation Run ID: ${input.automationRun.id}`,
    "",
    `## Rendered Prompt`,
    "",
    input.context.renderedPrompt,
    "",
    `## Selected References`,
    "",
    input.context.selectedRefs.length > 0
      ? input.context.selectedRefs.map((ref) => `- ${ref.kind}${ref.id ? `:${ref.id}` : ""}${ref.label ? ` - ${ref.label}` : ""}`).join("\n")
      : "No references selected.",
    "",
    `## Warnings`,
    "",
    input.context.warnings.length > 0
      ? input.context.warnings.map((warning) => `- ${warning}`).join("\n")
      : "No warnings.",
    "",
  ].join("\n");
}

function renderAutomationMonitorFindingArtifact(input: {
  readonly automation: AutomationDefinition;
  readonly automationRun: AutomationRun;
  readonly fingerprint: string;
  readonly snapshot: Record<string, unknown>;
}): string {
  if (input.automation.trigger.type !== "monitor") {
    throw new Error("Monitor finding artifacts require a monitor automation");
  }
  return [
    `# Automation Monitor Finding`,
    "",
    `Automation: ${input.automation.title}`,
    `Automation ID: ${input.automation.id}`,
    `Automation Run ID: ${input.automationRun.id}`,
    `Source: ${input.automation.trigger.source.kind}`,
    `Fingerprint: ${input.fingerprint}`,
    "",
    "## Condition",
    "",
    "```json",
    JSON.stringify(input.automation.trigger.condition, null, 2),
    "```",
    "",
    "## Snapshot",
    "",
    "```json",
    JSON.stringify(input.snapshot, null, 2),
    "```",
    "",
  ].join("\n");
}
