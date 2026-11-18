import assert from "node:assert/strict";
import test from "node:test";
import { describeLockedUseAction } from "../dist/main/locked-computer-control/action-target.js";

test("protected calls expose only the explicit process and window to the privileged gate", () => {
  assert.deepEqual(describeLockedUseAction({ toolName: "type_text", arguments: {
    pid: 321, window_id: 1, text: "private input", delivery_mode: "background", scope: "window",
  } }), { toolName: "type_text", processID: 321, windowID: 1 });
  assert.deepEqual(describeLockedUseAction({ toolName: "get_window_state", arguments: {
    pid: 2_147_483_647, window_id: 4_294_967_295,
  } }), { toolName: "get_window_state", processID: 2_147_483_647, windowID: 4_294_967_295 });
  assert.deepEqual(describeLockedUseAction({ toolName: "list_windows", arguments: { pid: 2 } }),
    { toolName: "list_windows", processID: 2 });
  assert.deepEqual(describeLockedUseAction({ toolName: "get_accessibility_tree" }),
    { toolName: "get_accessibility_tree" });
});

test("unbound targets, desktop capture and alternate target routing fail closed", () => {
  for (const call of [
    { toolName: "click" },
    ...[0, 1, -1, 1.5, "321", 2_147_483_648].map((pid) => ({ toolName: "click", arguments: { pid } })),
    ...[0, -1, 1.5, "1", 4_294_967_296].map((window_id) => ({ toolName: "click", arguments: { pid: 321, window_id } })),
    ...["capture", "get_desktop_state", "drag", "move_cursor", "future_tool"].map((toolName) =>
      ({ toolName, arguments: { pid: 321, window_id: 1 } })),
    ...[{ foreground: true }, { delivery_mode: "foreground" }, { scope: "desktop" },
      { capture_scope: "desktop" }, { element_token: "s0001:1" }, { cdp_port: 9222 },
      { target_url_contains: "another-window" }].map((fields) => ({ toolName: "click", arguments: { pid: 321, ...fields } })),
    { toolName: "get_window_state", arguments: { pid: 321 } },
    { toolName: "list_apps", arguments: { pid: 321 } },
    { toolName: "click", arguments: [] },
  ]) assert.throws(() => describeLockedUseAction(call), /locked_control_secure_surface/u);
});
