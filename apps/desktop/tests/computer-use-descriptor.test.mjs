import assert from "node:assert/strict";
import test from "node:test";
import {
  FAKE_COMPUTER_USE_DESCRIPTOR,
  InMemoryComputerUsePreviewDescriptorRegistry,
} from "../dist/main/computer-use/descriptor-registry.js";
import { buildComputerUsePreviewWindowOptions } from "../dist/main/computer-use/window-options.js";
import {
  DaemonComputerUsePreviewDescriptorResolver,
  parseDaemonComputerUsePreviewDescriptor,
} from "../dist/main/computer-use/daemon-descriptor-resolver.js";
import { COMPUTER_USE_PREVIEW_SESSION_PARTITION } from "../dist/main/computer-use/session-partition.js";

test("descriptor registry rejects expiry and revision mismatch", async () => {
  const registry = new InMemoryComputerUsePreviewDescriptorRegistry(() => new Date("2026-07-15T00:00:00.000Z"));
  registry.register(FAKE_COMPUTER_USE_DESCRIPTOR);
  assert.equal((await registry.resolve(FAKE_COMPUTER_USE_DESCRIPTOR.descriptorId, 1)).sourceKind, "fake");
  await assert.rejects(() => registry.resolve(FAKE_COMPUTER_USE_DESCRIPTOR.descriptorId, 2), /revision_mismatch/);

  registry.register({
    ...FAKE_COMPUTER_USE_DESCRIPTOR,
    descriptorId: "expired",
    authorization: { grantId: "grant-expired", expiresAt: "2026-07-14T00:00:00.000Z" },
  });
  await assert.rejects(() => registry.resolve("expired", 1), /descriptor_expired/);
});

test("daemon descriptor resolver keeps the bridge token in the main process request", async () => {
  const requests = [];
  const resolver = new DaemonComputerUsePreviewDescriptorResolver(
    "http://127.0.0.1:17891",
    "/workspace",
    "private-desktop-token",
    () => "session-1",
    async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({
        descriptorId: "opaque-1",
        revision: 4,
        platform: "macos",
        sourceKind: "window",
        target: { processId: 4321, nativeWindowId: "7788" },
        authorization: { grantId: "grant-1", expiresAt: "2099-01-01T00:00:00.000Z" },
      });
    },
  );
  const descriptor = await resolver.resolve("opaque-1", 4);
  assert.equal(descriptor.target.nativeWindowId, "7788");
  assert.match(requests[0].url, /computer-use\/sessions\/session-1\/source\?cwd=%2Fworkspace/);
  assert.equal(requests[0].init.headers["X-Ling-Desktop-Bridge-Token"], "private-desktop-token");
});

test("daemon descriptor resolver returns a fully sanitized runtime-validated descriptor", async () => {
  const resolver = daemonResolverFor({
    descriptorId: "opaque-1",
    revision: 4,
    platform: "windows",
    sourceKind: "display",
    target: {
      applicationId: "com.example.browser",
      processId: 4321,
      nativeWindowId: "7788",
      electronSourceId: "screen:0:0",
      unknownTargetField: "must-not-cross-the-boundary",
    },
    authorization: {
      grantId: "grant-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      bearerToken: "must-not-cross-the-boundary",
    },
    unknownTopLevelField: "must-not-cross-the-boundary",
  });

  assert.deepEqual(await resolver.resolve("opaque-1", 4), {
    descriptorId: "opaque-1",
    revision: 4,
    platform: "windows",
    sourceKind: "display",
    target: {
      applicationId: "com.example.browser",
      processId: 4321,
      nativeWindowId: "7788",
      electronSourceId: "screen:0:0",
    },
    authorization: {
      grantId: "grant-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  });
});

test("daemon descriptor resolver rejects malformed identity and enum fields", async () => {
  const valid = validDaemonDescriptor();
  const invalidDescriptors = [
    { ...valid, descriptorId: " " },
    { ...valid, revision: -1 },
    { ...valid, revision: 1.5 },
    { ...valid, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, platform: "linux" },
    { ...valid, sourceKind: "fake" },
    { ...valid, sourceKind: "browser" },
  ];

  for (const descriptor of invalidDescriptors) {
    await assert.rejects(
      () => daemonResolverFor(descriptor).resolve("opaque-1", 4),
      /computer_use_descriptor_response_invalid/,
    );
  }
});

test("daemon descriptor resolver rejects malformed target fields instead of partially trusting them", async () => {
  const valid = validDaemonDescriptor();
  const invalidTargets = [
    null,
    [],
    {},
    { applicationId: "" },
    { nativeWindowId: " 7788 " },
    { processId: "4321" },
    { processId: 0 },
    { processId: 1.25 },
    { nativeWindowId: " " },
    { electronSourceId: 123 },
  ];

  for (const target of invalidTargets) {
    await assert.rejects(
      () => daemonResolverFor({ ...valid, target }).resolve("opaque-1", 4),
      /computer_use_descriptor_response_invalid/,
    );
  }

  await assert.rejects(
    () => daemonResolverFor({
      ...valid,
      sourceKind: "display",
      target: { nativeWindowId: "7788" },
    }).resolve("opaque-1", 4),
    /computer_use_descriptor_response_invalid/,
  );

  for (const target of [
    { nativeWindowId: "7788" },
    { processId: 4321, nativeWindowId: "0" },
    { processId: 4321, nativeWindowId: "07788" },
    { processId: 4321, electronSourceId: "window:7788:0" },
  ]) {
    await assert.rejects(
      () => daemonResolverFor({
        ...valid,
        platform: "windows",
        sourceKind: "window",
        target,
      }).resolve("opaque-1", 4),
      /computer_use_descriptor_response_invalid/,
    );
  }

  for (const target of [
    { nativeWindowId: "7788" },
    { processId: 4321, nativeWindowId: "0" },
    { processId: 4321, nativeWindowId: "07788" },
    { processId: 4321, nativeWindowId: "4294967296" },
    { processId: 4321, electronSourceId: "window:7788:0" },
  ]) {
    await assert.rejects(
      () => daemonResolverFor({
        ...valid,
        platform: "macos",
        sourceKind: "window",
        target,
      }).resolve("opaque-1", 4),
      /computer_use_descriptor_response_invalid/,
    );
  }
});

test("daemon descriptor resolver accepts a canonical Windows provider HWND and pid", async () => {
  const descriptor = await daemonResolverFor({
    ...validDaemonDescriptor(),
    platform: "windows",
    target: { processId: 4321, nativeWindowId: "7788" },
  }).resolve("opaque-1", 4);
  assert.deepEqual(descriptor.target, { processId: 4321, nativeWindowId: "7788" });
});

test("daemon descriptor resolver accepts a canonical macOS provider window id and pid", async () => {
  const descriptor = await daemonResolverFor({
    ...validDaemonDescriptor(),
    target: { processId: 4321, nativeWindowId: "7788" },
  }).resolve("opaque-1", 4);
  assert.deepEqual(descriptor.target, { processId: 4321, nativeWindowId: "7788" });
});

test("daemon descriptor resolver rejects malformed, non-canonical, and expired authorization", async () => {
  const valid = validDaemonDescriptor();
  const invalidAuthorizations = [
    null,
    [],
    { grantId: "", expiresAt: "2099-01-01T00:00:00.000Z" },
    { grantId: " grant-1 ", expiresAt: "2099-01-01T00:00:00.000Z" },
    { grantId: "grant-1", expiresAt: "not-a-date" },
    { grantId: "grant-1", expiresAt: "2099-01-01" },
  ];

  for (const authorization of invalidAuthorizations) {
    await assert.rejects(
      () => daemonResolverFor({ ...valid, authorization }).resolve("opaque-1", 4),
      /computer_use_descriptor_response_invalid/,
    );
  }

  assert.throws(
    () => parseDaemonComputerUsePreviewDescriptor(
      {
        ...valid,
        authorization: { grantId: "grant-1", expiresAt: "2026-07-14T23:59:59.999Z" },
      },
      new Date("2026-07-15T00:00:00.000Z"),
    ),
    /computer_use_descriptor_response_invalid/,
  );
});

test("daemon descriptor resolver rejects non-object JSON and requested identity mismatches", async () => {
  for (const value of [null, [], "descriptor", 42]) {
    await assert.rejects(
      () => daemonResolverFor(value).resolve("opaque-1", 4),
      /computer_use_descriptor_response_invalid/,
    );
  }

  await assert.rejects(
    () => daemonResolverFor({ ...validDaemonDescriptor(), descriptorId: "opaque-other" }).resolve("opaque-1", 4),
    /computer_use_descriptor_response_mismatch/,
  );
  await assert.rejects(
    () => daemonResolverFor({ ...validDaemonDescriptor(), revision: 5 }).resolve("opaque-1", 4),
    /computer_use_descriptor_response_mismatch/,
  );
});

test("PiP window options keep renderer sandboxed without Node or generic privileges", () => {
  const options = buildComputerUsePreviewWindowOptions({
    bounds: { x: 1, y: 2, width: 420, height: 260 },
    preloadPath: "/safe/preload.cjs",
    partition: "persist:preview-test",
  });
  assert.equal(options.show, false);
  assert.equal(options.alwaysOnTop, true);
  assert.deepEqual(
    [options.minWidth, options.minHeight, options.maxWidth, options.maxHeight],
    [320, 200, 480, 300],
  );
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.backgroundThrottling, false);
  assert.equal(options.webPreferences.partition, "persist:preview-test");
});

test("the default PiP capture session is non-persistent", () => {
  assert.equal(COMPUTER_USE_PREVIEW_SESSION_PARTITION.startsWith("persist:"), false);
});

function validDaemonDescriptor() {
  return {
    descriptorId: "opaque-1",
    revision: 4,
    platform: "macos",
    sourceKind: "window",
    target: { processId: 4321, nativeWindowId: "7788" },
    authorization: { grantId: "grant-1", expiresAt: "2099-01-01T00:00:00.000Z" },
  };
}

function daemonResolverFor(value) {
  return new DaemonComputerUsePreviewDescriptorResolver(
    "http://127.0.0.1:17891",
    "/workspace",
    "private-desktop-token",
    () => "session-1",
    async () => Response.json(value),
  );
}
