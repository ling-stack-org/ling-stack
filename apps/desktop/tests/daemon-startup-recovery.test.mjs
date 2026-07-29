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

test("owned daemon startup failure can open diagnostics and retry without stacking recovery", async () => {
  let ensureCount = 0;
  let diagnosticsCount = 0;
  const prompts = [];
  const decisions = ["open-diagnostics", "retry"];
  const result = await ensureDesktopDaemonWithStartupRecovery({
    daemon: {
      async ensureStarted() {
        ensureCount += 1;
        if (ensureCount === 1) {
          throw new DesktopDaemonLifecycleError("child_exited", "http://127.0.0.1:17891");
        }
        return {
          state: "connected",
          baseUrl: "http://127.0.0.1:17891",
          ownedByDesktop: true,
        };
      },
    },
    allowInteractiveRecovery: true,
    prompt: async () => "quit",
    promptStartupFailure: async (input) => {
      prompts.push(input);
      return decisions.shift();
    },
    openDiagnostics: async () => {
      diagnosticsCount += 1;
    },
  });

  assert.equal(result, "connected");
  assert.equal(ensureCount, 2);
  assert.equal(diagnosticsCount, 1);
  assert.deepEqual(prompts, [
    { baseUrl: "http://127.0.0.1:17891", reason: "child_exited" },
    { baseUrl: "http://127.0.0.1:17891", reason: "child_exited" },
  ]);
});

test("owned daemon startup timeout can quit without another startup attempt", async () => {
  let ensureCount = 0;
  const result = await ensureDesktopDaemonWithStartupRecovery({
    daemon: {
      async ensureStarted() {
        ensureCount += 1;
        throw new DesktopDaemonLifecycleError("start_timeout", "http://127.0.0.1:17891");
      },
    },
    allowInteractiveRecovery: true,
    prompt: async () => "retry",
    promptStartupFailure: async () => "quit",
  });

  assert.equal(result, "quit");
  assert.equal(ensureCount, 1);
});

test("resource and spawn failures use the owned startup recovery instead of incompatible copy", async () => {
  for (const reason of ["resource_missing", "spawn_failed"]) {
    const prompts = [];
    const result = await ensureDesktopDaemonWithStartupRecovery({
      daemon: {
        async ensureStarted() {
          throw new DesktopDaemonLifecycleError(reason, "http://127.0.0.1:17891");
        },
      },
      allowInteractiveRecovery: true,
      prompt: async () => {
        throw new Error("incompatible recovery must not be used");
      },
      promptStartupFailure: async (prompt) => {
        prompts.push(prompt);
        return "quit";
      },
    });

    assert.equal(result, "quit");
    assert.deepEqual(prompts, [{ baseUrl: "http://127.0.0.1:17891", reason }]);
  }
});
