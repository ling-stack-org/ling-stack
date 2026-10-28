import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCurrentMediaWorkflowProtocol,
  effectiveMediaWorkflowProtocol,
  LEGACY_MEDIA_PROTOCOL_REMOVED_CODE,
  MEDIA_PROTOCOL_UNPREPARED_CODE,
} from "../dist/features/media/workflows/media-protocol-contract.js";
import { createMediaWorkflowTestJob } from "../dist/features/media/workflows/workflow-service.js";

const now = "2026-10-28T00:00:00.000Z";
const definition = { id: "definition_1", connectionId: "connection_1", status: "draft" };
const version = { id: "version_1", validation: { ok: true }, outputRules: [{ artifactType: "image" }], inputFields: [] };

function connection(overrides = {}) {
  return { protocolVariant: "jobs_v1", health: { ok: true, protocolVariant: "jobs_v1" }, ...overrides };
}

test("new workflow tasks accept only the current Jobs API protocol", () => {
  assert.equal(effectiveMediaWorkflowProtocol(connection()), "jobs_v1");
  assert.equal(assertCurrentMediaWorkflowProtocol(connection()), "jobs_v1");
  assert.throws(
    () => assertCurrentMediaWorkflowProtocol(connection({ protocolVariant: "prompt_legacy", health: { ok: true, protocolVariant: "prompt_legacy" } })),
    error => error?.code === LEGACY_MEDIA_PROTOCOL_REMOVED_CODE,
  );
  assert.throws(
    () => assertCurrentMediaWorkflowProtocol(connection({ protocolVariant: "auto", health: undefined })),
    error => error?.code === MEDIA_PROTOCOL_UNPREPARED_CODE,
  );
});

test("legacy protocol is rejected before a new test job is persisted", () => {
  let created = false;
  const store = {
    createMediaJob() { created = true; return { id: "job_1" }; },
  };
  assert.throws(
    () => createMediaWorkflowTestJob({
      store,
      definition,
      version,
      connection: connection({ protocolVariant: "prompt_legacy", health: { ok: true, protocolVariant: "prompt_legacy" } }),
      inputValues: {},
      now,
    }),
    error => error?.code === LEGACY_MEDIA_PROTOCOL_REMOVED_CODE,
  );
  assert.equal(created, false);
});

test("an existing legacy handle remains readable through the historical decoder boundary", () => {
  assert.equal(effectiveMediaWorkflowProtocol(connection({ protocolVariant: "prompt_legacy" })), "jobs_v1",
    "a published health result is the authority when it exists");
  assert.equal(effectiveMediaWorkflowProtocol({ protocolVariant: "prompt_legacy", health: undefined }), "prompt_legacy");
});
