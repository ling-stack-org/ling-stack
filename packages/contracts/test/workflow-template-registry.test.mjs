import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkflowTemplate, workflowTemplateCanonicalJson, WorkflowTemplateValidationError,
  WORKFLOW_TEMPLATE_MAX_STEPS, WORKFLOW_TEMPLATE_MAX_JSON_CHARACTERS } from "../dist/index.js";

const step = (extra = {}) => ({ id: "read", name: "Read", prompt: "Read the evidence", ...extra });
const template = (extra = {}) => ({ schemaVersion: 1, id: "review", name: "Review", steps: [step()], ...extra });
const policy = () => ({ onRunFailed: "block_for_user", onRunCancelled: "cancel_workflow",
  onApprovalDenied: "fail_workflow", retryable: true, maxRetries: 2 });
const gate = () => ({ stage: "pre", approvalProfile: { mode: "strict", risk: "high",
  requiredForTools: ["read"], requiredForActions: ["workflow_step"] }, title: "Review", reason: "Check evidence",
  requiredForStatuses: ["claimed", "succeeded"] });
const invalid = value => assert.throws(() => parseWorkflowTemplate(value), error =>
  error instanceof WorkflowTemplateValidationError && error.code === "workflow_template_invalid");

test("registry template parser copies JSON, defaults auto-start off and never resolves runtime capabilities", () => {
  const input = template({ steps: [step({ teammateId: "not-yet-installed", teammateTemplateId: "runtime-template",
    councilSlotKey: "reviewer", skillId: "missing-skill", providerPresetId: "future-provider", requestedRunnerId: "future-runner",
    branchGroupId: "branches", joinGroupId: "results", dependencyMode: "any_succeeded", autoStart: false,
    policy: policy(), gates: [gate()] })] });
  const before = structuredClone(input), parsed = parseWorkflowTemplate(input);
  assert.deepEqual(parsed, { ...input, autoStartDefault: false });
  assert.deepEqual(input, before);
  parsed.steps[0].policy.maxRetries = 3;
  assert.deepEqual(input, before);
  assert.equal(parseWorkflowTemplate(template({ autoStartDefault: true })).autoStartDefault, true);
  assert.equal(parsed.steps[0].sideEffectClass, undefined, "legacy declarations stay unclassified");
});

test("canonical JSON sorts object keys, normalizes conservative defaults and preserves meaningful array order", () => {
  const input = template({ steps: [step({ sideEffectClass: "analysis_readonly", parallelPolicy: {} })] });
  const reordered = { steps: [{ parallelPolicy: { autoParallel: false }, prompt: "Read the evidence", name: "Read",
    sideEffectClass: "analysis_readonly", id: "read" }], autoStartDefault: false, name: "Review", id: "review", schemaVersion: 1 };
  assert.equal(workflowTemplateCanonicalJson(input), workflowTemplateCanonicalJson(reordered));
  const ordered = template({ steps: [step(), step({ id: "check", dependsOn: ["read"] })] });
  assert.notEqual(workflowTemplateCanonicalJson(ordered), workflowTemplateCanonicalJson({ ...ordered, steps: [...ordered.steps].reverse() }));
  assert.equal(workflowTemplateCanonicalJson(JSON.parse(workflowTemplateCanonicalJson(input))), workflowTemplateCanonicalJson(input));
});

test("registry graphs reject duplicate IDs/dependencies, missing dependencies and all cycles", async t => {
  for (const [name, steps] of [
    ["empty", []], ["duplicate-id", [step(), step()]], ["duplicate-dependency", [step(), step({ id: "next", dependsOn: ["read", "read"] })]],
    ["missing", [step({ dependsOn: ["missing"] })]], ["self", [step({ dependsOn: ["read"] })]],
    ["cycle", [step({ dependsOn: ["next"] }), step({ id: "next", dependsOn: ["read"] })]],
  ]) await t.test(name, () => invalid(template({ steps })));
  const steps = [step({ dependsOn: ["next"] }), step({ id: "next" })];
  assert.deepEqual(parseWorkflowTemplate(template({ steps })).steps, steps, "forward declarations are valid");
});

test("unknown fields are refused at every template, step, safety, policy and gate boundary", async t => {
  for (const [name, input] of [
    ["template", template({ execute: true })], ["step", template({ steps: [step({ script: "run" })] })],
    ["safety", template({ steps: [step({ sideEffectClass: "analysis_readonly", parallelPolicy: { hostGrant: true } })] })],
    ["policy", template({ steps: [step({ policy: { ...policy(), allowAll: true } })] })],
    ["gate", template({ steps: [step({ gates: [{ ...gate(), approved: true }] })] })],
    ["approval", template({ steps: [step({ gates: [{ ...gate(), approvalProfile: { mode: "strict", allowAll: true } }] })] })],
  ]) await t.test(name, () => invalid(input));
});

test("non-JSON values, accessors, toJSON hooks, sparse arrays and symbols are not evaluated", () => {
  let calls = 0;
  const accessor = template();
  Object.defineProperty(accessor, "name", { enumerable: true, get() { calls++; return "Review"; } });
  const toJSON = { ...template(), toJSON() { calls++; return template(); } };
  const symbolic = { ...template(), [Symbol("runtime")]: true };
  const sparse = new Array(1);
  for (const value of [undefined, null, 1, "json", [], new Date(), accessor, toJSON, symbolic,
    template({ description: undefined }), template({ description: NaN }), template({ description: 1n }),
    template({ steps: sparse }), template({ steps: [step({ prompt: () => "run" })] })]) invalid(value);
  assert.equal(calls, 0);
});

test("registry JSON size and 128-step graph bounds are enforced before persistence", () => {
  assert.equal(WORKFLOW_TEMPLATE_MAX_STEPS, 128);
  assert.equal(WORKFLOW_TEMPLATE_MAX_JSON_CHARACTERS, 1_048_576);
  const steps = Array.from({ length: 128 }, (_, i) => step({ id: `step-${i}`, ...(i ? { dependsOn: [`step-${i - 1}`] } : {}) }));
  assert.equal(parseWorkflowTemplate(template({ steps })).steps.length, 128);
  invalid(template({ steps: [...steps, step({ id: "overflow" })] }));
  invalid(template({ steps: Array.from({ length: 17 }, (_, i) => step({ id: `large-${i}`, prompt: "x".repeat(65_536) })) }));
  invalid(template({ steps: [step({ prompt: "x".repeat(65_537) })] }));
  for (const value of ["", " ", "x".repeat(129), " review", "review\0", "review\n"]) invalid(template({ id: value }));
  for (const value of [0, -1, 1.1, 129, "2", null]) invalid(template({ maxParallelSteps: value }));
});

test("safety requests use the existing parser without granting execution or relaxing invalid parallel requests", () => {
  for (const patch of [{ sideEffectClass: "unknown" }, { parallelPolicy: {} },
    { sideEffectClass: "external_mutation", parallelPolicy: { autoParallel: true } },
    { sideEffectClass: "release", parallelPolicy: { autoParallel: true } },
    { sideEffectClass: "test_artifact_only", parallelPolicy: { autoParallel: true } },
    { sideEffectClass: "analysis_readonly", parallelPolicy: { maxParallelSiblings: 129 } },
    { sideEffectClass: "analysis_readonly", parallelPolicy: { resourceKeys: ["port:1", "port:1"] } },
    { sideEffectClass: "analysis_readonly", maxParallelSiblings: 1, parallelPolicy: { maxParallelSiblings: 2 } }])
    invalid(template({ steps: [step(patch)] }));
  for (const sideEffectClass of ["analysis_readonly", "workspace_write", "test_artifact_only"])
    assert.equal(parseWorkflowTemplate(template({ steps: [step({ sideEffectClass,
      parallelPolicy: { autoParallel: true, requiresArtifactOnly: true, resourceKeys: ["port:1"] } })] })).steps[0].sideEffectClass, sideEffectClass);
});

test("policies and approval gates reject malformed values, missing policy fields and invented statuses", () => {
  for (const patch of [{ onRunFailed: "ignore" }, { retryable: "yes" }, { maxRetries: 0 }, { onRunCancelled: undefined }])
    invalid(template({ steps: [step({ policy: { ...policy(), ...patch } })] }));
  for (const patch of [{ stage: "middle" }, { approvalProfile: { mode: "auto" } },
    { approvalProfile: { mode: "strict", risk: "unknown" } }, { approvalProfile: { mode: "strict", requiredForActions: ["exec"] } },
    { approvalProfile: { mode: "strict", requiredForTools: ["read", "read"] } }, { requiredForStatuses: ["ready"] },
    { requiredForStatuses: ["claimed", "claimed"] }, { title: "" }, { reason: "" }])
    invalid(template({ steps: [step({ gates: [{ ...gate(), ...patch }] })] }));
  invalid(template({ steps: [step({ gates: Array.from({ length: 17 }, gate) })] }));
  invalid(template({ autoStartDefault: "false" }));
  invalid(template({ steps: [step({ autoStart: 1 })] }));
});
