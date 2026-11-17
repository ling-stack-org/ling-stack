import { renderToolSample, type CodemodeTool } from "@earendil-works/pi-codemode";
import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_TOOLS } from "../constants.js";
import { createHostToolResultAdapter } from "../host-tool-results.js";
import { boundedScriptText, runBoundedScript } from "../script-runtime.js";
import type { PiRunnerRunOptions } from "../types.js";

/** Read batches may overlap; an effect waits for all earlier calls and excludes later calls. */
export function createScriptToolScheduler() {
  let activeReads = 0, activeEffect = false;
  const queue: { read: boolean; run: () => void }[] = [];
  const drain = () => {
    while (queue.length && !activeEffect) {
      const next = queue[0];
      if (!next.read && activeReads || next.read && activeReads >= 4) return;
      queue.shift();
      if (next.read) activeReads++; else activeEffect = true;
      next.run();
    }
  };
  return <T>(read: boolean, signal: AbortSignal, run: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    queue.push({ read, run: () => {
      void Promise.resolve().then(() => { signal.throwIfAborted(); return run(); }).then(resolve, reject).finally(() => {
        if (read) activeReads--; else activeEffect = false;
        drain();
      });
    } }); drain();
  });
}

export function createLingStackCodeModeExtension(options: PiRunnerRunOptions): ExtensionFactory {
  return pi => {
    const adapt = createHostToolResultAdapter(pi);
    pi.registerTool({
      name: "code_mode", label: "Code Mode", executionMode: "sequential",
      description: "Run an async JavaScript body in a bounded QuickJS VM. Use await, Promise.allSettled, tools.<name>(input), ALL_TOOLS, text(value), or return value. No Node, filesystem, network, imports, timers or direct model calls. Tool calls keep Ling validation, Hooks, approvals and cancellation. Only selected tools are available; control/permission/delegation tools and recursive code_mode are excluded. Reads may run in parallel, effects are serialized. Limit: 32 calls, 30 seconds, 64 MiB VM, 32 KiB output. Tool results are {content,details,isError}; failed calls reject. Inspect ALL_TOOLS for schemas. Storage is local to this execution.",
      parameters: { type: "object", additionalProperties: false, required: ["code"], properties: {
        code: { type: "string", maxLength: 65_536 },
      } } as ToolDefinition["parameters"],
      async execute(toolCallId, params, toolSignal, _update, ctx) {
        if (!ctx || !options.onToolBefore || !options.runId || !options.runnerAttemptId) throw new Error("code_mode_host_authority_missing");
        const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), ...(toolSignal ? [toolSignal] : [])]);
        signal.throwIfAborted();
        const gate = await options.onToolBefore({ toolCallId, toolName: "code_mode", input: params, cwd: options.cwd });
        signal.throwIfAborted();
        if (!gate.allowed) throw new Error(`${gate.code}: ${gate.reason}`);
        const selected = new Set<string>([...(options.tools ?? DEFAULT_TOOLS), ...(options.mcpTools?.map(tool => tool.registeredName) ?? []),
          ...(options.hostCapabilityTools?.map(tool => tool.name) ?? []),
          ...(options.initialToolSurface?.codeIntelligence ? ["code_intelligence"] : []),
          ...(options.initialToolSurface?.toolHydration ? ["load_tools", "hydrated_tool_call"] : []),
          ...(options.initialToolSurface?.mediaGeneration ? options.mediaGenerationTools?.map(tool => tool.name) ?? [] : []),
        ]);
        const forbidden = new Set(["code_mode", "codemode", "request_permission", "request_user_input", "spawn_agent", "send_message", "wait_agent", "interrupt_agent", "resume_agent"]);
        const readNames = new Set(["read", "grep", "find", "ls", "code_intelligence",
          ...(options.mcpTools?.filter(tool => tool.sideEffectLevel === "read").map(tool => tool.registeredName) ?? [])]);
        const schedule = createScriptToolScheduler();
        let callCount = 0;
        let effectStarted = false;
        const callLimit = new AbortController();
        const scriptSignal = AbortSignal.any([signal, callLimit.signal]);
        const pending = new Set<Promise<unknown>>();
        const calls: { id: string; name: string; isError: boolean }[] = [];
        const tools: CodemodeTool[] = ctx.tools.filter(tool => selected.has(tool.name) && !forbidden.has(tool.name)).map(tool => ({
          name: tool.name, description: renderToolSample({ name: tool.name, description: tool.description,
            inputSchema: tool.parameters as Record<string, unknown> }),
          inputSchema: tool.parameters as Record<string, unknown>,
          execute: async (args, context) => {
            if (++callCount > 32) { callLimit.abort(new Error("code_mode_call_limit")); throw new Error("code_mode_call_limit"); }
            const callSignal = AbortSignal.any([scriptSignal, context.signal]);
            const execution = schedule(readNames.has(tool.name), callSignal, async () => {
              callSignal.throwIfAborted();
              if (!readNames.has(tool.name)) effectStarted = true;
              const outcome = await ctx.executeTool(tool.name, args, { signal: callSignal });
              calls.push({ id: outcome.toolCall.id, name: tool.name, isError: outcome.isError });
              callSignal.throwIfAborted();
              if (outcome.isError) throw new Error(outcome.result.content.filter(item => item.type === "text").map(item => item.text).join("\n") || "Nested tool failed");
              return { ...outcome.result, isError: false };
            });
            pending.add(execution);
            try { return await execution; } finally { pending.delete(execution); }
          },
        }));
        const result = await runBoundedScript({ code: String((params as { code: string }).code), signal: scriptSignal, tools });
        if (pending.size) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([Promise.allSettled([...pending]), new Promise<void>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error("code_mode_nested_tools_not_drained")), 2000);
            })]);
          } catch (error) {
            if (options.onTaskContinuationDirectiveFailure) options.onTaskContinuationDirectiveFailure(error);
            throw error;
          } finally { if (timer) clearTimeout(timer); }
        }
        signal.throwIfAborted();
        if (!result.ok && ["timeout", "aborted"].includes(result.error.kind) && effectStarted) {
          const error = new Error(`code_mode_effects_interrupted: ${result.error.message}`);
          if (options.onTaskContinuationDirectiveFailure) options.onTaskContinuationDirectiveFailure(error);
          throw error;
        }
        const output = boundedScriptText(result);
        return adapt(toolCallId, "code_mode", { content: [{ type: "text", text: output.text }], isError: !result.ok,
          details: { calls, attemptedCalls: callCount, truncated: output.truncated, ...(!result.ok ? { errorKind: result.error.kind } : {}) } });
      },
    });
  };
}
