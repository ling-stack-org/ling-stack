import { Worker } from "node:worker_threads";
import { dirname } from "node:path";
import { CODE_INTELLIGENCE_OPERATIONS, type PiRunnerCodeIntelligenceRequest, type PiRunnerToolHandledResult } from "@ling-stack/runner-pi";
import { captureCodeSnapshot, workspaceRelativePath } from "../../runtime/code-intelligence/snapshot.js";
import type { CodeQuery } from "../../runtime/code-intelligence/query.js";

const embeddedCodeIntelligenceWorkerSource: string = "NO_PACKAGED_CODE_INTELLIGENCE_WORKER";
let activeWorkers = 0;
export function parseCodeQuery(input: unknown): CodeQuery {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("code_intelligence_input_invalid");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !["operation", "path", "scope", "line", "column", "query", "limit"].includes(key))
    || !(CODE_INTELLIGENCE_OPERATIONS as readonly unknown[]).includes(value.operation)
    || value.query !== undefined && (typeof value.query !== "string" || value.query.length > 200)
    || value.limit !== undefined && (!Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 100)) {
    throw new Error("code_intelligence_input_invalid");
  }
  const path = workspaceRelativePath(value.path, value.operation === "repo_map");
  const scope = value.scope === undefined ? value.operation === "repo_map" ? path : dirname(path) : workspaceRelativePath(value.scope, true);
  if (["definition", "references", "hover"].includes(String(value.operation))
    && [value.line, value.column].some(number => !Number.isSafeInteger(number) || Number(number) < 1 || Number(number) > 1_000_000)) {
    throw new Error("code_intelligence_position_invalid");
  }
  return { ...value, path, scope } as CodeQuery;
}

/** Host-selected root and live admission remain authoritative across snapshot and worker waits. */
export async function executeCodeIntelligence(input: {
  root: string; request: PiRunnerCodeIntelligenceRequest; assertCurrent: () => void;
}): Promise<PiRunnerToolHandledResult> {
  const { request } = input;
  const check = () => { request.signal?.throwIfAborted(); input.assertCurrent(); request.signal?.throwIfAborted(); };
  try {
    check();
    if (request.cwd !== input.root) throw new Error("code_intelligence_cwd_mismatch");
    const query = parseCodeQuery(request.input);
    const snapshot = await captureCodeSnapshot({ root: input.root, scope: query.scope!,
      ...(query.operation !== "repo_map" ? { target: query.path } : {}), signal: request.signal, assertCurrent: input.assertCurrent });
    check();
    if (activeWorkers >= 2) throw new Error("code_intelligence_worker_capacity");
    activeWorkers++;
    let worker: Worker | undefined;
    let result: { items: unknown[]; truncated: boolean };
    try {
      const embedded = embeddedCodeIntelligenceWorkerSource !== "NO_PACKAGED_CODE_INTELLIGENCE_WORKER";
      worker = new Worker(embedded ? embeddedCodeIntelligenceWorkerSource : new URL("../../runtime/code-intelligence/worker.js", import.meta.url), {
        ...(embedded ? { eval: true } : {}),
        workerData: { snapshot, query }, resourceLimits: { maxOldGenerationSizeMb: 192, stackSizeMb: 4 },
      });
      const current = worker;
      result = await new Promise((resolve, reject) => {
        const abort = () => reject(request.signal?.reason ?? new Error("code_intelligence_cancelled"));
        const timer = setTimeout(() => reject(new Error("code_intelligence_query_timeout")), 10_000);
        const cleanup = () => { clearTimeout(timer); request.signal?.removeEventListener("abort", abort); };
        current.once("message", message => { cleanup(); message.ok ? resolve(message.result) : reject(new Error(String(message.message))); });
        current.once("error", error => { cleanup(); reject(error); });
        current.once("exit", code => { cleanup(); reject(new Error(`code_intelligence_worker_exit:${code}`)); });
        request.signal?.addEventListener("abort", abort, { once: true });
        if (request.signal?.aborted) abort();
      });
    } finally { if (worker) await worker.terminate(); activeWorkers--; }
    check();
    const response = { operation: query.operation, snapshot: snapshot.digest, compilerProfile: "typescript-5.9-bundler-strict",
      coverage: { scope: query.scope, files: Object.keys(snapshot.files).length, bytes: snapshot.bytes,
        omitted: snapshot.omitted, partial: snapshot.truncated, dependenciesExcluded: true },
      truncated: result.truncated || snapshot.truncated, items: result.items };
    while (Buffer.byteLength(JSON.stringify(response)) > 32 * 1024 && response.items.length) {
      response.items.pop(); response.truncated = true;
    }
    return { content: [{ type: "text", text: JSON.stringify(response) }], details: response };
  } catch (error) {
    check();
    return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "code_intelligence_failed" }] };
  }
}
