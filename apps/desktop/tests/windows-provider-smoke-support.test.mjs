import assert from "node:assert/strict";
import test from "node:test";
import {
  parseExactWindowsProviderTarget,
  parseWindowsProviderHealthReport,
} from "./windows-provider-smoke-support.mjs";

test("Windows provider smoke selects one exact PID/HWND pair without title or z-order inference", () => {
  const target = parseExactWindowsProviderTarget(JSON.stringify({
    windows: [
      { pid: 41, window_id: 1001, title: "same title" },
      { pid: 42, window_id: 1002, title: "ignored", z_order: 999 },
    ],
  }), 42);

  assert.deepEqual(target, {
    processId: 42,
    nativeWindowId: "1002",
  });
});

test("Windows provider smoke rejects multiple HWNDs owned by the exact target PID", () => {
  assert.throws(
    () => parseExactWindowsProviderTarget(JSON.stringify({
      windows: [
        { pid: 42, window_id: 1001 },
        { pid: 42, window_id: 1002 },
      ],
    }), 42),
    /windows_provider_smoke_target_ambiguous:2/u,
  );
});

test("Windows provider smoke rejects missing, malformed, and unsafe provider identities", () => {
  assert.throws(
    () => parseExactWindowsProviderTarget(JSON.stringify({ windows: [] }), 42),
    /windows_provider_smoke_target_not_found/u,
  );
  assert.throws(
    () => parseExactWindowsProviderTarget(JSON.stringify({
      windows: [{ pid: 42, window_id: Number.MAX_SAFE_INTEGER + 1 }],
    }), 42),
    /windows_provider_smoke_window_id_invalid/u,
  );
  assert.throws(
    () => parseExactWindowsProviderTarget("not json", 42),
    /windows_provider_smoke_list_windows_json_invalid/u,
  );
});

test("Windows provider smoke preserves canonical string HWNDs without numeric coercion", () => {
  const target = parseExactWindowsProviderTarget(JSON.stringify({
    windows: [{ pid: 42, window_id: "18446744073709551615" }],
  }), 42);

  assert.equal(target.nativeWindowId, "18446744073709551615");
});

test("Windows provider smoke accepts only a healthy schema-v1 interactive report", () => {
  const report = parseWindowsProviderHealthReport(JSON.stringify({
    schema_version: "1",
    platform: "win32",
    driver_version: "0.8.3",
    overall: "ok",
    checks: [
      "binary_version",
      "platform_supported",
      "session_active",
      "ax_capability",
      "screen_capture_capability",
    ].map((name) => ({ name, status: "pass", message: "ok" })),
  }));
  assert.equal(report.driverVersion, "0.8.3");
  assert.deepEqual(report.checks.map((check) => check.name), [
    "binary_version",
    "platform_supported",
    "session_active",
    "ax_capability",
    "screen_capture_capability",
  ]);
});

test("Windows provider smoke rejects unreviewed, degraded, and Session-0-like reports", () => {
  const base = {
    schema_version: "1",
    platform: "win32",
    driver_version: "0.8.3",
    overall: "ok",
    checks: [
      "binary_version",
      "platform_supported",
      "session_active",
      "ax_capability",
      "screen_capture_capability",
    ].map((name) => ({ name, status: "pass" })),
  };
  assert.throws(
    () => parseWindowsProviderHealthReport(JSON.stringify({ ...base, driver_version: "0.8.2" })),
    /windows_provider_smoke_health_incompatible/u,
  );
  assert.throws(
    () => parseWindowsProviderHealthReport(JSON.stringify({ ...base, driver_version: "0.8.4" })),
    /windows_provider_smoke_health_incompatible/u,
  );
  assert.throws(
    () => parseWindowsProviderHealthReport(JSON.stringify({
      ...base,
      overall: "degraded",
      checks: base.checks.map((check) => check.name === "ax_capability" ? { ...check, status: "fail" } : check),
    })),
    /windows_provider_smoke_health_incompatible/u,
  );
  assert.throws(
    () => parseWindowsProviderHealthReport(JSON.stringify({
      ...base,
      checks: base.checks.filter((check) => check.name !== "screen_capture_capability"),
    })),
    /windows_provider_smoke_health_capability_failed/u,
  );
});
