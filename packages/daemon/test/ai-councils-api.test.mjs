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
  const engineerBefore = store.getAiTeammate(engineerId);
  assert.ok(engineerBefore);
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
        schedulingMode: "smart",
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
    const developmentCouncil = councils.councils.find((council) => council.id === developmentCouncilId);
    assert.ok(developmentCouncil);
    assert.equal(developmentCouncil.governanceProfile.permissionBoundary, "restrict_only");
    assert.equal(developmentCouncil.governanceProfile.approvalBoundary, "cannot_bypass");
    assert.equal(developmentCouncil.governanceProfile.toolGrantBoundary, "cannot_grant");
    assert.equal(developmentCouncil.governanceProfile.credentialBoundary, "cannot_grant");

    const members = await getJson(`${baseUrl}/ai-councils/${encodeURIComponent(developmentCouncilId)}/members?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(members.members.some((member) => member.teammateId === engineerId));
    assert.equal(members.members.some((member) => member.teammateId === "ling_agent"), false);

    const rejectedCreate = await postJsonError(`${baseUrl}/ai-councils?cwd=${encodeURIComponent(cwd)}`, {
      displayName: "Unsafe Council",
      allowedTools: ["write"],
    });
    assert.equal(rejectedCreate.status, 400);
    assert.equal(rejectedCreate.body.error, "bad_request");
    assert.match(rejectedCreate.body.message, /allowedTools is not supported/);

    const createdCouncil = await postJson(`${baseUrl}/ai-councils?cwd=${encodeURIComponent(cwd)}`, {
      displayName: "API Custom Council",
      description: "Created through the daemon API.",
      routingPolicy: {
        defaultMode: "advisory",
        maxActiveMembers: 2,
      },
      members: [
        {
          teammateId: engineerId,
          slotKey: "implementation",
          label: "Implementation",
          position: 0,
          enabled: true,
        },
      ],
      pinned: true,
    });
    assert.equal(createdCouncil.status, undefined);
    assert.equal(createdCouncil.council.source, "user");
    assert.equal(createdCouncil.council.displayName, "API Custom Council");
    assert.equal(createdCouncil.council.governanceProfile.toolGrantBoundary, "cannot_grant");
    assert.equal(createdCouncil.council.governanceProfile.credentialBoundary, "cannot_grant");
    const createdCouncilMembers = await getJson(`${baseUrl}/ai-councils/${encodeURIComponent(createdCouncil.council.id)}/members?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(createdCouncilMembers.members.map((member) => member.teammateId), [engineerId]);

    const rejectedClone = await postJsonError(`${baseUrl}/ai-councils/${encodeURIComponent(developmentCouncilId)}/clone?cwd=${encodeURIComponent(cwd)}`, {
      displayName: "Unsafe Clone",
      allowedTools: ["write"],
    });
    assert.equal(rejectedClone.status, 400);
    assert.equal(rejectedClone.body.error, "bad_request");
    assert.match(rejectedClone.body.message, /allowedTools is not supported/);

    const clonedCouncil = await postJson(`${baseUrl}/ai-councils/${encodeURIComponent(developmentCouncilId)}/clone?cwd=${encodeURIComponent(cwd)}`, {
      displayName: "API Clone Council",
      description: "Cloned through the daemon API.",
    });
    assert.equal(clonedCouncil.council.source, "user");
    assert.equal(clonedCouncil.council.displayName, "API Clone Council");
    assert.equal(clonedCouncil.council.governanceProfile.approvalBoundary, "cannot_bypass");
    const clonedCouncilMembers = await getJson(`${baseUrl}/ai-councils/${encodeURIComponent(clonedCouncil.council.id)}/members?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(clonedCouncilMembers.members.some((member) => member.teammateId === engineerId));
    assert.equal(clonedCouncilMembers.members.some((member) => member.teammateId === "ling_agent"), false);

    const rejectedBuiltInPatch = await patchJsonError(`${baseUrl}/ai-councils/${encodeURIComponent(developmentCouncilId)}?cwd=${encodeURIComponent(cwd)}`, {
      status: "archived",
    });
    assert.equal(rejectedBuiltInPatch.status, 400);
    assert.equal(rejectedBuiltInPatch.body.error, "bad_request");
    assert.match(rejectedBuiltInPatch.body.message, /clone them first/);

    const missingHealthCwd = await fetch(`${baseUrl}/ai-councils/health`);
    assert.equal(missingHealthCwd.status, 400);
    const health = await getJson(`${baseUrl}/ai-councils/health?cwd=${encodeURIComponent(cwd)}&limit=10`);
    assert.equal(health.cwd, cwd);
    assert.equal(health.report.workspaceId, "workspace_default");
    assert.equal(typeof health.report.generatedAt, "string");
    assert.equal(health.report.summary.totalCouncils >= 1, true);
    assert.equal(Array.isArray(health.report.findings), true);
    assert.equal(health.report.findings.length <= 10, true);
    const postHealth = await fetch(`${baseUrl}/ai-councils/health?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(postHealth.status, 405);

    const defaultPolicy = await getJson(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/council-policy?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(defaultPolicy.policy.attachedCouncilIds, []);

    const rejectedPolicy = await putJsonError(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/council-policy?cwd=${encodeURIComponent(cwd)}`, {
      attachedCouncilIds: [developmentCouncilId],
      preferredCouncilId: developmentCouncilId,
      allowedTools: ["write"],
      approvalProfile: { mode: "none" },
      credentialRef: "secret:should-not-exist",
      runtimePolicy: { maxConcurrentRuns: 99 },
    });
    assert.equal(rejectedPolicy.status, 400);
    assert.equal(rejectedPolicy.body.error, "bad_request");
    assert.match(rejectedPolicy.body.message, /allowedTools is not supported/);
    const policyAfterRejectedWrite = await getJson(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/council-policy?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(policyAfterRejectedWrite.policy.attachedCouncilIds, []);

    const updatedPolicy = await putJson(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/council-policy?cwd=${encodeURIComponent(cwd)}`, {
      attachedCouncilIds: [developmentCouncilId],
      preferredCouncilId: developmentCouncilId,
    });
    assert.deepEqual(updatedPolicy.policy.attachedCouncilIds, [developmentCouncilId]);
    assert.equal(updatedPolicy.policy.preferredCouncilId, developmentCouncilId);
    assert.equal(Object.hasOwn(updatedPolicy.policy, "allowedTools"), false);
    assert.equal(Object.hasOwn(updatedPolicy.policy, "approvalProfile"), false);
    assert.equal(Object.hasOwn(updatedPolicy.policy, "credentialRef"), false);
    assert.equal(Object.hasOwn(updatedPolicy.policy, "runtimePolicy"), false);

    const rejectedMembers = await putJsonError(`${baseUrl}/ai-councils/${encodeURIComponent(developmentCouncilId)}/members?cwd=${encodeURIComponent(cwd)}`, {
      members: [
        {
          teammateId: engineerId,
          slotKey: "implementation",
          label: "Implementation",
          position: 0,
          enabled: true,
          allowedTools: ["write"],
          approvalProfile: { mode: "none" },
          credentialRef: "secret:should-not-exist",
        },
      ],
    });
    assert.equal(rejectedMembers.status, 400);
    assert.equal(rejectedMembers.body.error, "bad_request");
    assert.match(rejectedMembers.body.message, /members\[0\]\.allowedTools is not supported/);
    const membersAfterRejectedWrite = await getJson(`${baseUrl}/ai-councils/${encodeURIComponent(developmentCouncilId)}/members?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(membersAfterRejectedWrite.members.some((member) => member.teammateId === engineerId));

    const replacedMembers = await putJson(`${baseUrl}/ai-councils/${encodeURIComponent(developmentCouncilId)}/members?cwd=${encodeURIComponent(cwd)}`, {
      members: [
        {
          teammateId: engineerId,
          slotKey: "implementation",
          label: "Implementation",
          position: 0,
          enabled: true,
        },
      ],
    });
    assert.deepEqual(replacedMembers.members.map((member) => member.teammateId), [engineerId]);
    assert.equal(Object.hasOwn(replacedMembers.members[0], "allowedTools"), false);
    assert.equal(Object.hasOwn(replacedMembers.members[0], "approvalProfile"), false);
    assert.equal(Object.hasOwn(replacedMembers.members[0], "credentialRef"), false);

    const effective = await getJson(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/effective-council?cwd=${encodeURIComponent(cwd)}`);
    const engineerSpecialist = effective.effectiveCouncil.specialists.find((specialist) => specialist.teammateId === engineerId);
    assert.ok(engineerSpecialist);
    assert.ok(engineerSpecialist.sources.some((source) => source.kind === "council" && source.councilId === developmentCouncilId));

    const policyWithClone = await putJson(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/council-policy?cwd=${encodeURIComponent(cwd)}`, {
      attachedCouncilIds: [developmentCouncilId, clonedCouncil.council.id],
      preferredCouncilId: clonedCouncil.council.id,
    });
    assert.deepEqual(policyWithClone.policy.attachedCouncilIds, [developmentCouncilId, clonedCouncil.council.id]);
    assert.equal(policyWithClone.policy.preferredCouncilId, clonedCouncil.council.id);
    const archivedClone = await patchJson(`${baseUrl}/ai-councils/${encodeURIComponent(clonedCouncil.council.id)}?cwd=${encodeURIComponent(cwd)}`, {
      status: "archived",
    });
    assert.equal(archivedClone.council.status, "archived");
    const detachedPolicy = await getJson(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/council-policy?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(detachedPolicy.policy.attachedCouncilIds, [developmentCouncilId]);
    assert.equal(detachedPolicy.policy.preferredCouncilId, developmentCouncilId);

    const engineerChannels = await getJson(`${baseUrl}/teammates/${encodeURIComponent(engineerId)}/channels?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(engineerChannels.memberships.some((membership) => membership.channelId === channel.id), false);

    await putJson(`${baseUrl}/ai-councils/${encodeURIComponent(developmentCouncilId)}/members?cwd=${encodeURIComponent(cwd)}`, {
      members: [
        {
          teammateId: engineerId,
          slotKey: "implementation",
          label: "Implementation",
          position: 0,
          enabled: false,
        },
      ],
    });
    const healthAfterDisable = await getJson(`${baseUrl}/ai-councils/health?cwd=${encodeURIComponent(cwd)}&limit=20`);
    assert.ok(healthAfterDisable.report.findings.some((finding) =>
      finding.kind === "member_disabled" &&
      finding.councilId === developmentCouncilId &&
      finding.teammateId === engineerId
    ));
    assert.ok(healthAfterDisable.report.findings.some((finding) =>
      finding.kind === "council_no_available_members" &&
      finding.councilId === developmentCouncilId &&
      finding.severity === "critical"
    ));
  } finally {
    await daemon.stop();
    const verifyStore = createSqliteRunStore(cwd);
    try {
      const verifiedChannel = verifyStore.getChannel(channel.id);
      assert.ok(verifiedChannel);
      assert.deepEqual(verifiedChannel.allowedTools, ["read"]);
      assert.equal(verifiedChannel.runtimePolicy.maxConcurrentRuns, 1);
      assert.equal(verifyStore.listTeammateChannelMemberships(engineerId).some((membership) => membership.channelId === channel.id), false);
      const engineerAfter = verifyStore.getAiTeammate(engineerId);
      assert.ok(engineerAfter);
      assert.deepEqual(engineerAfter.allowedTools, engineerBefore.allowedTools);
      assert.deepEqual(engineerAfter.approvalProfile, engineerBefore.approvalProfile);
      assert.equal(engineerAfter.providerPresetId, engineerBefore.providerPresetId);
      assert.equal(engineerAfter.runnerId, engineerBefore.runnerId);
    } finally {
      verifyStore.close();
    }
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

async function putJsonError(url, body) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.ok, false);
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

async function postJsonError(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.ok, false);
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function patchJson(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

async function patchJsonError(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.ok, false);
  return {
    status: response.status,
    body: await response.json(),
  };
}
