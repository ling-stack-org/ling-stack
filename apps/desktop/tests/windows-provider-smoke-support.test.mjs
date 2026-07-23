import assert from "node:assert/strict";
import test from "node:test";
import {
  assertWindowsBundledRuntimeProof,
  parseExactWindowsProviderTarget,
  parseWindowsBundledProviderActivation,
  parseWindowsBundledProviderRuntimeProof,
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

test("Windows smoke accepts only a daemon-ready bundled lease/child projection", () => {
  const activation = parseWindowsBundledProviderActivation({
    plugin: {
      id: "trusted-local:cua-driver",
      setup: {
        distribution: "bundled_embedded",
        providerState: "ready",
      },
    },
    health: {
      status: "ready",
      details: {
        providerState: "ready",
        platform: "win32",
        providerVersion: "0.8.3",
        providerDistributionRevision: "ling.1",
        integrityCoverage: "standard",
        desktopInstanceId: "desktop-fixture",
        desktopInstanceEpoch: 2,
        generation: 3,
        providerSealDigest: "a".repeat(64),
        providerCatalogDigest: "b".repeat(64),
      },
    },
    statusSnapshot: { status: "ready" },
    tools: [bundledTool("list_windows")],
  });

  assert.deepEqual(activation, {
    desktopInstanceId: "desktop-fixture",
    desktopInstanceEpoch: 2,
    generation: 3,
    providerVersion: "0.8.3",
    providerSealDigest: "a".repeat(64),
    providerCatalogDigest: "b".repeat(64),
    toolCount: 1,
    toolIds: ["mcp_cua_driver:list_windows"],
  });
});

test("Windows smoke rejects fake, external, or incomplete bundled activation evidence", () => {
  const ready = {
    plugin: {
      id: "trusted-local:cua-driver",
      setup: {
        distribution: "bundled_embedded",
        providerState: "ready",
      },
    },
    health: {
      status: "ready",
      details: {
        providerState: "ready",
        platform: "win32",
        providerVersion: "0.8.3",
        providerDistributionRevision: "ling.1",
        integrityCoverage: "standard",
        desktopInstanceId: "desktop-fixture",
        desktopInstanceEpoch: 2,
        generation: 3,
        providerSealDigest: "a".repeat(64),
        providerCatalogDigest: "b".repeat(64),
      },
    },
    statusSnapshot: { status: "ready" },
    tools: [bundledTool("list_windows")],
  };
  const cases = [
    ["external projection", (value) => { value.plugin.setup.distribution = "external_local"; }],
    ["not ready", (value) => { value.health.status = "failed"; }],
    ["missing provider seal", (value) => { delete value.health.details.providerSealDigest; }],
    ["missing catalog", (value) => { delete value.health.details.providerCatalogDigest; }],
    ["no tools", (value) => { value.tools = []; }],
    ["wrong tool", (value) => { value.tools = [bundledTool("click")]; }],
    ["duplicate tool", (value) => { value.tools.push(bundledTool("list_windows")); }],
  ];
  for (const [label, mutate] of cases) {
    const value = structuredClone(ready);
    mutate(value);
    assert.throws(
      () => parseWindowsBundledProviderActivation(value),
      /windows_bundled_provider_activation_not_ready/u,
      label,
    );
  }
});

test("Windows smoke binds one structured packaged runtime proof to the daemon activation and exact target", () => {
  const activation = {
    desktopInstanceId: "desktop-fixture",
    desktopInstanceEpoch: 2,
    generation: 3,
    providerSealDigest: "a".repeat(64),
    providerCatalogDigest: "b".repeat(64),
  };
  const output = `noise\nLing Stack Desktop Windows bundled provider runtime ready ${JSON.stringify({
    schemaVersion: 1,
    desktopInstanceId: activation.desktopInstanceId,
    desktopInstanceEpoch: activation.desktopInstanceEpoch,
    generation: activation.generation,
    providerProcessId: 4321,
    executablePath: "C:\\Program Files\\Ling Stack\\resources\\providers\\cua-driver.exe",
    providerChildInstanceNonceSha256: "c".repeat(64),
    lockDigest: "d".repeat(64),
    providerSealDigest: activation.providerSealDigest,
    providerCatalogDigest: activation.providerCatalogDigest,
    target: {
      platform: "windows",
      processId: 8765,
      nativeWindowId: "9988",
    },
  })}\n`;
  const proof = parseWindowsBundledProviderRuntimeProof(output);

  assert.equal(proof.providerProcessId, 4321);
  assert.equal(
    assertWindowsBundledRuntimeProof({
      activation,
      proof,
      target: { processId: 8765, nativeWindowId: "9988" },
      expectedExecutablePath: "c:/program files/ling stack/resources/providers/cua-driver.exe",
    }),
    proof,
  );
});

test("Windows smoke fails closed on malformed, duplicated, or cross-generation runtime proof", () => {
  const line = `Ling Stack Desktop Windows bundled provider runtime ready ${JSON.stringify({
    schemaVersion: 1,
    desktopInstanceId: "desktop-fixture",
    desktopInstanceEpoch: 2,
    generation: 3,
    providerProcessId: 4321,
    executablePath: "C:\\Ling\\cua-driver.exe",
    providerChildInstanceNonceSha256: "c".repeat(64),
    lockDigest: "d".repeat(64),
    providerSealDigest: "a".repeat(64),
    providerCatalogDigest: "b".repeat(64),
    target: { platform: "windows", processId: 8765, nativeWindowId: "9988" },
  })}`;
  assert.throws(
    () => parseWindowsBundledProviderRuntimeProof(`${line}\n${line}\n`),
    /runtime_proof_count_invalid:2/u,
  );
  const proof = parseWindowsBundledProviderRuntimeProof(`${line}\n`);
  assert.throws(
    () => assertWindowsBundledRuntimeProof({
      activation: {
        desktopInstanceId: "desktop-fixture",
        desktopInstanceEpoch: 2,
        generation: 4,
        providerSealDigest: "a".repeat(64),
        providerCatalogDigest: "b".repeat(64),
      },
      proof,
      target: { processId: 8765, nativeWindowId: "9988" },
      expectedExecutablePath: "C:\\Ling\\cua-driver.exe",
    }),
    /runtime_proof_activation_mismatch/u,
  );
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

function bundledTool(rawName) {
  return {
    serverId: "mcp_cua_driver",
    rawName,
    callableNamespace: "mcp_cua_driver",
    callableName: rawName,
    enabled: true,
  };
}
