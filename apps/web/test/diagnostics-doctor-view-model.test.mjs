import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDiagnosticsBundle,
  projectDiagnosticsDoctor,
  projectLogTailLines,
} from "../src/features/settings/diagnostics-doctor-view-model.ts";

const doctorResponse = {
  doctorVersion: 1,
  cwd: "/tmp/w",
  overallStatus: "warning",
  generatedAt: "2026-10-26T00:00:00.000Z",
  checks: [
    { id: "workspace_store", category: "workspace", status: "ok", summary: "Workspace run store opened" },
    { id: "log_file", category: "logs", status: "warning", summary: "Log not readable", remediation: "Check permissions" },
  ],
};

test("doctor view model maps checks and keeps remediation", () => {
  const view = projectDiagnosticsDoctor(doctorResponse, false, "");
  assert.equal(view.overallStatus, "warning");
  assert.equal(view.checks.length, 2);
  assert.equal(view.checks[1].remediation, "Check permissions");
  assert.equal(view.generatedAt, "2026-10-26T00:00:00.000Z");
});

test("doctor view model reports error state without response", () => {
  const errorView = projectDiagnosticsDoctor(undefined, false, "connection refused");
  assert.equal(errorView.overallStatus, "error");
  assert.equal(errorView.errorMessage, "connection refused");

  const loadingView = projectDiagnosticsDoctor(undefined, true, "");
  assert.equal(loadingView.overallStatus, "loading");
});

test("diagnostics bundle is stable JSON with health, doctor and logs", () => {
  const bundle = JSON.parse(buildDiagnosticsBundle({
    health: { ok: true },
    doctor: doctorResponse,
    logs: { logVersion: 1, logPath: "/tmp/l", truncated: false, lines: ["a"] },
  }));
  assert.equal(bundle.bundleVersion, 1);
  assert.equal(bundle.health.ok, true);
  assert.equal(bundle.doctor.overallStatus, "warning");
  assert.deepEqual(bundle.logs.lines, ["a"]);
  assert.ok(typeof bundle.generatedAt === "string");
});

test("log tail projection is empty for missing response", () => {
  assert.deepEqual(projectLogTailLines(undefined), []);
  assert.deepEqual(projectLogTailLines({ logVersion: 1, logPath: null, truncated: false, lines: ["x"] }), ["x"]);
});
