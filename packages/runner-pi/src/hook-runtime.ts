import { DEFAULT_TOOLS } from "./constants.js";
import { readHookSet, type PiHookInvocation } from "./hook-types.js";
import { boundedScriptText, runBoundedScript } from "./script-runtime.js";
import type { PiRunnerRunOptions } from "./types.js";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Hooks can restrict admission or use the existing Host command port, never grant authority. */
export function createHookRuntime(options: PiRunnerRunOptions) {
  const set = options.hooks ? readHookSet(options.hooks) : undefined;
  let count = 0;
  return async (invocation: PiHookInvocation): Promise<{ denied?: string }> => {
    if (!set) return {};
    options.signal?.throwIfAborted();
    for (const hook of set.hooks) {
      if (hook.event !== invocation.event || hook.tools && (!invocation.toolName || !hook.tools.includes(invocation.toolName))) continue;
      const started = performance.now();
      let status: "succeeded" | "denied" | "failed" = "succeeded";
      let message: string | undefined;
      let commandInterrupted = false;
      let hookSignal: AbortSignal | undefined;
      try {
        if (++count > 256) throw new Error("hooks_run_dispatch_limit");
        const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(hook.timeoutMs ?? 5000)]);
        hookSignal = signal;
        signal.throwIfAborted();
        const data = JSON.stringify({ ...invocation, runId: options.runId, attemptId: options.runnerAttemptId, cwd: options.cwd });
        if (Buffer.byteLength(data) > 32 * 1024) throw new Error("hooks_event_input_limit");
        if (hook.kind === "script") {
          const result = await runBoundedScript({ code: `const event = ${data};\n${hook.code}`, signal, timeoutMs: hook.timeoutMs ?? 5000 });
          if (!result.ok) throw new Error(boundedScriptText(result, 2048).text);
          if (invocation.event === "before_tool") {
            if (result.value !== undefined && (!result.value || typeof result.value !== "object"
              || !["allow", "deny"].includes(String((result.value as { decision?: unknown }).decision)))) throw new Error("hooks_policy_result_invalid");
            const value = result.value as { decision?: string; reason?: unknown } | undefined;
            if (value?.decision === "deny") {
              status = "denied"; message = typeof value.reason === "string" && value.reason.trim()
                ? value.reason.slice(0, 1000) : "Hook policy denied this tool.";
            }
          }
        } else {
          if (options.compactionRecovery || options.ordinaryProgressRecovery || options.approvedToolContinuation) {
            throw new Error("hooks_command_recovery_requires_fresh_run");
          }
          if (!(options.tools ?? DEFAULT_TOOLS).includes("bash") || !options.onToolBefore || !options.onApprovalRequired
            || !options.runId || !options.runnerAttemptId) throw new Error("hooks_command_host_authority_missing");
          const toolCallId = `hook:${options.runnerAttemptId}:${count}:${hook.id}`;
          const request = { toolCallId, toolName: "bash", cwd: options.cwd, task: options.task, signal,
            input: { command: `export LING_HOOK_EVENT=${quote(data)}\n${hook.command}`, timeout: Math.ceil((hook.timeoutMs ?? 5000) / 1000) } };
          const gate = await options.onToolBefore(request);
          signal.throwIfAborted();
          if (!gate.allowed) throw new Error(`${gate.code}: ${gate.reason}`);
          options.onEvent?.({ type: "tool_start", toolCallId, parentToolCallId: invocation.toolCallId, toolName: "bash", args: request.input });
          let isError = true;
          let ended = false;
          try {
            const decision = await options.onApprovalRequired(request);
            signal.throwIfAborted();
            isError = !decision.approved || !decision.handledResult || decision.handledResult.isError === true;
            ended = true;
            options.onEvent?.({ type: "tool_end", toolCallId, parentToolCallId: invocation.toolCallId, toolName: "bash",
              isError, result: decision.handledResult ?? { reason: decision.reason ?? "Host handled result required." } });
            if (isError) throw new Error(decision.reason ?? "hooks_command_failed");
          } catch (error) {
            if (!ended) options.onEvent?.({ type: "tool_end", toolCallId, parentToolCallId: invocation.toolCallId,
              toolName: "bash", isError: true, result: { reason: "hooks_command_failed_or_cancelled" } });
            throw error;
          }
        }
        signal.throwIfAborted();
      } catch (error) {
        status = "failed"; message = error instanceof Error ? error.message.slice(0, 1000) : "hooks_execution_failed";
        commandInterrupted = hook.kind === "command" && hookSignal?.aborted === true;
      }
      options.onEvent?.({ type: "hook_execution", hookId: hook.id, configDigest: set.digest, event: invocation.event,
        ...(invocation.toolCallId ? { toolCallId: invocation.toolCallId } : {}), status, durationMs: Math.round(performance.now() - started),
        ...(message ? { message } : {}) });
      options.signal?.throwIfAborted();
      if (status === "denied") return { denied: message };
      if (status === "failed" && (commandInterrupted || (hook.failurePolicy ?? (["before_tool", "run_start"].includes(hook.event) ? "block" : "continue")) === "block")) {
        if (commandInterrupted) {
          const error = new Error(`Hook command ${hook.id} was interrupted: ${message}`);
          if (options.onTaskContinuationDirectiveFailure) options.onTaskContinuationDirectiveFailure(error);
          throw error;
        }
        if (invocation.event === "before_tool") return { denied: `Hook ${hook.id} failed: ${message}` };
        const error = new Error(`Hook ${hook.id} failed: ${message}`);
        if (options.onTaskContinuationDirectiveFailure) options.onTaskContinuationDirectiveFailure(error);
        throw error;
      }
    }
    return {};
  };
}
