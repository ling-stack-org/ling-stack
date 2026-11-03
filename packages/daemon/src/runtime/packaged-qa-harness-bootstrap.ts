import { isAbsolute, resolve } from "node:path";
import type { HarnessFeatureConfig } from "../config.js";

/**
 * Typed Host bootstrap for the isolated packaged QA process only. It selects
 * tools/workflows, not permission escalation, model calls, prices or approvals.
 * Desktop validates private policy-file custody before emitting this snapshot.
 */
export function readPackagedQaHarnessSelection(environment: NodeJS.ProcessEnv): HarnessFeatureConfig | undefined {
  const raw = environment.LING_STACK_QA_HARNESS_SELECTION;
  if (raw === undefined) return undefined;
  try {
    if (environment.LING_STACK_PACKAGED_DESKTOP !== "1" || environment.LING_STACK_PORT !== "17928"
      || !["127.0.0.1", "localhost", "::1"].includes(environment.LING_STACK_HOST ?? "")
      || environment.LING_STACK_HARNESS_CONTINUATIONS_MODE !== "enforce"
      || environment.LING_STACK_HARNESS_TOOL_BROKER_MODE !== "enforce"
      || environment.LING_STACK_HARNESS_DELEGATIONS_MODE !== "enforce"
      || raw.length < 1 || Buffer.byteLength(raw, "utf8") > 4096) throw new Error();
    const value: unknown = JSON.parse(raw);
    if (!exact(value, ["schemaVersion", "kind", "modelExecution", "workspaceCwd", "selectedWorkflowIds", "maxDepth", "rootBudget"])
      || value.schemaVersion !== 1 || value.kind !== "isolated-qa-delegation-selection"
      || value.modelExecution !== "host-authorized-budgeted"
      || typeof value.workspaceCwd !== "string" || !isAbsolute(value.workspaceCwd)
      || /[\0\r\n]/u.test(value.workspaceCwd) || resolve(value.workspaceCwd) !== value.workspaceCwd
      || value.workspaceCwd !== environment.LING_STACK_DEFAULT_WORKSPACE_CWD
      || !Array.isArray(value.selectedWorkflowIds) || value.selectedWorkflowIds.length < 1 || value.selectedWorkflowIds.length > 100
      || value.selectedWorkflowIds.some(id => typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/u.test(id))
      || new Set(value.selectedWorkflowIds).size !== value.selectedWorkflowIds.length
      || !positive(value.maxDepth) || value.maxDepth > 16
      || !exact(value.rootBudget, ["tokenBudget", "wallTimeBudgetMs"])
      || !positive(value.rootBudget.tokenBudget) || !positive(value.rootBudget.wallTimeBudgetMs)) throw new Error();
    return Object.freeze({ continuations: Object.freeze({ mode: "enforce" as const }),
      toolBroker: Object.freeze({ mode: "enforce" as const }),
      delegations: Object.freeze({ mode: "enforce" as const, maxDepth: value.maxDepth,
        selectedWorkflowIds: Object.freeze([...value.selectedWorkflowIds] as string[]),
        rootBudget: Object.freeze({ tokenBudget: value.rootBudget.tokenBudget, wallTimeBudgetMs: value.rootBudget.wallTimeBudgetMs }) }) });
  } catch { throw new Error("packaged_qa_harness_selection_invalid"); }
}

function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Reflect.ownKeys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}
