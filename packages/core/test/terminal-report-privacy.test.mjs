import assert from "node:assert/strict";
import test from "node:test";
import { buildDeterministicTerminalReportContent, validateTerminalReportContent } from "../dist/index.js";
import { buildTerminalReportSnapshot } from "./terminal-report-fixture.mjs";

for (const [name, hostPolicy, modelPolicy] of [
  ["developer to conversation", { visibility: "developer_only" }, { visibility: "conversation" }],
  ["developer to folded", { visibility: "developer_only" }, { visibility: "folded_evidence" }],
  ["folded to conversation", { visibility: "folded_evidence" }, { visibility: "conversation" }],
  ["private to normal", { sensitivity: "private" }, { sensitivity: "normal" }],
  ["private to omitted", { sensitivity: "private" }, { sensitivity: undefined }],
  ["secret to normal", { visibility: "developer_only", sensitivity: "secret_adjacent" }, { visibility: "developer_only", sensitivity: "normal" }],
]) {
  test(`report validation rejects Host privacy downgrade: ${name}`, () => {
    const ref = { kind: "memory", id: "restricted-memory", visibility: "folded_evidence", sensitivity: "normal", ...hostPolicy };
    const snapshot = buildTerminalReportSnapshot({ references: [ref] });
    const content = { ...buildDeterministicTerminalReportContent(snapshot), references: [{ ...ref, ...modelPolicy }] };
    assert.ok(validateTerminalReportContent(content, snapshot).issues.some((issue) => issue.code === "terminal_report_privacy_violation"));
  });
}

test("a public duplicate never overrides a restricted Host ref regardless of order", () => {
  const publicRef = { kind: "memory", id: "shared-id", visibility: "conversation", sensitivity: "normal" };
  const restrictedRef = { ...publicRef, visibility: "developer_only", sensitivity: "private" };
  for (const references of [[publicRef, restrictedRef], [restrictedRef, publicRef]]) {
    const snapshot = buildTerminalReportSnapshot({ references });
    const content = { ...buildDeterministicTerminalReportContent(snapshot), references: [publicRef] };
    assert.ok(validateTerminalReportContent(content, snapshot).issues.some((issue) => issue.code === "terminal_report_privacy_violation"));
  }
});

test("report refs can preserve or increase Host restrictions", () => {
  const ref = { kind: "memory", id: "safe-memory", visibility: "conversation", sensitivity: "normal" };
  const snapshot = buildTerminalReportSnapshot({ references: [ref] });
  for (const modelRef of [ref, { ...ref, visibility: "folded_evidence", sensitivity: "private" }]) {
    const content = { ...buildDeterministicTerminalReportContent(snapshot), references: [modelRef] };
    assert.equal(validateTerminalReportContent(content, snapshot).ok, true);
  }
});

for (const policy of [{ visibility: "developer_only" }, { visibility: "folded_evidence", sensitivity: "secret_adjacent" }]) {
  test(`report validation does not require checks withheld from synthesis: ${JSON.stringify(policy)}`, () => {
    const base = buildTerminalReportSnapshot();
    const checkRef = base.checks[0].sourceRefs.find((ref) => ref.kind === "check");
    const snapshot = buildTerminalReportSnapshot({ references: [...base.references, { ...checkRef, ...policy }] });
    const content = {
      ...buildDeterministicTerminalReportContent(base),
      verification: [],
      references: base.references.filter((ref) => ref.kind !== "check"),
    };
    const before = structuredClone(snapshot);
    assert.equal(validateTerminalReportContent(content, snapshot).ok, true);
    assert.equal(validateTerminalReportContent(content, base).ok, false, "visible checks still require verification");
    assert.ok(validateTerminalReportContent({ ...content, outcome: { ...content.outcome, status: "failed" } }, snapshot)
      .issues.some((issue) => issue.code === "terminal_report_outcome_mismatch"), "privacy does not change the Host terminal state");
    assert.deepEqual(snapshot, before);
  });
}
