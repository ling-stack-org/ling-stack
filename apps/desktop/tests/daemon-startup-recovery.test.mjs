import assert from "node:assert/strict";
import test from "node:test";
import { DesktopDaemonLifecycleError } from "../dist/main/daemon-lifecycle.js";
import { ensureDesktopDaemonWithStartupRecovery } from "../dist/main/daemon-startup-recovery.js";

test("incompatible daemon can be retried without terminating the external service", async () => {
  let ensureCount = 0;
  const prompts = [];
  const result = await ensureDesktopDaemonWithStartupRecovery({
    daemon: {
      async ensureStarted() {
        ensureCount += 1;
        if (ensureCount === 1) {
          throw new DesktopDaemonLifecycleError("bridge_incompatible", "http://127.0.0.1:17891");
        }
        return {
          state: "connected",
          baseUrl: "http://127.0.0.1:17891",
          ownedByDesktop: true,
        };
      },
    },
    allowInteractiveRecovery: true,
    prompt: async (input) => {
      prompts.push(input);
      return "retry";
    },
  });

  assert.equal(result, "connected");
  assert.equal(ensureCount, 2);
  assert.deepEqual(prompts, [{
    baseUrl: "http://127.0.0.1:17891",
    reason: "bridge_incompatible",
    occupant: "ling_daemon",
  }]);
});

test("foreign fixed-port occupant reaches the same retry recovery with structured identity", async () => {
  const prompts = [];
  const result = await ensureDesktopDaemonWithStartupRecovery({
    daemon: {
      async ensureStarted() {
        throw new DesktopDaemonLifecycleError(
          "bridge_incompatible",
          "http://127.0.0.1:17891",
          "foreign_service",
        );
      },
    },
    allowInteractiveRecovery: true,
    prompt: async (input) => {
      prompts.push(input);
      return "quit";
    },
  });

  assert.equal(result, "quit");
  assert.deepEqual(prompts, [{
    baseUrl: "http://127.0.0.1:17891",
    reason: "bridge_incompatible",
    occupant: "foreign_service",
  }]);
});

test("quit leaves an incompatible external daemon untouched", async () => {
  let ensureCount = 0;
  const result = await ensureDesktopDaemonWithStartupRecovery({
    daemon: {
      async ensureStarted() {
        ensureCount += 1;
        throw new DesktopDaemonLifecycleError("bridge_incompatible", "http://127.0.0.1:17891");
      },
    },
    allowInteractiveRecovery: true,
    prompt: async () => "quit",
  });

  assert.equal(result, "quit");
  assert.equal(ensureCount, 1);
});

test("headless startup and unrelated failures remain fail-closed", async () => {
  let promptCount = 0;
  await assert.rejects(
    ensureDesktopDaemonWithStartupRecovery({
      daemon: {
        async ensureStarted() {
          throw new DesktopDaemonLifecycleError("bridge_incompatible", "http://127.0.0.1:17891");
        },
      },
      allowInteractiveRecovery: false,
      prompt: async () => {
        promptCount += 1;
        return "retry";
      },
    }),
    (error) => error instanceof DesktopDaemonLifecycleError && error.code === "bridge_incompatible",
  );
  await assert.rejects(
    ensureDesktopDaemonWithStartupRecovery({
      daemon: {
        async ensureStarted() {
          throw new Error("daemon_entry_missing");
        },
      },
      allowInteractiveRecovery: true,
      prompt: async () => {
        promptCount += 1;
        return "retry";
      },
    }),
    /daemon_entry_missing/,
  );
  assert.equal(promptCount, 0);
});
