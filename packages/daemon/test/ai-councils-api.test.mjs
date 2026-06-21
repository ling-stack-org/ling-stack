import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createSqliteRunStore } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";

const developmentCouncilId = "council_builtin_development";
const engineerId = "teammate_builtin_engineer";

test("AI council API exposes Development Council and channel effective projection", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ai-councils-api-"));
  const store = createSqliteRunStore(cwd);
  const channel = store.createChannel(
    {
      name: "Council Channel",
      status: "active",
      boundPath: cwd,
      workspaceBinding: {
        mode: "local",
        status: "ready",
        executionPath: cwd,
        updatedAt: "2026-06-20T00:00:00.000Z",
      },
      allowedTools: ["read"],
      runtimePolicy: {
        maxConcurrentRuns: 1,
        executionMode: "serial",
        writeLockScope: "boundPath",
        allowReadOnlyParallel: true,
        queueOnConflict: true,
      },
    },
    "2026-06-20T00:00:00.000Z",
  );
  store.close();
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const councils = await getJson(`${baseUrl}/ai-councils?cwd=${encodeURIComponent(cwd)}&includeArchived=true`);
    assert.ok(councils.councils.some((council) => council.id === developmentCouncilId));

    const members = await getJson(`${baseUrl}/ai-councils/${encodeURIComponent(developmentCouncilId)}/members?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(members.members.some((member) => member.teammateId === engineerId));
    assert.equal(members.members.some((member) => member.teammateId === "ling_agent"), false);

    const defaultPolicy = await getJson(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/council-policy?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(defaultPolicy.policy.attachedCouncilIds, []);

    const updatedPolicy = await putJson(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/council-policy?cwd=${encodeURIComponent(cwd)}`, {
      attachedCouncilIds: [developmentCouncilId],
      preferredCouncilId: developmentCouncilId,
    });
    assert.deepEqual(updatedPolicy.policy.attachedCouncilIds, [developmentCouncilId]);
    assert.equal(updatedPolicy.policy.preferredCouncilId, developmentCouncilId);

    const effective = await getJson(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/effective-council?cwd=${encodeURIComponent(cwd)}`);
    const engineerSpecialist = effective.effectiveCouncil.specialists.find((specialist) => specialist.teammateId === engineerId);
    assert.ok(engineerSpecialist);
    assert.ok(engineerSpecialist.sources.some((source) => source.kind === "council" && source.councilId === developmentCouncilId));

    const engineerChannels = await getJson(`${baseUrl}/teammates/${encodeURIComponent(engineerId)}/channels?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(engineerChannels.memberships.some((membership) => membership.channelId === channel.id), false);
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

async function putJson(url, body) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}
