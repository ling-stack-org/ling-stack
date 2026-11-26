import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { PiRunnerAdapter, type PiRunnerRunOptions } from "@ling-stack/runner-pi";
import { executeCodeIntelligence } from "../dist/features/runs/code-intelligence.js";
import { loadAgentHooks } from "../dist/features/runs/hooks-configuration.js";
import { capturePreparedRunnerInput, restorePreparedRunnerOptions } from "../dist/features/runs/prepared-runner-input.js";

async function fixture(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "ling-code-intelligence-")));
  t.after(() => rm(base, { force: true, recursive: true }));
  const cwd = join(base, "workspace"), userRoot = join(base, "user");
  await mkdir(cwd); await mkdir(userRoot); await mkdir(join(cwd, ".ling"));
  return { base, cwd, userRoot };
}
type Response = { items: Record<string, unknown>[]; snapshot: string; truncated: boolean;
  coverage: { scope: string; files: number; partial: boolean; dependenciesExcluded: boolean } };
async function query(cwd: string, input: Record<string, unknown>, assertCurrent: () => void = () => {}, signal?: AbortSignal): Promise<Response> {
  const result = await executeCodeIntelligence({ root: cwd, request: { toolCallId: "query", cwd, input, signal }, assertCurrent });
  const text = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  assert.equal(result.isError, undefined, text); return JSON.parse(text);
}
function position(source: string, needle: string) {
  const index = source.indexOf(needle); assert.ok(index >= 0);
  const before = source.slice(0, index).split("\n"); return { line: before.length, column: before.at(-1)!.length + 1 };
}

test("TS/JS language service resolves cross-file declarations, references, hover and diagnostics", { timeout: 30_000 }, async t => {
  const { cwd } = await fixture(t);
  const a = 'export function greet(name: string): string { return `Hello ${name}`; }\n';
  const b = 'import { greet } from "./a.js";\nexport const result = greet(42);\n';
  await writeFile(join(cwd, "a.ts"), a); await writeFile(join(cwd, "b.ts"), b);
  const definition = await query(cwd, { operation: "definition", path: "b.ts", ...position(b, "greet(42)") });
  assert.ok(definition.items.some(item => item.path === "a.ts" && item.name === "greet"));
  const references = await query(cwd, { operation: "references", path: "a.ts", ...position(a, "greet") });
  assert.ok(references.items.some(item => item.path === "b.ts"));
  const hover = await query(cwd, { operation: "hover", path: "b.ts", ...position(b, "greet(42)") });
  assert.match(String(hover.items[0].display), /name: string/);
  const diagnostics = await query(cwd, { operation: "diagnostics", path: "b.ts" });
  assert.ok(diagnostics.items.some(item => item.code === 2345), JSON.stringify(diagnostics.items));
  const symbols = await query(cwd, { operation: "symbols", path: "a.ts", query: "greet" });
  assert.ok(symbols.items.some(item => item.name === "greet" && item.line === 1));
  const map = await query(cwd, { operation: "repo_map", path: "." });
  assert.ok(map.items.some(item => item.path === "b.ts" && Array.isArray(item.imports) && item.imports.includes("./a.js")));
  assert.equal(map.coverage.files, 2);
});

test("a subsequent query sees edits and reports the new snapshot without a stale cache", async t => {
  const { cwd } = await fixture(t);
  await writeFile(join(cwd, "a.ts"), "export const value: number = 'bad';\n");
  const before = await query(cwd, { operation: "diagnostics", path: "a.ts" }); assert.ok(before.items.length);
  await writeFile(join(cwd, "a.ts"), "export const value: number = 42;\n");
  const after = await query(cwd, { operation: "diagnostics", path: "a.ts" });
  assert.deepEqual(after.items, []); assert.notEqual(after.snapshot, before.snapshot);
});

test("empty and incomplete sources remain queryable without invented symbols", async t => {
  const { cwd } = await fixture(t);
  await writeFile(join(cwd, "empty.ts"), "");
  await writeFile(join(cwd, "incomplete.ts"), "const =");
  for (const path of ["empty.ts", "incomplete.ts"]) {
    assert.deepEqual((await query(cwd, { operation: "symbols", path })).items, []);
  }
  const map = await query(cwd, { operation: "repo_map", path: "." });
  assert.deepEqual(map.items.map(item => [item.path, item.kind]), [["empty.ts", "file"], ["incomplete.ts", "file"]]);
  assert.equal(map.coverage.partial, false);
  assert.ok((await query(cwd, { operation: "diagnostics", path: "incomplete.ts" })).items.length);
});

test("JavaScript/JSX symbols and explicit scope use the same bounded snapshot", async t => {
  const { cwd } = await fixture(t);
  await mkdir(join(cwd, "src")); await writeFile(join(cwd, "src", "component.jsx"), "export function View() { return <div/>; }\n");
  await writeFile(join(cwd, "outside.ts"), "export const outside = 1;");
  const result = await query(cwd, { operation: "symbols", path: "src/component.jsx" });
  assert.ok(result.items.some(item => item.name === "View")); assert.equal(result.coverage.scope, "src"); assert.equal(result.coverage.files, 1);
});

test("limits and omissions are disclosed without reading private, dependency or linked files", async t => {
  const { base, cwd } = await fixture(t);
  await writeFile(join(cwd, "a.ts"), "export const value = 1;");
  await mkdir(join(cwd, "node_modules")); await writeFile(join(cwd, "node_modules", "secret.ts"), "export const dependencySecret = 1;");
  await writeFile(join(cwd, ".env.ts"), "export const password = 1;");
  await writeFile(join(base, "outside.ts"), "export const externalSecret = 1;");
  await symlink(join(base, "outside.ts"), join(cwd, "linked.ts"));
  await link(join(base, "outside.ts"), join(cwd, "hardlinked.ts"));
  const map = await query(cwd, { operation: "repo_map", path: ".", limit: 1 });
  assert.equal(map.truncated, true); assert.equal(map.coverage.partial, true); assert.equal(map.coverage.files, 1);
  assert.doesNotMatch(JSON.stringify(map), /dependencySecret|externalSecret|password/);
  for (const path of ["linked.ts", "hardlinked.ts", "../outside.ts", "/etc/passwd", ".env.ts", "node_modules/secret.ts"]) {
    const result = await executeCodeIntelligence({ root: cwd, request: { toolCallId: "denied", cwd, input: { operation: "symbols", path } }, assertCurrent: () => {} });
    assert.equal(result.isError, true, path);
  }
});

test("workspace configuration and imports cannot cause out-of-snapshot reads", async t => {
  const { base, cwd } = await fixture(t);
  await writeFile(join(base, "outside.ts"), "export const externalSecret = 1;");
  await writeFile(join(cwd, "tsconfig.json"), JSON.stringify({ extends: "../private.json", compilerOptions: { plugins: [{ name: "malicious" }] } }));
  const source = 'import { externalSecret } from "../outside";\nexport const result = externalSecret;';
  await writeFile(join(cwd, "a.ts"), source);
  const result = await query(cwd, { operation: "definition", path: "a.ts", ...position(source, "externalSecret;") });
  assert.ok(result.items.every(item => item.path === "a.ts")); assert.equal(result.coverage.dependenciesExcluded, true);
  const diagnostics = await query(cwd, { operation: "diagnostics", path: "a.ts" });
  assert.ok(diagnostics.items.some(item => item.code === 2307), "external import stays unresolved inside the snapshot");
});

test("invalid UTF-16 positions, source bounds, cancellation and stale admission are explicit", async t => {
  const { cwd } = await fixture(t);
  await writeFile(join(cwd, "a.ts"), "export const value = 1;\n");
  for (const input of [ { operation: "hover", path: "a.ts", line: 100, column: 1 },
    { operation: "hover", path: "a.ts", line: 1, column: 100 },
    { operation: "symbols", path: "a.ts", scope: "other" }, { operation: "unknown", path: "a.ts" } ]) {
    const result = await executeCodeIntelligence({ root: cwd, request: { toolCallId: "invalid", cwd, input }, assertCurrent: () => {} });
    assert.equal(result.isError, true);
  }
  const controller = new AbortController(); controller.abort(new Error("cancelled-query"));
  await assert.rejects(query(cwd, { operation: "symbols", path: "a.ts" }, () => {}, controller.signal), /cancelled-query/);
  await assert.rejects(query(cwd, { operation: "symbols", path: "a.ts" }, () => { throw new Error("stale-fence"); }), /stale-fence/);
});

test("file budget reports a partial index and prioritizes the requested source", async t => {
  const { cwd } = await fixture(t);
  await Promise.all(Array.from({ length: 258 }, (_, i) => writeFile(join(cwd, `${i}.ts`), `export const symbol${i} = ${i};`)));
  const result = await query(cwd, { operation: "symbols", path: "257.ts" });
  assert.equal(result.coverage.files, 256); assert.equal(result.coverage.partial, true);
  assert.ok(result.items.some(item => item.name === "symbol257"));
});

test("project Hooks require an external user pin and changing their bytes revokes trust", async t => {
  const { cwd, userRoot } = await fixture(t);
  const project = JSON.stringify({ schemaVersion: 1, hooks: [{ id: "project-guard", event: "before_tool", tools: ["write"], kind: "script", code: 'return {decision:"deny"};' }] });
  const projectPath = join(cwd, ".ling", "hooks.json"); await writeFile(projectPath, project);
  assert.equal(await loadAgentHooks({ cwd, userRoot }), undefined);
  const user = { schemaVersion: 1, hooks: [], trustedProjects: [] as { root: string; digest: string }[] };
  await writeFile(join(userRoot, "hooks.json"), JSON.stringify(user));
  assert.deepEqual((await loadAgentHooks({ cwd, userRoot }))?.hooks, []);
  user.trustedProjects.push({ root: cwd, digest: `sha256:${createHash("sha256").update(project).digest("hex")}` });
  await writeFile(join(userRoot, "hooks.json"), JSON.stringify(user));
  const trusted = await loadAgentHooks({ cwd, userRoot }); assert.equal(trusted?.hooks[0].id, "project-guard");
  await writeFile(projectPath, project + " ");
  await assert.rejects(loadAgentHooks({ cwd, userRoot }), /hooks_project_trust_changed/);
});

test("a trusted workspace without a project Hooks directory uses the pinned empty configuration", async t => {
  const { cwd, userRoot } = await fixture(t);
  await rm(join(cwd, ".ling"), { recursive: true, force: true });
  const emptyDigest = createHash("sha256").update("").digest("hex");
  await writeFile(join(userRoot, "hooks.json"), JSON.stringify({ schemaVersion: 1, hooks: [],
    trustedProjects: [{ root: cwd, digest: `sha256:${emptyDigest}` }] }));
  assert.deepEqual((await loadAgentHooks({ cwd, userRoot }))?.hooks, []);
});

test("unsafe user configuration, invalid definitions and duplicate ids fail closed", async t => {
  const { cwd, userRoot } = await fixture(t);
  const path = join(userRoot, "hooks.json");
  await writeFile(path, JSON.stringify({ schemaVersion: 1, hooks: [] })); await chmod(path, 0o666);
  await assert.rejects(loadAgentHooks({ cwd, userRoot }), /hooks_configuration_unsafe/); await chmod(path, 0o600);
  for (const hooks of [[{ id: "wild", event: "before_tool", kind: "command", command: "x", tools: [".*"] }],
    [{ id: "both", event: "run_start", kind: "script", code: "return 1", command: "x" }],
    [{ id: "slow", event: "run_start", kind: "command", command: "x", timeoutMs: 999999 }]]) {
    await writeFile(path, JSON.stringify({ schemaVersion: 1, hooks })); await assert.rejects(loadAgentHooks({ cwd, userRoot }));
  }
});

test("prepared execution rejects capability revocation and Hook configuration drift", async t => {
  const { cwd } = await fixture(t);
  const runner = new PiRunnerAdapter();
  const options: PiRunnerRunOptions = { cwd, task: { id: "task", title: "test", prompt: "test" }, tools: ["read"],
    provider: { provider: "prepared-capabilities", model: "test", api: "openai-completions", baseUrl: "https://fixture.invalid/v1", reasoning: false },
    initialToolSurface: { mediaGeneration: false, toolHydration: false, codeMode: true, codeIntelligence: true },
    hooks: { schemaVersion: 1, digest: `sha256:${"a".repeat(64)}`, hooks: [] } };
  const preparedInput = await runner.prepareTaskInput(options);
  const payload = capturePreparedRunnerInput({ runnerId: "pi", options, preparedInput });
  assert.equal(restorePreparedRunnerOptions(payload, options).hooks?.digest, options.hooks?.digest);
  assert.throws(() => restorePreparedRunnerOptions(payload, { ...options, hooks: undefined }), /configuration or trust changed/);
  assert.throws(() => restorePreparedRunnerOptions(payload, { ...options, initialToolSurface: { ...options.initialToolSurface!, codeMode: false } }), /capabilities changed/);
});

test("restoring a prepared execution without a tool surface preserves its original SDK input", async t => {
  const { cwd } = await fixture(t);
  const runner = new PiRunnerAdapter();
  const options: PiRunnerRunOptions = { cwd, task: { id: "task", title: "test", prompt: "test" }, tools: ["read"],
    provider: { provider: "prepared-capabilities", model: "test", api: "openai-completions", baseUrl: "https://fixture.invalid/v1", reasoning: false } };
  const preparedInput = await runner.prepareTaskInput(options);
  const payload = capturePreparedRunnerInput({ runnerId: "pi", options, preparedInput });
  assert.equal(Object.hasOwn(payload.input, "initialToolSurface"), false);
  const restored = restorePreparedRunnerOptions(payload, { ...options,
    initialToolSurface: { mediaGeneration: false, toolHydration: false, codeMode: true, codeIntelligence: true } });
  assert.equal(restored.initialToolSurface, undefined);
  const reproduced = await runner.prepareTaskInput(restored);
  assert.deepEqual(reproduced.tools, preparedInput.tools);
  assert.equal(reproduced.fingerprint, preparedInput.fingerprint);
});

test("prepared isolated files accept explicitly disabled visualization and coordination tools", async t => {
  const { cwd } = await fixture(t);
  const runner = new PiRunnerAdapter();
  const options: PiRunnerRunOptions = { cwd, task: { id: "isolated", title: "Read the contract", prompt: "Read only." }, tools: ["read"],
    provider: { provider: "prepared-capabilities", model: "test", api: "openai-completions", baseUrl: "https://fixture.invalid/v1", reasoning: false },
    isolatedToolsProfile: "host_isolated_files_v1", onToolBefore: () => ({ allowed: true }), onIsolatedToolCall: () => ({ content: [] }),
    initialToolSurface: { mediaGeneration: false, toolHydration: false, conversationVisualization: false, workItemCoordination: false },
  };
  const preparedInput = await runner.prepareTaskInput(options);
  const payload = capturePreparedRunnerInput({ runnerId: "pi", options, preparedInput });
  const restored = restorePreparedRunnerOptions(payload, options);
  assert.deepEqual(restored.initialToolSurface, options.initialToolSurface);
  assert.deepEqual((await runner.prepareTaskInput(restored)).tools.map(tool => tool.name), ["read"]);
  for (const capability of ["conversationVisualization", "workItemCoordination"] as const) {
    const widened = { ...options, initialToolSurface: { ...options.initialToolSurface!, [capability]: true } };
    assert.throws(() => restorePreparedRunnerOptions(payload, widened), { code: "workflow_safety_mismatch" });
  }
});
