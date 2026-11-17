import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { CODE_INTELLIGENCE_OPERATIONS } from "../code-intelligence-types.js";
import { createHostToolResultAdapter } from "../host-tool-results.js";
import type { PiRunnerRunOptions } from "../types.js";

export function createLingStackCodeIntelligenceExtension(options: PiRunnerRunOptions): ExtensionFactory {
  return pi => {
    const adapt = createHostToolResultAdapter(pi);
    pi.registerTool({
      name: "code_intelligence", label: "Code intelligence",
      description: "Query TypeScript/JavaScript definitions, references, types, symbols, diagnostics or a repo map in a bounded Host workspace snapshot. Positions are one-based UTF-16. Check coverage/truncated before interpreting empty results. No code execution or emit. Use scope to narrow a large repository.",
      parameters: { type: "object", additionalProperties: false, required: ["operation", "path"], properties: {
        operation: { type: "string", enum: [...CODE_INTELLIGENCE_OPERATIONS] },
        path: { type: "string", description: "Workspace-relative source file, or directory for repo_map." },
        scope: { type: "string", description: "Workspace-relative directory to index; defaults to the source file directory." },
        line: { type: "integer", minimum: 1 }, column: { type: "integer", minimum: 1 },
        query: { type: "string", maxLength: 200 }, limit: { type: "integer", minimum: 1, maximum: 100 },
      } } as ToolDefinition["parameters"], executionMode: "parallel",
      async execute(toolCallId, input, toolSignal) {
        const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), ...(toolSignal ? [toolSignal] : [])]);
        signal.throwIfAborted();
        if (!options.onCodeIntelligenceCall || !options.onToolBefore || !options.onApprovalRequired || !options.runId || !options.runnerAttemptId) {
          throw new Error("Code intelligence requires live Host workspace and Run/Attempt authority.");
        }
        const decision = await options.onToolBefore({ toolCallId, toolName: "code_intelligence", input, cwd: options.cwd });
        signal.throwIfAborted();
        if (!decision.allowed) throw new Error(`${decision.code}: ${decision.reason}`);
        const query = input as { path: string; scope?: string; operation: string };
        const readDecision = await options.onApprovalRequired({ toolCallId, toolName: "read", task: options.task, cwd: options.cwd, signal,
          input: { path: query.scope ?? (query.operation === "repo_map" ? query.path : dirname(query.path)) } });
        signal.throwIfAborted();
        if (!readDecision.approved) throw new Error(readDecision.reason ?? "Code intelligence workspace reads were denied by Host policy.");
        const current = await options.onToolBefore({ toolCallId, toolName: "code_intelligence", input, cwd: options.cwd });
        signal.throwIfAborted();
        if (!current.allowed) throw new Error(`${current.code}: ${current.reason}`);
        const result = await options.onCodeIntelligenceCall({ toolCallId, input, cwd: options.cwd, signal });
        signal.throwIfAborted();
        return adapt(toolCallId, "code_intelligence", result);
      },
    });
  };
}
