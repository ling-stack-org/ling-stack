// Negative control: restore only the confirmed ordinary-Thread search bypass.
import assert from "node:assert/strict";
export { resolve } from "./public-projection-test-loader.mjs";
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith("/daemon/features/runs/thread-routes.js")) return result;
  const source = String(result.source);
  const marker = "/* negative-workflow-search-bypass */";
  if (source.includes(marker)) return result;
  const needle = "const thread = result.threads.find(candidate => candidate.id === match.threadId);";
  assert.equal(source.split(needle).length, 2, "negative control must modify exactly one search gate");
  return { ...result, source: source.replace(needle,
    `${needle}\n${marker}\nif (!isWorkflowExecutionThread(thread)) return true;`) };
}
