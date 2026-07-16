import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createSqliteRunStore } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";

const execFile = promisify(execFileCallback);

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

async function createManagedOfficialGstackCache(userRoot) {
  const remoteRoot = resolve(userRoot, "fixture-official-gstack.git");
  const workRoot = resolve(userRoot, "fixture-official-gstack-work");
  const cacheRoot = resolve(userRoot, "sources", "official-gstack");
  await execFile("git", ["init", "--bare", remoteRoot]);
  await execFile("git", ["clone", remoteRoot, workRoot]);
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd: workRoot });
  await execFile("git", ["config", "user.name", "Ling Test"], { cwd: workRoot });
  await mkdir(resolve(workRoot, ".agents", "skills", "gstack-safe-sync"), { recursive: true });
  await writeFile(resolve(workRoot, "package.json"), JSON.stringify({ name: "gstack", version: "9.8.7" }));
  await writeFile(resolve(workRoot, ".agents", "skills", "gstack-safe-sync", "SKILL.md"), [
    "---",
    "name: safe-sync",
    "description: Apply a focused source synchronization update after a reviewed official change.",
    "---",
    "# Safe Sync",
    "Apply the reviewed update and validate the result.",
  ].join("\n"));
  await execFile("git", ["add", "."], { cwd: workRoot });
  await execFile("git", ["commit", "-m", "seed official skills"], { cwd: workRoot });
  await execFile("git", ["branch", "-M", "main"], { cwd: workRoot });
  await execFile("git", ["push", "origin", "main"], { cwd: workRoot });
  await mkdir(resolve(cacheRoot, ".."), { recursive: true });
  await execFile("git", ["clone", remoteRoot, cacheRoot]);
  await execFile("git", ["remote", "set-url", "origin", "https://github.com/garrytan/gstack.git"], { cwd: cacheRoot });
  await appendFile(resolve(cacheRoot, ".git", "config"), `\n[url "file://${remoteRoot}"]\n\tinsteadOf = https://github.com/garrytan/gstack.git\n`);
  return { workRoot, cacheRoot };
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

test("gstack source apply refreshes the managed official cache without a local connection or source path", async () => {
  await withTempDir("ling-stack-skill-source-apply-cwd-", async (cwd) => {
    await withTempDir("ling-stack-skill-source-apply-user-", async (userRoot) => {
      const previousLingStackHome = process.env.LING_STACK_HOME;
      process.env.LING_STACK_HOME = userRoot;
      const { workRoot, cacheRoot } = await createManagedOfficialGstackCache(userRoot);
      const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 });
      await daemon.start();
      const address = daemon.server.address();
      assert.ok(address && typeof address === "object");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const syncUrl = `${baseUrl}/skills/sync/gstack`;
      try {
        const initial = await getJson(`${syncUrl}/status?cwd=${encodeURIComponent(cwd)}`);
        assert.equal(initial.status, "ready");
        assert.equal(initial.source.originUrl, "https://github.com/garrytan/gstack.git");
        assert.equal(initial.source.repoRoot, undefined);
        const rejectedInput = await postRaw(`${syncUrl}/apply?cwd=${encodeURIComponent(cwd)}`, { skillRoots: [resolve(cwd, "ignored-skills")] });
        assert.equal(rejectedInput.status, 400);
        assert.match(await rejectedInput.text(), /official_skill_source_input_not_supported/);
        const imported = await postJson(`${syncUrl}/apply?cwd=${encodeURIComponent(cwd)}`, {});
        assert.equal(imported.summary.synced, 1);
        assert.equal(imported.summary.unchanged, 0);
        assert.equal(imported.skills.some((skill) => skill.id === "safe-sync"), true);
        assert.equal(imported.source.originUrl, "https://github.com/garrytan/gstack.git");
        assert.ok(imported.source.revision);
        assert.equal(imported.source.repoRoot, undefined);

        await writeFile(resolve(workRoot, ".agents", "skills", "gstack-safe-sync", "SKILL.md"), [
          "---",
          "name: safe-sync",
          "description: Apply a focused source synchronization update after a reviewed official change.",
          "---",
          "# Safe Sync",
          "Run rm -rf only after an explicit user confirmation.",
        ].join("\n"));
        await execFile("git", ["add", "."], { cwd: workRoot });
        await execFile("git", ["commit", "-m", "update official skill"], { cwd: workRoot });
        await execFile("git", ["push", "origin", "main"], { cwd: workRoot });
        const applied = await postJson(`${syncUrl}/apply?cwd=${encodeURIComponent(cwd)}`, {});
        assert.equal(applied.summary.synced, 1);
        assert.equal(applied.snapshots.length, 1);
        assert.equal(applied.policy.lastCheckedAt, applied.completedAt);

        const unchanged = await postJson(`${syncUrl}/apply?cwd=${encodeURIComponent(cwd)}`, {});
        assert.equal(unchanged.summary.synced, 0);
        assert.equal(unchanged.summary.unchanged, 1);

        const newSkill = resolve(workRoot, ".agents", "skills", "gstack-new-skill");
        await mkdir(newSkill, { recursive: true });
        await writeFile(resolve(newSkill, "SKILL.md"), "---\nname: new-skill\ndescription: Imported directly from the managed official source.\n---\n# New skill\n");
        await execFile("git", ["add", "."], { cwd: workRoot });
        await execFile("git", ["commit", "-m", "add official skill"], { cwd: workRoot });
        await execFile("git", ["push", "origin", "main"], { cwd: workRoot });
        const newSkillResult = await postJson(`${syncUrl}/apply?cwd=${encodeURIComponent(cwd)}`, {});
        assert.equal(newSkillResult.summary.synced, 1);
        assert.equal(newSkillResult.summary.unchanged, 1);
        assert.equal(newSkillResult.skills.some((skill) => skill.id === "new-skill"), true);

        const lastSuccessfulStatus = await getJson(`${syncUrl}/status?cwd=${encodeURIComponent(cwd)}`);
        await execFile("git", ["rm", ".agents/skills/gstack-safe-sync/SKILL.md"], { cwd: workRoot });
        await execFile("git", ["commit", "-m", "remove required skill"], { cwd: workRoot });
        await execFile("git", ["push", "origin", "main"], { cwd: workRoot });
        const missingResult = await postRaw(`${syncUrl}/apply?cwd=${encodeURIComponent(cwd)}`, {});
        assert.equal(missingResult.status, 409);
        assert.match(await missingResult.text(), /gstack_source_sync_unavailable/);
        const afterFailedSyncStatus = await getJson(`${syncUrl}/status?cwd=${encodeURIComponent(cwd)}`);
        assert.equal(afterFailedSyncStatus.source.revision, lastSuccessfulStatus.source.revision);
      } finally {
        await daemon.stop();
        if (previousLingStackHome === undefined) {
          delete process.env.LING_STACK_HOME;
        } else {
          process.env.LING_STACK_HOME = previousLingStackHome;
        }
        assert.equal(cacheRoot.includes(resolve(userRoot, "sources")), true);
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
