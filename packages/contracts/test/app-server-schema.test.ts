import assert from "node:assert/strict";
import test from "node:test";
import {
  LING_APP_SERVER_METHOD_SCHEMAS,
  getLingAppServerSchema,
  validateLingAppServerParams,
} from "../dist/app-server-schema.js";
import { LING_APP_SERVER_METHODS } from "../dist/app-server.js";

test("App Server exposes a versioned schema for every registered method", () => {
  const document = getLingAppServerSchema();
  assert.equal(document.protocolVersion, "ling-app-server/1");
  assert.deepEqual(Object.keys(document.methods), LING_APP_SERVER_METHODS);
  assert.equal(document.methods, LING_APP_SERVER_METHOD_SCHEMAS);
  assert.equal(document.methods["turn/start"]?.params.type, "object");
  assert.equal(document.methods["turn/start"]?.result.type, "object");
});

test("App Server parameter validation checks high-risk required fields while retaining extension fields", () => {
  assert.equal(validateLingAppServerParams("turn/start", { threadId: "thread-1", extension: true }).ok, true);
  const invalid = validateLingAppServerParams("turn/start", {});
  assert.deepEqual(invalid, { ok: false, path: "params.threadId", message: "is required" });
  assert.equal(validateLingAppServerParams("approval/respond", { approvalId: "approval-1", decision: "later" }).ok, false);
  assert.equal(validateLingAppServerParams("turn/start", "invalid").ok, false);
});
