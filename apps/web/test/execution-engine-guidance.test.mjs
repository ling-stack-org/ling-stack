import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { engineGuideUrl, engineProbeMessage } from "../src/features/settings/execution-engines/engine-guidance.ts";
import { engineProbeOutcome } from "../src/features/settings/execution-engines/execution-engine-manager.ts";

test("each supported engine uses a fixed official HTTPS guide, not a native error URL", () => {
  const expected = {
    "codex-app-server": "https://developers.openai.com/codex/cli/",
    "claude-agent-sdk": "https://code.claude.com/docs/en/setup",
    "kimi-acp": "https://moonshotai.github.io/kimi-code/en/guides/getting-started",
    "openclaw-acp": "https://docs.openclaw.ai/cli/acp",
  };
  for (const [engine, url] of Object.entries(expected)) assert.equal(engineGuideUrl(engine), url);
  assert.equal(engineGuideUrl("https://untrusted.example/"), undefined);
});

test("probe messages distinguish repair paths and never display raw native diagnostics", () => {
  const expected = {
    not_found: "Executable not found",
    not_executable: "File is not executable",
    unexpected_runtime: "Incompatible",
    unsupported_engine: "Not available in this version.",
    unsupported_platform: "Unsupported platform",
    unsupported_auth: "Unsupported authentication method",
    auth_required: "Sign in required.",
    timed_out: "Timed out",
    protocol_error: "protocol mismatch",
    probe_failed: "Connection check failed",
    output_limit: "Connection check failed",
    cancelled: "Cancelled",
    connected: "Connected",
  };
  for (const [status, message] of Object.entries(expected)) {
    assert.equal(engineProbeMessage(engineProbeOutcome({ status, authentication: "not_checked", errorCode: "private-token" }), (key) => key), message);
  }
  assert.equal(engineProbeMessage(engineProbeOutcome({ status: "connected", authentication: "required" }), (key) => key), "Sign in required.");
  assert.equal(engineProbeMessage("future_unknown", (key) => key), "Connection check failed");
});

test("guide link has a fixed destination, safe external browsing and no installation handler", () => {
  const source = fs.readFileSync(new URL("../src/features/settings/execution-engines/EngineSetupGuide.tsx", import.meta.url), "utf8");
  assert.match(source, /href=\{engineGuideUrl\(engineId\)\}/);
  assert.match(source, /target="_blank"/);
  assert.match(source, /rel="noopener noreferrer"/);
  assert.match(source, /data-desktop-window-no-drag="true"/);
  assert.doesNotMatch(source, /onClick|spawn|exec\(|fetch\(/);
});
