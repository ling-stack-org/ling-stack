import assert from "node:assert/strict";
import test from "node:test";
import {
  OFFICE_DRIVER_PROTOCOL,
  officeMethodForTool,
  parseOfficeDriverAvailability,
  parseOfficeDriverRequest,
  parseOfficeDriverResult,
} from "../dist/office-documents.js";

test("parses bounded Office driver availability", () => {
  const availability = parseOfficeDriverAvailability({
    protocol: OFFICE_DRIVER_PROTOCOL,
    generation: 2,
    desktopInstanceId: "desktop-1",
    platform: "darwin",
    helperVersion: "0.1.0",
    state: "limited",
    capabilities: ["excel:sessions", "excel:read", "excel:write"],
    officeInstalled: true,
    applicationRunning: true,
    permissionGranted: true,
    checkedAt: "2026-08-22T00:00:00.000Z",
  });
  assert.equal(availability.state, "limited");
  assert.deepEqual(availability.capabilities, ["excel:sessions", "excel:read", "excel:write"]);
});

test("rejects unknown fields, duplicate capabilities, and Windows-only macOS claims", () => {
  const base = {
    protocol: OFFICE_DRIVER_PROTOCOL,
    generation: 1,
    desktopInstanceId: "desktop-1",
    platform: "darwin",
    helperVersion: "0.1.0",
    state: "ready",
    capabilities: ["excel:read"],
    officeInstalled: true,
    applicationRunning: true,
    checkedAt: "2026-08-22T00:00:00.000Z",
  };
  assert.throws(() => parseOfficeDriverAvailability({ ...base, extra: true }), /Unknown Office driver field/u);
  assert.throws(() => parseOfficeDriverAvailability({ ...base, capabilities: ["excel:read", "excel:read"] }), /Duplicate/u);
  assert.throws(() => parseOfficeDriverAvailability({ ...base, capabilities: ["excel:charts"] }), /Windows-only/u);
});

test("parses commands and strict success or failure results", () => {
  const command = parseOfficeDriverRequest({
    protocol: OFFICE_DRIVER_PROTOCOL,
    id: "command-1",
    method: "read_ranges",
    params: { sessionId: "session-1", ranges: ["A1:B2"] },
    deadlineAt: "2026-08-22T00:01:00.000Z",
    idempotencyKey: "run-1:tool-1",
  });
  assert.equal(command.method, "read_ranges");
  assert.equal(officeMethodForTool("office_read_ranges"), "read_ranges");
  assert.equal(parseOfficeDriverResult({
    protocol: OFFICE_DRIVER_PROTOCOL,
    id: "command-1",
    ok: true,
    result: { values: [[1]] },
  }).ok, true);
  assert.throws(() => parseOfficeDriverResult({
    protocol: OFFICE_DRIVER_PROTOCOL,
    id: "command-1",
    ok: false,
  }), /must include an error/u);
});
