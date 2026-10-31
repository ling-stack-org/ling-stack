import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readPackagedQaHarnessSelection } from "../dist/runtime/packaged-qa-harness-bootstrap.js";
import { resolveConfig } from "../dist/config.js";

const selection = () => ({ schemaVersion: 1, kind: "isolated-qa-delegation-selection", modelExecution: "host-authorized-budgeted", workspaceCwd: "/private/tmp/owned-qa/workspace",
  selectedWorkflowIds: ["workflow-qa-explicit"], maxDepth: 2, rootBudget: { tokenBudget: 4096, wallTimeBudgetMs: 60000 } });
const env = (value = selection()) => ({ LING_STACK_PACKAGED_DESKTOP: "1", LING_STACK_PORT: "17928", LING_STACK_HOST: "127.0.0.1",
  LING_STACK_DEFAULT_WORKSPACE_CWD: value.workspaceCwd, LING_STACK_HARNESS_CONTINUATIONS_MODE: "enforce",
  LING_STACK_HARNESS_TOOL_BROKER_MODE: "enforce", LING_STACK_HARNESS_DELEGATIONS_MODE: "enforce",
  LING_STACK_QA_HARNESS_SELECTION: JSON.stringify(value) });

test("ordinary launch has no new selection or model/permission override", () => {
  assert.equal(readPackagedQaHarnessSelection({}), undefined);
  const captured = readPackagedQaHarnessSelection(env());
  assert.ok(Object.isFrozen(captured)); assert.ok(Object.isFrozen(captured.delegations));
  assert.ok(Object.isFrozen(captured.delegations.rootBudget)); assert.ok(Object.isFrozen(captured.delegations.selectedWorkflowIds));
  const resolved = resolveConfig({ harness: captured });
  assert.deepEqual(resolved.harness.delegations.selectedWorkflowIds, ["workflow-qa-explicit"]);
  assert.deepEqual(resolved.harness.delegations.rootBudget, selection().rootBudget);
  assert.equal(resolved.harness.delegations.maxDepth, 2);
  assert.equal(resolved.harness.delegations.mode, "enforce");
  assert.equal(resolved.harness.toolBroker.mode, "enforce");
  assert.equal(captured.evaluations, undefined); assert.equal(captured.sandbox, undefined);
  assert.equal(Object.hasOwn(captured.delegations, "prices"), false);
});

for (const name of ["LING_STACK_PACKAGED_DESKTOP", "LING_STACK_PORT", "LING_STACK_HOST", "LING_STACK_DEFAULT_WORKSPACE_CWD",
  "LING_STACK_HARNESS_CONTINUATIONS_MODE", "LING_STACK_HARNESS_TOOL_BROKER_MODE", "LING_STACK_HARNESS_DELEGATIONS_MODE"]) {
  test(`QA selection fails closed with missing or foreign ${name}`, () => {
    const missing = env(); delete missing[name];
    assert.throws(() => readPackagedQaHarnessSelection(missing), /packaged_qa_harness_selection_invalid/);
    assert.throws(() => readPackagedQaHarnessSelection({ ...env(), [name]: "foreign" }), /packaged_qa_harness_selection_invalid/);
  });
}

for (const [label, value] of [
  ["non-JSON", "{"], ["oversize", " ".repeat(4097)], ["null", "null"], ["array", "[]"],
  ["wildcard", { ...selection(), selectedWorkflowIds: ["*"] }],
  ["duplicate", { ...selection(), selectedWorkflowIds: ["one", "one"] }],
  ["empty", { ...selection(), selectedWorkflowIds: [] }],
  ["too many", { ...selection(), selectedWorkflowIds: Array.from({ length: 101 }, (_, n) => `workflow-${n}`) }],
  ["invalid depth", { ...selection(), maxDepth: 17 }],
  ["unbounded budget", { ...selection(), rootBudget: { tokenBudget: 4096 } }],
  ["zero budget", { ...selection(), rootBudget: { tokenBudget: 0, wallTimeBudgetMs: 1 } }],
  ["non-integral budget", { ...selection(), rootBudget: { tokenBudget: 1.5, wallTimeBudgetMs: 1 } }],
  ["unpriced money", { ...selection(), rootBudget: { ...selection().rootBudget, costBudgetMicros: 1 } }],
  ["permission override", { ...selection(), fullAccess: true }],
  ["missing execution declaration", { ...selection(), modelExecution: undefined }],
  ["synthetic-only execution declaration", { ...selection(), modelExecution: false }],
]) test(`QA bootstrap refuses ${label} rather than accepting a partial selection`, () => {
  assert.throws(() => readPackagedQaHarnessSelection({ ...env(), LING_STACK_QA_HARNESS_SELECTION: typeof value === "string" ? value : JSON.stringify(value) }),
    /packaged_qa_harness_selection_invalid/);
});

test("actual CLI validates QA snapshot before invoking native or skill startup", () => {
  const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const selectionAt = source.indexOf("const qaHarness = readPackagedQaHarnessSelection(process.env)");
  assert.ok(selectionAt > 0 && selectionAt < source.indexOf("? readPackagedRestrictedCommandConfig()"));
  assert.ok(selectionAt < source.indexOf("const officeLocalNativeArtifact = readPackagedOfficeLocalNativeArtifact()"));
  assert.ok(selectionAt < source.indexOf("await preparePackagedGstackStartup()"));
  assert.match(source, /\.\.\.\(qaHarness \? \{ harness: qaHarness \} : \{\}\)/u);
});

test("actual CLI passes the bounded selection to startup and rejects invalid policy before side effects", t => {
  const cwd = mkdtempSync(join(tmpdir(), "ling-qa-cli-bootstrap-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const hook = join(cwd, "probe.mjs"), source = new URL("../src/cli.ts", import.meta.url).href;
  const bootstrap = new URL("../src/runtime/packaged-qa-harness-bootstrap.ts", import.meta.url).href;
  const shutdown = new URL("../src/runtime/signal-shutdown.ts", import.meta.url).href;
  // A composition test of the real CLI, not a launched Daemon/GUI. Replace only
  // its side-effect boundaries; the production QA parser executes unchanged.
  writeFileSync(hook, `import { registerHooks } from 'node:module';
const modules = new Map([
 ['./index.js', "export async function startDaemon(config) { console.log(JSON.stringify({probe:'startup',config})); return {server:{address:()=>({port:17928})},config,stop:async()=>{}}; }"],
 ['./runtime/sandbox/packaged-restricted-command-bootstrap.js', "export function readPackagedRestrictedCommandConfig(){console.log('probe:native');}"],
 ['./runtime/sandbox/packaged-office-native-bootstrap.js', "export function readPackagedOfficeLocalNativeArtifact(){console.log('probe:office');}"],
 ['./features/skills/packaged-startup.js', "export async function preparePackagedGstackStartup(){console.log('probe:skills');}"],
 ['@ling-stack/core/execution-engine-host-authority', "export function writeExecutionEngineHostAuthority(){throw new Error('unexpected fd');}"]
]);
registerHooks({resolve(specifier,context,next){
 if(context.parentURL===${JSON.stringify(source)}) {
  if(specifier==='./runtime/packaged-qa-harness-bootstrap.js') return {shortCircuit:true,url:${JSON.stringify(bootstrap)}};
  if(specifier==='./runtime/signal-shutdown.js') return {shortCircuit:true,url:${JSON.stringify(shutdown)}};
  if(modules.has(specifier)) return {shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(modules.get(specifier))};
 }
 return next(specifier,context);
}});`);
  const run = environment => spawnSync(process.execPath, ["--import", hook, new URL(source).pathname], {
    env: { PATH: process.env.PATH, ...environment }, encoding: "utf8", timeout: 10000,
  });
  const valid = run(env());
  assert.equal(valid.error, undefined); assert.equal(valid.status, 0, valid.stderr);
  const captured = valid.stdout.split("\n").find(line => line.startsWith('{"probe":"startup"'));
  assert.ok(captured, valid.stdout);
  const config = JSON.parse(captured).config;
  assert.equal(config.port, 17928);
  assert.deepEqual(config.harness, readPackagedQaHarnessSelection(env()));
  assert.equal(Object.hasOwn(config, "sandbox"), false);
  const invalid = run({ ...env(), LING_STACK_QA_HARNESS_SELECTION: "{}" });
  assert.equal(invalid.error, undefined); assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /packaged_qa_harness_selection_invalid/);
  assert.equal(invalid.stdout, "", "invalid selection must not enter native, skills or startup");
});
