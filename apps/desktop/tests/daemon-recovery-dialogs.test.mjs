import assert from "node:assert/strict";
import test from "node:test";
import {
  showIncompatibleDaemonRecoveryDialog,
  showOwnedDaemonStartupFailureDialog,
} from "../dist/main/daemon-recovery-dialogs.js";

test("incompatible daemon dialog preserves external-service safety copy", async () => {
  const options = [];
  const decision = await showIncompatibleDaemonRecoveryDialog({
    locale: "en-US",
    prompt: {
      baseUrl: "http://127.0.0.1:17891",
      reason: "bridge_incompatible",
      occupant: "foreign_service",
    },
    showMessageBox: async (value) => {
      options.push(value);
      return { response: 0, checkboxChecked: false };
    },
  });

  assert.equal(decision, "retry");
  assert.equal(options[0].cancelId, 1);
  assert.match(options[0].detail, /will not terminate a service it did not start/u);
});

test("owned daemon failure dialog distinguishes timeout and exposes diagnostics", async () => {
  const options = [];
  const decision = await showOwnedDaemonStartupFailureDialog({
    locale: "zh-CN",
    prompt: { baseUrl: "http://127.0.0.1:17891", reason: "start_timeout" },
    showMessageBox: async (value) => {
      options.push(value);
      return { response: 1, checkboxChecked: false };
    },
  });

  assert.equal(decision, "open-diagnostics");
  assert.deepEqual(options[0].buttons, ["重试", "打开诊断", "退出"]);
  assert.equal(options[0].cancelId, 2);
  assert.match(options[0].detail, /启动超时/u);
  assert.doesNotMatch(options[0].detail, /另一个 Ling daemon/u);
});

test("resource and spawn failures use product copy without private paths or process arguments", async () => {
  for (const reason of ["resource_missing", "spawn_failed"]) {
    const options = [];
    const decision = await showOwnedDaemonStartupFailureDialog({
      locale: "en-US",
      prompt: { reason },
      showMessageBox: async (value) => {
        options.push(value);
        return { response: 2, checkboxChecked: false };
      },
    });

    assert.equal(decision, "quit");
    assert.match(options[0].detail, reason === "resource_missing" ? /installation files/u : /could not launch/u);
    assert.doesNotMatch(options[0].detail, /ENOENT|EACCES|--|\/private\//u);
    assert.deepEqual(options[0].buttons, ["Retry", "Open diagnostics", "Quit"]);
  }
});
