import type { ChannelWorkflow, ChannelWorkflowStep, WorkflowGraphNode } from "@ling-stack/core";
import { workflowGraphFingerprintV1 } from "@ling-stack/contracts";

/** The persisted form is also used to identify, rather than guess at, Host wrappers. */
export function renderGraphNodePrompt(node: WorkflowGraphNode, objective?: string): string {
  return [
    objective !== undefined ? `Workflow objective:\n${objective}` : undefined,
    `Current graph node: ${node.name}`,
    node.skillId ? `Skill: ${node.skillId}` : undefined,
    node.prompt,
    "Complete this graph node only. Do not start or approve later workflow nodes.",
    "Return a concise terminal summary and any artifacts or follow-up decisions needed by later nodes.",
  ].filter((part): part is string => typeof part === "string").join("\n\n");
}

/**
 * Context views already carry the complete objective in a must-keep section.
 * Remove only exact Host-generated copies, never arbitrary repeated user text.
 * Keep the persisted graph/step intact for evidence, retry and lineage checks.
 */
export function projectWorkflowStepPrompt(input: {
  readonly workflow: ChannelWorkflow;
  readonly step: ChannelWorkflowStep;
  readonly prompt: string;
}): string {
  const { workflow, step, prompt } = input;
  const metadata = workflow.metadata;
  const graph = metadata?.workflowGraph;
  if (!graph || graph.schemaVersion !== 1 || !workflow.objective
    || step.workflowId !== workflow.id
    || prompt !== step.prompt
    || graph.id !== metadata.workflowGraphId
    || graph.id !== step.metadata?.graphId
    || metadata.workflowGraphFingerprint !== workflowGraphFingerprintV1(graph)) {
    return prompt;
  }
  const node = graph.nodes.find(candidate => candidate.id === step.metadata?.graphNodeId);
  if (!node || node.name !== step.title || prompt !== renderGraphNodePrompt(node, workflow.objective)) {
    return prompt;
  }

  let instruction = node.prompt;
  if (metadata.sourceProposalId && graph.id === `proposal_${metadata.sourceProposalId}`) {
    const proposalHeader = `Confirmed proposal:\n${workflow.title}\n\n`;
    const scopeHeader = `${proposalHeader}Overall scope:\n${workflow.objective}\n\n`;
    if (instruction.startsWith(scopeHeader)) {
      instruction = proposalHeader + instruction.slice(scopeHeader.length);
    }
  }
  // Rebuild only the known graph wrapper. All node-local operations, command
  // bindings, source references, acceptance and approval constraints survive.
  return renderGraphNodePrompt({ ...node, prompt: instruction });
}
