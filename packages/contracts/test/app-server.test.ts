import assert from "node:assert/strict";
import test from "node:test";
import {
  LING_APP_SERVER_ERROR_NUMERIC_CODES,
  LING_APP_SERVER_METHODS,
  LING_APP_SERVER_NOTIFICATION_METHODS,
  LING_APP_SERVER_PROTOCOL_VERSION,
  isLingAppServerErrorCode,
  isLingAppServerMethod,
  isLingAppServerNotification,
  isLingAppServerNotificationMethod,
  isLingAppServerRequest,
} from "../src/app-server.ts";

test("App Server V1 exposes a unique method and notification registry", () => {
  assert.equal(LING_APP_SERVER_PROTOCOL_VERSION, "ling-app-server/1");
  assert.equal(new Set(LING_APP_SERVER_METHODS).size, LING_APP_SERVER_METHODS.length);
  assert.equal(new Set(LING_APP_SERVER_NOTIFICATION_METHODS).size, LING_APP_SERVER_NOTIFICATION_METHODS.length);
  assert.equal(isLingAppServerMethod("thread/start"), true);
  assert.equal(isLingAppServerMethod("unknown/method"), false);
  assert.equal(isLingAppServerNotificationMethod("workItem/status/changed"), true);
  assert.equal(isLingAppServerNotificationMethod("thread/start"), false);
  assert.equal(isLingAppServerErrorCode("candidate_stale"), true);
  assert.equal(isLingAppServerErrorCode("not_an_error"), false);
  assert.equal(LING_APP_SERVER_ERROR_NUMERIC_CODES.server_draining, -32002);
});

test("App Server request and notification guards enforce JSON-RPC direction", () => {
  assert.equal(isLingAppServerRequest({ jsonrpc: "2.0", id: 1, method: "thread/start", params: {} }), true);
  assert.equal(isLingAppServerRequest({ jsonrpc: "2.0", method: "server/ping" }), true);
  assert.equal(isLingAppServerRequest({ jsonrpc: "1.0", id: 1, method: "thread/start" }), false);
  assert.equal(isLingAppServerRequest({ jsonrpc: "2.0", id: null, method: "thread/start" }), false);
  assert.equal(isLingAppServerRequest({ jsonrpc: "2.0", id: 1, method: "unknown/method" }), false);
  assert.equal(isLingAppServerNotification({ jsonrpc: "2.0", method: "initialized" }), true);
  assert.equal(isLingAppServerNotification({ jsonrpc: "2.0", id: 1, method: "initialized" }), false);
  assert.equal(isLingAppServerNotification({ jsonrpc: "2.0", method: "thread/start" }), false);
});
