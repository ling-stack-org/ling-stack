import assert from "node:assert/strict";
import test from "node:test";
import { createEngineManagementTransport } from "../src/features/settings/execution-engines/engine-management-transport.ts";

test("Desktop uses only the owning bridge and never falls back to Web enrollment", () => {
  const bridge = { async listProfiles() { return { profiles: [] }; } };
  const desktop = { daemonBaseUrl: "http://127.0.0.1:17892", executionEngines: bridge };
  assert.equal(createEngineManagementTransport({ baseUrl: desktop.daemonBaseUrl, desktop }).api, bridge);
  assert.equal(createEngineManagementTransport({ baseUrl: desktop.daemonBaseUrl, desktop: { daemonBaseUrl: desktop.daemonBaseUrl } }).kind, "unavailable");
  assert.equal(createEngineManagementTransport({ baseUrl: "http://127.0.0.1:17891", desktop }).kind, "unavailable");
});

test("Web management accepts only a local execution host, and creating its client makes no requests", () => {
  const transport = createEngineManagementTransport({ baseUrl: "http://127.0.0.1:17892" });
  assert.equal(transport.kind, "web");
  for (const baseUrl of ["https://example.com", "http://127.0.0.1:17892/path", "http://user:secret@localhost:17892"]) {
    assert.equal(createEngineManagementTransport({ baseUrl }).kind, "unavailable");
  }
});
