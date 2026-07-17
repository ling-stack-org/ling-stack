import assert from "node:assert/strict";
import test from "node:test";
import {
  ComputerUseDisplayMediaGrantStore,
  createSafeComputerUseDisplayMediaResponder,
} from "../dist/main/computer-use/display-media-grant.js";
import { COMPUTER_USE_PREVIEW_SESSION_PARTITION } from "../dist/main/computer-use/session-partition.js";
import { buildComputerUsePreviewWindowOptions } from "../dist/main/computer-use/window-options.js";

const expectedFrameUrl = "file:///Applications/Ling%20Stack/resources/preview/index.html";
const request = {
  webContentsId: 42,
  frameToken: "frame-token-42",
  frameTreeNodeId: 420,
  frameProcessId: 24,
  frameRoutingId: 7,
  isMainFrame: true,
  frameActive: true,
  requesterIdentityCurrent: true,
  requesterUsesCaptureSession: true,
  videoRequested: true,
  audioRequested: false,
  securityOrigin: "file:///",
  frameOrigin: "file://",
  frameUrl: expectedFrameUrl,
};

test("display-media grant is bound to the exact PiP main frame and consumed once", () => {
  const grants = new ComputerUseDisplayMediaGrantStore();
  const attempt = grants.beginAttempt();
  assert.equal(grants.issueIfCurrent(attempt, {
    source: {
      type: "window",
      target: { electronSourceId: "window:123:0", nativeWindowId: "123" },
    },
    sessionId: "session-1",
    descriptorId: "descriptor-1",
    revision: 4,
    authorizationGrantId: "grant-1",
    authorizationExpiresAt: "2099-01-01T00:00:00.000Z",
    requesterWebContentsId: 42,
    expectedFrameToken: "frame-token-42",
    expectedFrameTreeNodeId: 420,
    expectedFrameProcessId: 24,
    expectedFrameRoutingId: 7,
    expectedFrameUrl,
  }), true);

  assert.equal(grants.consume({ ...request, webContentsId: 7 }), undefined);
  assert.equal(grants.consume({ ...request, isMainFrame: false }), undefined);
  assert.equal(grants.consume({ ...request, frameActive: false }), undefined);
  assert.equal(grants.consume({ ...request, requesterIdentityCurrent: false }), undefined);
  assert.equal(grants.consume({ ...request, requesterUsesCaptureSession: false }), undefined);
  assert.equal(grants.consume({ ...request, videoRequested: false }), undefined);
  assert.equal(grants.consume({ ...request, audioRequested: true }), undefined);
  assert.equal(grants.consume({ ...request, frameOrigin: "null" }), undefined);
  assert.equal(grants.consume({ ...request, securityOrigin: "http://127.0.0.1:17891" }), undefined);
  assert.equal(grants.consume({ ...request, frameUrl: "file:///tmp/other.html" }), undefined);

  assert.deepEqual(grants.consume(request), {
    generation: 1,
    source: {
      type: "window",
      target: { electronSourceId: "window:123:0", nativeWindowId: "123" },
    },
    sessionId: "session-1",
    descriptorId: "descriptor-1",
    revision: 4,
    authorizationGrantId: "grant-1",
  });
  assert.equal(grants.consume(request), undefined);
});

test("display-media provenance negative matrix rejects every non-exact requester", () => {
  const negativeCases = [
    ["missing webContents", { webContentsId: undefined }],
    ["foreign webContents", { webContentsId: 7 }],
    ["replacement frame token", { frameToken: "frame-token-replaced" }],
    ["replacement frame tree node", { frameTreeNodeId: 421 }],
    ["replacement renderer process", { frameProcessId: 25 }],
    ["replacement frame routing id", { frameRoutingId: 8 }],
    ["subframe", { isMainFrame: false }],
    ["detached frame", { frameActive: false }],
    ["navigated or replaced requester identity", { requesterIdentityCurrent: false }],
    ["wrong Session partition", { requesterUsesCaptureSession: false }],
    ["audio-only request", { videoRequested: false, audioRequested: true }],
    ["audio plus video request", { audioRequested: true }],
    ["wrong security origin", { securityOrigin: "https://attacker.invalid" }],
    ["wrong frame origin", { frameOrigin: "null" }],
    ["wrong frame URL", { frameUrl: "file:///tmp/other.html" }],
    ["same path with an unexpected query", { frameUrl: `${expectedFrameUrl}?capture=other` }],
    ["malformed frame URL", { frameUrl: "not a URL" }],
  ];

  for (const [label, overrides] of negativeCases) {
    const grants = new ComputerUseDisplayMediaGrantStore();
    issueGrant(grants);
    assert.equal(grants.consume({ ...request, ...overrides }), undefined, label);
    assert.deepEqual(
      grants.consume(request),
      expectedConsumedGrant(),
      `${label} must not consume the exact requester's one-shot grant`,
    );
  }
});

test("navigation before capture cannot reuse a grant from the previous document URL", () => {
  const grants = new ComputerUseDisplayMediaGrantStore();
  issueGrant(grants);

  assert.equal(grants.consume({
    ...request,
    frameUrl: "file:///Applications/Ling%20Stack/resources/preview/navigated.html",
  }), undefined);
  assert.deepEqual(grants.consume(request), expectedConsumedGrant());
});

test("the preview window and display-media handler share a dedicated non-persistent partition", () => {
  const options = buildComputerUsePreviewWindowOptions({
    bounds: { x: 1, y: 2, width: 420, height: 260 },
    preloadPath: "/safe/computer-use-preview.cjs",
    partition: COMPUTER_USE_PREVIEW_SESSION_PARTITION,
  });

  assert.equal(COMPUTER_USE_PREVIEW_SESSION_PARTITION.startsWith("persist:"), false);
  assert.equal(options.webPreferences.partition, COMPUTER_USE_PREVIEW_SESSION_PARTITION);
  assert.notEqual(options.webPreferences.partition, "persist:ling-main-window");
});

test("invalidating a grant makes an in-flight source resolution stale", () => {
  const grants = new ComputerUseDisplayMediaGrantStore();
  const generation = grants.beginAttempt();
  assert.equal(grants.issueIfCurrent(generation, {
    source: { type: "screen", target: { electronSourceId: "screen:0:0" } },
    sessionId: "session-1",
    descriptorId: "descriptor-1",
    revision: 1,
    authorizationGrantId: "grant-1",
    authorizationExpiresAt: "2099-01-01T00:00:00.000Z",
    requesterWebContentsId: 42,
    expectedFrameToken: "frame-token-42",
    expectedFrameTreeNodeId: 420,
    expectedFrameProcessId: 24,
    expectedFrameRoutingId: 7,
    expectedFrameUrl,
  }), true);
  const consumed = grants.consume(request);
  assert.equal(consumed?.generation, generation);
  assert.equal(grants.isCurrent(generation), true);

  grants.invalidate();
  assert.equal(grants.isCurrent(generation), false);
});

test("a newer prepare or release prevents an older async prepare from rearming a grant", () => {
  const grants = new ComputerUseDisplayMediaGrantStore();
  const oldAttempt = grants.beginAttempt();
  const newAttempt = grants.beginAttempt();
  assert.equal(grants.issueIfCurrent(oldAttempt, {
    source: { type: "window", target: { electronSourceId: "window:old:0" } },
    sessionId: "session-1",
    descriptorId: "descriptor-old",
    revision: 1,
    authorizationGrantId: "grant-old",
    authorizationExpiresAt: "2099-01-01T00:00:00.000Z",
    requesterWebContentsId: 42,
    expectedFrameToken: "frame-token-42",
    expectedFrameTreeNodeId: 420,
    expectedFrameProcessId: 24,
    expectedFrameRoutingId: 7,
    expectedFrameUrl,
  }), false);
  assert.equal(grants.issueIfCurrent(newAttempt, {
    source: { type: "window", target: { electronSourceId: "window:new:0" } },
    sessionId: "session-1",
    descriptorId: "descriptor-new",
    revision: 2,
    authorizationGrantId: "grant-new",
    authorizationExpiresAt: "2099-01-01T00:00:00.000Z",
    requesterWebContentsId: 42,
    expectedFrameToken: "frame-token-42",
    expectedFrameTreeNodeId: 420,
    expectedFrameProcessId: 24,
    expectedFrameRoutingId: 7,
    expectedFrameUrl,
  }), true);
  grants.invalidate();
  assert.equal(grants.consume(request), undefined);
});

test("expired grants fail closed", () => {
  const grants = new ComputerUseDisplayMediaGrantStore();
  const attempt = grants.beginAttempt();
  assert.equal(grants.issueIfCurrent(attempt, {
    source: {
      type: "window",
      target: { electronSourceId: "window:123:0", nativeWindowId: "123" },
    },
    sessionId: "session-1",
    descriptorId: "descriptor-1",
    revision: 1,
    authorizationGrantId: "grant-1",
    authorizationExpiresAt: "2026-07-15T00:00:01.000Z",
    requesterWebContentsId: 42,
    expectedFrameToken: "frame-token-42",
    expectedFrameTreeNodeId: 420,
    expectedFrameProcessId: 24,
    expectedFrameRoutingId: 7,
    expectedFrameUrl,
  }), true);
  assert.equal(grants.consume(request, new Date("2026-07-15T00:00:02.000Z")), undefined);
});

test("an expired grant is cleared permanently and malformed expiry is never issued", () => {
  const grants = new ComputerUseDisplayMediaGrantStore();
  issueGrant(grants, { authorizationExpiresAt: "2026-07-16T12:00:00.000Z" });

  assert.equal(grants.consume(request, new Date("2026-07-16T12:00:00.000Z")), undefined);
  assert.equal(
    grants.consume(request, new Date("2026-07-16T11:59:59.999Z")),
    undefined,
    "an expired capability must not revive if a caller later supplies an older clock value",
  );

  const invalidAttempt = grants.beginAttempt();
  assert.equal(grants.issueIfCurrent(invalidAttempt, grantInput({
    authorizationExpiresAt: "not-a-date",
  })), false);
  assert.equal(grants.consume(request), undefined);
});

test("release and disposal interruption invalidate issued and consumed generations", () => {
  for (const lifecycleEvent of ["release", "dispose"]) {
    const issuedGrants = new ComputerUseDisplayMediaGrantStore();
    const issuedGeneration = issueGrant(issuedGrants);
    issuedGrants.invalidate();
    assert.equal(issuedGrants.isCurrent(issuedGeneration), false, lifecycleEvent);
    assert.equal(issuedGrants.consume(request), undefined, lifecycleEvent);
    assert.equal(
      issuedGrants.issueIfCurrent(issuedGeneration, grantInput()),
      false,
      `${lifecycleEvent} must prevent a late prepare from rearming the grant`,
    );

    const consumedGrants = new ComputerUseDisplayMediaGrantStore();
    const consumedGeneration = issueGrant(consumedGrants);
    assert.deepEqual(consumedGrants.consume(request), expectedConsumedGrant(consumedGeneration));
    consumedGrants.invalidate();
    assert.equal(
      consumedGrants.isCurrent(consumedGeneration),
      false,
      `${lifecycleEvent} must interrupt in-flight source resolution after consumption`,
    );
    assert.equal(consumedGrants.consume(request), undefined, `${lifecycleEvent} replay`);
  }
});

test("display-media callback exceptions are contained and the response settles once", () => {
  let calls = 0;
  const errors = [];
  const respond = createSafeComputerUseDisplayMediaResponder(() => {
    calls += 1;
    throw new TypeError("Video was requested, but no video stream was provided");
  }, (error) => errors.push(error));

  assert.doesNotThrow(() => respond({}));
  respond({ video: { id: "late-source" } });
  assert.equal(calls, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /no video stream/);
});

function issueGrant(grants, overrides = {}) {
  const attempt = grants.beginAttempt();
  assert.equal(grants.issueIfCurrent(attempt, grantInput(overrides)), true);
  return attempt;
}

function grantInput(overrides = {}) {
  return {
    source: {
      type: "window",
      target: { electronSourceId: "window:123:0", nativeWindowId: "123" },
    },
    sessionId: "session-1",
    descriptorId: "descriptor-1",
    revision: 4,
    authorizationGrantId: "grant-1",
    authorizationExpiresAt: "2099-01-01T00:00:00.000Z",
    requesterWebContentsId: 42,
    expectedFrameToken: "frame-token-42",
    expectedFrameTreeNodeId: 420,
    expectedFrameProcessId: 24,
    expectedFrameRoutingId: 7,
    expectedFrameUrl,
    ...overrides,
  };
}

function expectedConsumedGrant(generation = 1) {
  return {
    generation,
    source: {
      type: "window",
      target: { electronSourceId: "window:123:0", nativeWindowId: "123" },
    },
    sessionId: "session-1",
    descriptorId: "descriptor-1",
    revision: 4,
    authorizationGrantId: "grant-1",
  };
}
