import assert from "node:assert/strict";
import test from "node:test";
import { DesktopResourceResolutionError } from "../dist/main/resource-paths.js";
import { resolveDesktopResourcesWithStartupRecovery } from "../dist/main/resource-startup-recovery.js";

const resources = {
  webIndexPath: "/app/web/index.html",
  daemonEntryPath: "/app/daemon/cli.mjs",
  previewIndexPath: "/app/preview/index.html",
};

test("missing Desktop resources can open diagnostics and retry without stacking recovery", async () => {
  let resolveCount = 0;
  let diagnosticsCount = 0;
  const prompts = [];
  const decisions = ["open-diagnostics", "retry"];

  const result = await resolveDesktopResourcesWithStartupRecovery({
    resolveResources: async () => {
      resolveCount += 1;
      if (resolveCount === 1) {
        throw new DesktopResourceResolutionError(new Error("ENOENT private path"));
      }
      return resources;
    },
    allowInteractiveRecovery: true,
    prompt: async (prompt) => {
      prompts.push(prompt);
      return decisions.shift();
    },
    openDiagnostics: async () => {
      diagnosticsCount += 1;
    },
  });

  assert.deepEqual(result, resources);
  assert.equal(resolveCount, 2);
  assert.equal(diagnosticsCount, 1);
  assert.deepEqual(prompts, [
    { reason: "resource_missing" },
    { reason: "resource_missing" },
  ]);
});

test("missing resources remain fail-closed in headless startup", async () => {
  let promptCount = 0;
  await assert.rejects(
    resolveDesktopResourcesWithStartupRecovery({
      resolveResources: async () => {
        throw new DesktopResourceResolutionError(new Error("ENOENT"));
      },
      allowInteractiveRecovery: false,
      prompt: async () => {
        promptCount += 1;
        return "retry";
      },
    }),
    (error) => error instanceof DesktopResourceResolutionError,
  );
  assert.equal(promptCount, 0);
});

test("quit returns no resources and does not retry resolution", async () => {
  let resolveCount = 0;
  const result = await resolveDesktopResourcesWithStartupRecovery({
    resolveResources: async () => {
      resolveCount += 1;
      throw new DesktopResourceResolutionError(new Error("ENOENT"));
    },
    allowInteractiveRecovery: true,
    prompt: async () => "quit",
  });

  assert.equal(result, undefined);
  assert.equal(resolveCount, 1);
});
