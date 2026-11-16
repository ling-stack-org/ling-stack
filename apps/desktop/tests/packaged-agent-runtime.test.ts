import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { preparePackagedAgentRuntime } from "../scripts/packaged-agent-runtime.mjs";

const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = resolve(desktopRoot, "../..");

for (const authored of [true, false]) {
test(`bundled ${authored ? "authored" : "compiled"} Code Mode, script Hooks and code intelligence execute without workspace dependencies`, { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-packaged-agent-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceInputs = authored ? {
    loadSource(path: string) {
      return { contents: readFileSync(path, "utf8"), loader: "ts" as const, resolveDir: dirname(path) };
    },
    tsconfigRaw: { compilerOptions: { target: "ES2022" } },
    plugin: { name: "authored-test-inputs", setup() {} },
  } : undefined;
  const resources = await preparePackagedAgentRuntime({ sourceInputs });
  const entry = join(root, "runtime.mjs");
  const directory = authored ? "src" : "dist", extension = authored ? "ts" : "js";
  await build({
    absWorkingDir: desktopRoot,
    stdin: { contents: [
      `export { runBoundedScript } from ${JSON.stringify(resolve(repositoryRoot, `packages/runner-pi/${directory}/script-runtime.${extension}`))};`,
      `export { createHookRuntime } from ${JSON.stringify(resolve(repositoryRoot, `packages/runner-pi/${directory}/hook-runtime.${extension}`))};`,
      `export { executeCodeIntelligence } from ${JSON.stringify(resolve(repositoryRoot, `packages/daemon/${directory}/features/runs/code-intelligence.${extension}`))};`,
    ].join("\n"), resolveDir: desktopRoot, sourcefile: "packaged-agent-runtime-entry.mjs" },
    bundle: true, platform: "node", format: "esm", target: "es2022", outfile: entry,
    plugins: [resources.plugin],
    banner: { js: 'import { createRequire as __lingCreateRequire } from "node:module"; const require = __lingCreateRequire(import.meta.url);' },
    logLevel: "silent",
  });
  resources.assertIncluded();
  await writeFile(join(root, "value.ts"), "export const value: number = 42;\nexport const text = value.toFixed(1);\n");
  await writeFile(join(root, "probe.mjs"), `
    import assert from "node:assert/strict";
    import { runBoundedScript, createHookRuntime, executeCodeIntelligence } from "./runtime.mjs";
    const result = await runBoundedScript({code: "return (await tools.double({value: 21}));", tools: [{
      name: "double", description: "Double a number", inputSchema: {type: "object", properties: {value: {type: "number"}}, required: ["value"]},
      execute: async input => input.value * 2,
    }]});
    assert.equal(result.ok, true); assert.equal(result.value, 42); assert.equal(result.calls.length, 1);
    const hooks = createHookRuntime({cwd: process.cwd(), hooks: {schemaVersion: 1, digest: "sha256:" + "a".repeat(64), hooks: [
      {id: "deny-write", event: "before_tool", kind: "script", code: 'return {decision: "deny", reason: "Read only"};'},
    ]}});
    assert.deepEqual(await hooks({event: "before_tool", toolName: "write", input: {path: "value.ts"}}), {denied: "Read only"});
    const query = async operation => executeCodeIntelligence({root: process.cwd(), request: {
      cwd: process.cwd(), toolCallId: "packaged-query", input: {operation, path: "value.ts", line: 1, column: 14},
    }, assertCurrent() {}});
    const hover = await query("hover"); assert.notEqual(hover.isError, true);
    assert.match(hover.details.items[0].display, /value: number/);
    const diagnostics = await query("diagnostics"); assert.notEqual(diagnostics.isError, true);
    assert.deepEqual(diagnostics.details.items, []);
    const timedOut = await runBoundedScript({code: "for (;;) {}", timeoutMs: 500});
    assert.equal(timedOut.ok, false); assert.equal(timedOut.error.kind, "timeout");
    assert.equal((await runBoundedScript({code: "return 7;"})).value, 7);
    console.log(JSON.stringify({scriptValue: result.value, nestedCalls: result.calls.length, hook: "denied", diagnostics: 0, timeout: "recovered"}));
  `);
  const result = spawnSync(process.execPath, [join(root, "probe.mjs")], {
    cwd: root, encoding: "utf8", timeout: 45_000, env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  assert.deepEqual(JSON.parse(result.stdout.trim()), { scriptValue: 42, nestedCalls: 1, hook: "denied", diagnostics: 0, timeout: "recovered" });
  assert.ok((await readFile(entry)).length > 0);
});
}
