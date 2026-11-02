import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "@babel/parser";

function callsIn(ast, name) {
  const calls = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === name) calls.push(node);
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child?.type) visit(child);
    }
  }
  visit(ast);
  return calls;
}

test("scheduler reason codes stay aligned with the public workflow contract", async () => {
  const definitions = [
    ["../src/features/channels/smart-scheduler.ts", "SmartSchedulingReasonCode"],
    ["../../contracts/src/workflows.ts", "ChannelSmartSchedulingReasonCode"],
  ];
  const unions = [];
  for (const [path, name] of definitions) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
    const definition = ast.program.body.map(node => node.declaration ?? node)
      .find(node => node.type === "TSTypeAliasDeclaration" && node.id.name === name);
    assert.ok(definition, name);
    assert.equal(definition.typeAnnotation.type, "TSUnionType");
    unions.push(definition.typeAnnotation.types.map(node => {
      assert.equal(node.type, "TSLiteralType");
      assert.equal(node.literal.type, "StringLiteral");
      return node.literal.value;
    }).sort());
  }
  assert.deepEqual(unions[0], unions[1]);
});

for (const [path, registry, expectedCalls] of [
  ["features/channels/channel-turn-dispatch-executor.ts", "options.runnerRegistry", 2],
  ["features/runs/user-input-workflow-terminal.ts", "options.runnerRegistry", 1],
  ["server/router.ts", "runnerRegistry", 3],
]) {
  test(`${path} wires every workflow orchestration to the real Host capability factory`, async () => {
    const source = await readFile(new URL(`../src/${path}`, import.meta.url), "utf8");
    const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
    const text = node => source.slice(node.start, node.end);
    const calls = callsIn(ast, "orchestrateChannelWorkflow");
    const imports = ast.program.body.filter(node => node.type === "ImportDeclaration");
    assert.equal(calls.length, expectedCalls);
    assert.ok(imports.some(node => node.source.value.endsWith("/workflow-safety.js")
      && node.specifiers.some(element => element.local.name === "createWorkflowParallelCapabilityResolver")));
    for (const call of calls) {
      const argument = call.arguments[0];
      assert.equal(argument.type, "ObjectExpression");
      const property = argument.properties.find(node => node.type === "ObjectProperty"
        && node.key.name === "resolveParallelCapability");
      assert.ok(property, "Every dispatch/continuation must supply Host verification.");
      assert.equal(property.value.type, "CallExpression");
      assert.equal(text(property.value.callee), "createWorkflowParallelCapabilityResolver");
      assert.equal(property.value.arguments.length, 1);
      assert.equal(text(property.value.arguments[0]), registry);
      const runner = argument.properties.find(node => node.type === "ObjectProperty" && node.key.name === "runnerRegistry");
      assert.ok(runner);
      assert.equal(text(runner.value), registry);
    }
  });
}

test("orchestrator forwards the optional runner registry to both preparation paths", async () => {
  const source = await readFile(new URL("../src/features/channels/orchestrator.ts", import.meta.url), "utf8");
  const calls = callsIn(parse(source, { sourceType: "module", plugins: ["typescript"] }), "prepareWorkflowStepStart");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.arguments.length, 7);
    assert.equal(source.slice(call.arguments[6].start, call.arguments[6].end), "input.runnerRegistry");
  }
});

test("direct workflow step start forwards the runner registry through route and preparation", async () => {
  const source = await readFile(new URL("../src/features/channels/workflows.ts", import.meta.url), "utf8");
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const [route] = callsIn(ast, "handleChannelWorkflowStepStart");
  assert.ok(route);
  assert.equal(route.arguments.length, 10);
  assert.equal(source.slice(route.arguments[9].start, route.arguments[9].end), "runnerRegistry");
  const [prepare] = callsIn(ast, "prepareWorkflowStepStart");
  assert.ok(prepare);
  assert.equal(prepare.arguments.length, 7);
  assert.equal(source.slice(prepare.arguments[6].start, prepare.arguments[6].end), "runnerRegistry");
});

test("router forwards the real runner registry for direct start and retry", async () => {
  const source = await readFile(new URL("../src/server/router.ts", import.meta.url), "utf8");
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const [start] = callsIn(ast, "handleChannelWorkflowStepStartRoute");
  assert.ok(start);
  assert.equal(start.arguments.length, 9);
  assert.equal(source.slice(start.arguments[8].start, start.arguments[8].end), "runnerRegistry");
  const [retry] = callsIn(ast, "retryChannelWorkflowStep");
  assert.ok(retry);
  const registry = retry.arguments[0].properties.find(node => node.type === "ObjectProperty" && node.key.name === "runnerRegistry");
  assert.ok(registry);
  assert.equal(source.slice(registry.value.start, registry.value.end), "runnerRegistry");
});
