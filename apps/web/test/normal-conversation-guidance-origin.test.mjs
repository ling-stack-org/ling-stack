import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const requireDesktop = createRequire(new URL("../../desktop/package.json", import.meta.url));
const { build } = requireDesktop("esbuild");

test("normal queued guidance sends lexical origins instead of promoting them to file requests", async t => {
  const hook = `guidance-origin:${crypto.randomUUID()}`;
  const entries = new Map(), calls = [];
  const previousWindow = globalThis.window;
  globalThis.window = { localStorage: { getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) } };
  globalThis[hook] = async (cwd, sourceId, request) => {
    calls.push(request);
    return { cwd, intervention: { id: "accepted", sourceRunId: sourceId,
      mode: request.mode, idempotencyKey: request.idempotencyKey, messagePayload: request.messagePayload } };
  };
  t.after(() => { delete globalThis[hook];
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("../src/features/workspace/normal-conversation-guidance.ts", import.meta.url))],
    bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
    plugins: [{ name: "guidance-network-port", setup(builder) {
      builder.onResolve({ filter: /\/api\.js$/ }, () => ({ path: "api", namespace: "guidance-test" }));
      builder.onLoad({ filter: /.*/, namespace: "guidance-test" }, () => ({ contents:
        `export const createRunIntervention = (...args) => globalThis[${JSON.stringify(hook)}](...args);
         export const listRunInterventions = () => { throw new Error("Unexpected receipt lookup"); };` }));
    } }] });
  const { queueNormalConversationGuidance } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
  const fileRefs = ["inferred_text", "composer", "explicit_text", "api"].map(source => ({ path: `${source}/file.txt`, source }));
  await queueNormalConversationGuidance({ cwd: "/qa-workspace", threadId: "qa-thread",
    sourceReply: { sourceRunId: "qa-run" }, draft: { body: "Explain paths, do not load them", attachments: [], fileRefs },
    onSubmitting() {}, notReadyMessage: "Not ready" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].messagePayload.fileRefs.map(({ path, source }) => ({ path, source })), fileRefs);
  assert.equal(entries.size, 0);
});
