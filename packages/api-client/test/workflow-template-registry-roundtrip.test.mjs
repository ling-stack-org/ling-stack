import assert from "node:assert/strict";
import test from "node:test";
import { LingDaemonClient } from "../dist/index.js";

test("template client encodes IDs, preserves CAS/pins and never starts during save or preview", async () => {
  const calls = [], entry = { kind: "workflow_template", id: "template / review", revision: 3, reviewStatus: "published" };
  const pin = { id: entry.id, version: "v1 / exact", digest: `wt1_${"a".repeat(64)}` };
  const version = { ...pin, template: { schemaVersion: 1, id: entry.id, name: "Review", steps: [] } };
  const response = { entry, version, templates: [entry], templatePin: pin, steps: [] };
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: async (url, init) => {
    calls.push({ url: new URL(String(url)), method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return Response.json(response);
  } });
  assert.deepEqual((await client.listWorkflowTemplates("/repo with space", { includeArchived: true })).templates, [entry]);
  assert.deepEqual((await client.getWorkflowTemplateVersion("/repo with space", entry.id, pin.version)).version, version);
  const save = { id: entry.id, version: pin.version, template: version.template, expectedRevision: 2 };
  assert.deepEqual((await client.saveWorkflowTemplateVersion("/repo with space", save)).entry, entry);
  const review = { expectedRevision: 2, reviewStatus: "published", version: pin.version, digest: pin.digest };
  await client.setWorkflowTemplateReviewStatus("/repo with space", entry.id, review);
  const preview = { channelId: "channel / review", objective: "Inspect", customTemplateId: pin.id,
    customTemplateVersion: pin.version, customTemplateDigest: pin.digest };
  await client.previewWorkflowTemplate("/repo with space", preview);
  await client.createChannelWorkflowFromTemplate("/repo with space", preview.channelId, { ...preview, autoStart: false });
  assert.deepEqual(calls.map(call => [call.method, call.url.pathname]), [
    ["GET", "/workflow-templates"], ["GET", "/workflow-templates/template%20%2F%20review/versions/v1%20%2F%20exact"],
    ["POST", "/workflow-templates"], ["PATCH", "/workflow-templates/template%20%2F%20review/review"],
    ["POST", "/workflow-templates/preview"], ["POST", "/channels/channel%20%2F%20review/workflows"],
  ]);
  assert.ok(calls.every(call => call.url.searchParams.get("cwd") === "/repo with space"));
  assert.equal(calls[0].url.searchParams.get("includeArchived"), "true");
  assert.deepEqual(calls[2].body, save); assert.deepEqual(calls[3].body, review); assert.deepEqual(calls[4].body, preview);
  assert.equal(calls[5].body.autoStart, false);
  assert.ok(calls.every(call => !call.url.pathname.includes("orchestrate")));
});
