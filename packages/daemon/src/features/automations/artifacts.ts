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
