import assert from "node:assert/strict";
import test from "node:test";
import {
  providerResultOwnsTarget,
  validateProviderTargetOwnership,
  windowsProviderResultOwnsTarget,
} from "../dist/features/computer-use/windows-target-validation.js";

test("Windows provider target ownership requires one exact HWND and PID pair", () => {
  const result = providerResult([
    { pid: 4321, window_id: "7788" },
    { pid: 9999, window_id: "8899" },
  ]);
  assert.equal(windowsProviderResultOwnsTarget(result, 4321, "7788"), true);
  assert.equal(windowsProviderResultOwnsTarget(result, 9999, "7788"), false);
  assert.equal(windowsProviderResultOwnsTarget(result, 4321, "8899"), false);
});

test("Windows provider target ownership rejects reused or ambiguous HWNDs", () => {
  assert.equal(
    windowsProviderResultOwnsTarget(
      providerResult([{ pid: 9999, window_id: "7788" }]),
      4321,
      "7788",
    ),
    false,
  );
  assert.equal(
    windowsProviderResultOwnsTarget(
      providerResult([
        { pid: 4321, window_id: "7788" },
        { pid: 4321, window_id: "7788" },
      ]),
      4321,
      "7788",
    ),
    false,
  );
});

test("macOS provider target ownership requires the exact CGWindowID and PID pair", () => {
  const result = providerResult([
    { pid: 4321, window_id: 7788 },
    { pid: 9999, window_id: 8899 },
  ]);
  assert.equal(providerResultOwnsTarget(result, "macos", 4321, "7788"), true);
  assert.equal(providerResultOwnsTarget(result, "macos", 9999, "7788"), false);
  assert.equal(providerResultOwnsTarget(result, "macos", 4321, "4294967296"), false);
});

test("provider target ownership rejects a successful result that races with cancellation", async () => {
  const controller = new AbortController();
  await assert.rejects(
    validateProviderTargetOwnership({
      platform: "macos",
      server: {
        id: "mcp_cua_driver",
        displayName: "Cua Driver",
        enabled: true,
        required: false,
        enabledTools: ["list_windows"],
        transport: { type: "stdio", command: "cua-driver", args: [] },
      },
      mcpBroker: {
        async callTool() {
          controller.abort(new Error("client disconnected as provider returned"));
          return providerResult([{ pid: 4321, window_id: 7788 }]);
        },
      },
      secretResolver: { resolve: () => ({ configured: true, value: "unused" }) },
      processId: 4321,
      nativeWindowId: "7788",
      now: "2026-07-17T00:00:00.000Z",
      signal: controller.signal,
    }),
    /client disconnected as provider returned/,
  );
});

test("provider target ownership discards a result after its provider authority changes", async () => {
  let postchecks = 0;
  const owned = await validateProviderTargetOwnership({
    platform: "macos",
    server: {
      id: "mcp_cua_driver",
      displayName: "Cua Driver",
      enabled: true,
      required: false,
      enabledTools: ["list_windows"],
      transport: { type: "stdio", command: "cua-driver", args: [] },
    },
    mcpBroker: {
      async callTool() {
        return providerResult([{ pid: 4321, window_id: 7788 }]);
      },
    },
    secretResolver: { resolve: () => ({ configured: true, value: "unused" }) },
    processId: 4321,
    nativeWindowId: "7788",
    now: "2026-07-17T00:00:00.000Z",
    assertResultCurrent: () => {
      postchecks += 1;
      throw new Error("computer_use_provider_authority_stale");
    },
  });

  assert.equal(owned, false);
  assert.equal(postchecks, 1);
});

function providerResult(windows) {
  return {
    content: [],
    details: { structuredContent: { windows } },
  };
}
