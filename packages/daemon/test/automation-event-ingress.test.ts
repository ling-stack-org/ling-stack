import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createEnvSecretResolver, type AutomationEventSource } from "@ling-stack/core";
import { authenticateAutomationEvent } from "../dist/features/automations/event-ingress.js";
import { isAutomationEventIngress } from "../dist/features/automations/event-routes.js";

const now = "2026-11-16T00:00:00.000Z";
const source: AutomationEventSource = { id: "fixture", label: "Fixture", adapter: "business", enabled: true,
  secretRefs: ["env:OLD_KEY", "env:NEW_KEY"], rules: [{ automationId: "automation", types: ["alert.opened"] }], revision: 1, createdAt: now, updatedAt: now };
const secretResolver = createEnvSecretResolver({ OLD_KEY: "old-key", NEW_KEY: "new-key" });
const sign = (body: Buffer, key = "new-key", id = "event-1", type = "alert.opened", timestamp = now) => ({
  "x-ling-event-id": id, "x-ling-event-type": type, "x-ling-event-timestamp": timestamp,
  "x-ling-signature-256": `sha256=${createHmac("sha256", key).update(`${timestamp}.${id}.${type}.`).update(body).digest("hex")}`,
});

test("generic signed events bind all routing headers, rotate keys and redact persisted data", () => {
  const body = Buffer.from(JSON.stringify({ priority: "high", apiKey: "fixture-private-value" }));
  for (const key of ["old-key", "new-key"]) {
    const result = authenticateAutomationEvent({ source, body, headers: sign(body, key), secretResolver, now });
    assert.equal(result.type, "alert.opened"); assert.doesNotMatch(JSON.stringify(result), /fixture-private-value/);
  }
  for (const patch of [{ "x-ling-event-id": "another" }, { "x-ling-event-type": "another" },
    { "x-ling-event-timestamp": "2020-01-01T00:00:00.000Z" }, { "x-ling-signature-256": `sha256=${"0".repeat(64)}` }]) {
    assert.throws(() => authenticateAutomationEvent({ source, body, headers: { ...sign(body), ...patch }, secretResolver, now }), /signature/);
  }
  const old = "2020-01-01T00:00:00.000Z";
  assert.throws(() => authenticateAutomationEvent({ source, body, headers: sign(body, "new-key", "event-1", "alert.opened", old), secretResolver, now }), /timestamp/);
});

test("GitHub events validate repository, issue shape and payload timestamp after raw-body authentication", () => {
  const github = { ...source, adapter: "github" as const, repository: "org/repo" };
  const payload = { action: "opened", repository: { full_name: "org/repo" }, issue: { number: 12, updated_at: now, title: "Handle issue" } };
  const body = Buffer.from(JSON.stringify(payload));
  const headers = { "x-github-event": "issues", "x-github-delivery": "delivery-1",
    "x-hub-signature-256": `sha256=${createHmac("sha256", "new-key").update(body).digest("hex")}` };
  const result = authenticateAutomationEvent({ source: github, headers, body, secretResolver, now });
  assert.equal(result.type, "github.issues.opened");
  assert.throws(() => authenticateAutomationEvent({ source: { ...github, repository: "other/repo" }, headers, body, secretResolver, now }), /repository/);
  assert.throws(() => authenticateAutomationEvent({ source: github, headers: { ...headers, "x-github-event": "issue_comment" }, body, secretResolver, now }), /repository/);
});

test("only the exact signed-ingress POST path uses source authentication", () => {
  assert.equal(isAutomationEventIngress("/automation-event-sources/source/events", "POST"), true);
  for (const path of ["/automation-event-sources/source", "/automation-event-sources/source/events/extra", "/automation-event-sources/source%2fother/events", "/automation-deliveries/id/reconcile"]) {
    assert.equal(isAutomationEventIngress(path, "POST"), false);
  }
  assert.equal(isAutomationEventIngress("/automation-event-sources/source/events", "GET"), false);
});

test("GitHub pull request and review events preserve their subject identity", () => {
  const github = { ...source, adapter: "github" as const, repository: "org/repo" };
  for (const [type, action, extra] of [
    ["pull_request", "opened", { pull_request: { number: 13, updated_at: now } }],
    ["pull_request_review", "submitted", { pull_request: { number: 13 }, review: { id: 4, submitted_at: now } }],
    ["pull_request_review_comment", "created", { pull_request: { number: 13 }, comment: { id: 5, updated_at: now } }],
  ] as const) {
    const body = Buffer.from(JSON.stringify({ action, repository: { full_name: "org/repo" }, ...extra }));
    const headers = { "x-github-event": type, "x-github-delivery": `delivery-${type}`,
      "x-hub-signature-256": `sha256=${createHmac("sha256", "new-key").update(body).digest("hex")}` };
    assert.equal(authenticateAutomationEvent({ source: github, headers, body, secretResolver, now }).type, `github.${type}.${action}`);
  }
});
