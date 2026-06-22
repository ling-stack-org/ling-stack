import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createDaemonServer } from "../dist/index.js";

async function withTempDir(prefix, fn) {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeSkill(root, markdown, reference = "# QA checklist\n") {
  const skillDir = resolve(root, "gstack-qa");
  await mkdir(resolve(skillDir, "references"), { recursive: true });
  await writeFile(resolve(skillDir, "SKILL.md"), markdown);
  await writeFile(resolve(skillDir, "references", "checklist.md"), reference);
}

test("skill source upgrade API checks updates, publishes artifacts, and rolls back", async () => {
  await withTempDir("ling-stack-skill-source-api-cwd-", async (cwd) => {
    await withTempDir("ling-stack-skill-source-api-root-", async (skillRoot) => {
      await writeSkill(skillRoot, [
        "---",
        "name: qa",
        "description: Run QA checks.",
        "---",
        "# QA",
        "Review and test the current change.",
      ].join("\n"));

      const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 });
      await daemon.start();
      const address = daemon.server.address();
      assert.ok(address && typeof address === "object");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      try {
        const policy = await getJson(`${baseUrl}/skills/source-upgrade-policy?cwd=${encodeURIComponent(cwd)}`);
        assert.equal(policy.policy.mode, "prompt");
        assert.equal(policy.policy.allowGlobalGstackUpgrade, false);

        const updatedPolicy = await putJson(`${baseUrl}/skills/source-upgrade-policy?cwd=${encodeURIComponent(cwd)}`, {
          mode: "auto-safe",
          approvedRootIds: ["local-gstack"],
          allowNewSkills: false,
        });
        assert.equal(updatedPolicy.policy.mode, "auto-safe");

        const checked = await postJson(`${baseUrl}/skills/sync/gstack/check-updates?cwd=${encodeURIComponent(cwd)}`, {
          skillRoots: [skillRoot],
          includeDetectedRoots: false,
        });
        assert.equal(checked.globalUpgrade.available, false);
        assert.equal(checked.preview.records.some((record) => record.skillId === "qa" && record.state === "attachable"), true);
        const checkedQaRecord = checked.preview.records.find((record) => record.skillId === "qa");
        assert.match(checkedQaRecord.sourceRootId, /^configured-skill-root:[a-f0-9]{12}$/);
        assert.equal(checked.policy.lastCheckedAt, checked.checkedAt);

        const autoSafePublish = await postRaw(`${baseUrl}/skills/sync/gstack/publish?cwd=${encodeURIComponent(cwd)}`, {
          skillRoots: [skillRoot],
          includeDetectedRoots: false,
          selectedSkillIds: ["qa"],
          publishArtifacts: true,
        });
        assert.equal(autoSafePublish.status, 409);
        assert.match(await autoSafePublish.text(), /skill_source_sync_auto_safe_rejected/);

        await putJson(`${baseUrl}/skills/source-upgrade-policy?cwd=${encodeURIComponent(cwd)}`, {
          mode: "prompt",
          approvedRootIds: ["local-gstack"],
          allowNewSkills: false,
        });

        const published = await postJson(`${baseUrl}/skills/sync/gstack/publish?cwd=${encodeURIComponent(cwd)}`, {
          skillRoots: [skillRoot],
          includeDetectedRoots: false,
          selectedSkillIds: ["qa"],
          publishArtifacts: true,
        });
        assert.equal(published.snapshots.length, 1);
        assert.equal(published.artifacts.some((artifact) => artifact.path === "SKILL.md"), true);
        assert.equal(published.artifacts.some((artifact) => artifact.path === "references/checklist.md"), true);
        const skillArtifact = published.artifacts.find((artifact) => artifact.path === "SKILL.md");
        const artifactContent = await text(`${baseUrl}/skills/source-artifacts/${encodeURIComponent(skillArtifact.id)}/content?cwd=${encodeURIComponent(cwd)}`);
        assert.match(artifactContent, /# QA/);

        await writeSkill(skillRoot, [
          "---",
          "name: qa",
          "description: Run QA checks after upgrade.",
          "---",
          "# QA Updated",
          "Review and test the current change.",
        ].join("\n"));
        const drifted = await postJson(`${baseUrl}/skills/sync/gstack/preview?cwd=${encodeURIComponent(cwd)}`, {
          skillRoots: [skillRoot],
          includeDetectedRoots: false,
        });
        const driftedRecord = drifted.preview.records.find((record) => record.skillId === "qa");
        assert.equal(driftedRecord.state, "drifted");
        assert.equal(driftedRecord.semanticDiff.some((item) => item.kind === "copy_change"), true);

        const secondPublish = await postJson(`${baseUrl}/skills/sync/gstack/publish?cwd=${encodeURIComponent(cwd)}`, {
          skillRoots: [skillRoot],
          includeDetectedRoots: false,
          selectedSkillIds: ["qa"],
          publishArtifacts: true,
        });
        assert.equal(secondPublish.snapshots.length, 1);
        assert.notEqual(secondPublish.snapshots[0].id, published.snapshots[0].id);

        const health = await getJson(`${baseUrl}/skills/source-health?cwd=${encodeURIComponent(cwd)}`);
        const archived = health.snapshots.find((snapshot) => snapshot.id === published.snapshots[0].id && snapshot.reviewStatus === "archived");
        assert.ok(archived);

        const rolledBack = await postJson(`${baseUrl}/skills/qa/source/rollback?cwd=${encodeURIComponent(cwd)}`, {
          snapshotId: archived.id,
        });
        assert.equal(rolledBack.snapshot.skillId, "qa");
        assert.equal(rolledBack.snapshot.id, archived.id);
        assert.equal(rolledBack.snapshot.sourceChecksum, published.snapshots[0].sourceChecksum);
      } finally {
        await daemon.stop();
      }
    });
  });
});

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

async function postJson(url, body) {
  const response = await postRaw(url, body);
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

async function postRaw(url, body) {
  return await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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

async function text(url) {
  const response = await fetch(url);
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.text();
}
