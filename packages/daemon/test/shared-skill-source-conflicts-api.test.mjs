import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
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

async function withDaemon(cwd, fn) {
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await daemon.stop();
  }
}

function skillMarkdown(name, description, body = "Do the work.") {
  return ["---", `name: ${name}`, `description: ${description}`, "---", `# ${name}`, body].join("\n");
}

async function writeSkillDirectory(root, directoryName, markdown) {
  const directory = resolve(root, directoryName);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "SKILL.md"), markdown, "utf8");
  return directory;
}

async function getJson(url) {
  const response = await fetch(url);
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

async function postJson(url, body) {
  const response = await postRaw(url, body);
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

async function createManagedOfficialGstackCache(userRoot, skillId) {
  const remoteRoot = resolve(userRoot, "fixture-official-gstack.git");
  const workRoot = resolve(userRoot, "fixture-official-gstack-work");
  const cacheRoot = resolve(userRoot, "sources", "official-gstack");
  await execFile("git", ["init", "--bare", remoteRoot]);
  await execFile("git", ["clone", remoteRoot, workRoot]);
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd: workRoot });
  await execFile("git", ["config", "user.name", "Ling Test"], { cwd: workRoot });
  const skillDirectory = resolve(workRoot, ".agents", "skills", skillId);
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(resolve(workRoot, "package.json"), JSON.stringify({ name: "gstack", version: "9.8.7" }));
  await writeFile(resolve(skillDirectory, "SKILL.md"), skillMarkdown(skillId, "Delivered by the managed official source."));
  await execFile("git", ["add", "."], { cwd: workRoot });
  await execFile("git", ["commit", "-m", "seed official skills"], { cwd: workRoot });
  await execFile("git", ["branch", "-M", "main"], { cwd: workRoot });
  await execFile("git", ["push", "origin", "main"], { cwd: workRoot });
  await mkdir(resolve(cacheRoot, ".."), { recursive: true });
  await execFile("git", ["clone", remoteRoot, cacheRoot]);
  await execFile("git", ["remote", "set-url", "origin", "https://github.com/garrytan/gstack.git"], { cwd: cacheRoot });
  await appendFile(resolve(cacheRoot, ".git", "config"), `\n[url "file://${remoteRoot}"]\n\tinsteadOf = https://github.com/garrytan/gstack.git\n`);
  // The bare remote keeps its own HEAD, so populate the cache checkout the same way the
  // daemon's official refresh does before anything scans the skills folder.
  await execFile("git", ["fetch", "--depth=1", "origin", "main"], { cwd: cacheRoot });
  await execFile("git", ["checkout", "--force", "main"], { cwd: cacheRoot });
  return { workRoot, cacheRoot, skillsRoot: resolve(cacheRoot, ".agents", "skills") };
}

async function publishLegacyGstackSkill(baseUrl, cwd, fixtureRoot, skillDirectoryName) {
  const cwdQuery = `cwd=${encodeURIComponent(cwd)}`;
  return await postJson(`${baseUrl}/skills/sync/gstack/publish?${cwdQuery}`, {
    roots: [{ id: "fixture-gstack-root", rootPath: fixtureRoot, sourceKind: "gstack-skill-directory" }],
    selectedSkillIds: [skillDirectoryName],
    allowNewSkills: true,
    publishArtifacts: false,
  });
}

async function publishWorkspaceManagedSkill(baseUrl, cwd, name) {
  const cwdQuery = `cwd=${encodeURIComponent(cwd)}`;
  const draft = await postJson(`${baseUrl}/skills/import-draft?${cwdQuery}`, {
    source: "workspace",
    sourcePath: "SKILL.md",
    content: skillMarkdown(name, "Owned by the workspace source."),
  });
  return await postJson(`${baseUrl}/skills/import-drafts/${encodeURIComponent(draft.draft.id)}/publish?${cwdQuery}`, {});
}

test("shared candidates are blocked for builtin, gstack, and workspace-managed ids and cannot publish", async () => {
  await withTempDir("ling-shared-conflict-cwd-", async (cwd) => {
    await withDaemon(cwd, async (baseUrl) => {
      const cwdQuery = `cwd=${encodeURIComponent(cwd)}`;
      const legacyRoot = resolve(cwd, "legacy-gstack-skills");
      await writeSkillDirectory(legacyRoot, "gstack-owned", skillMarkdown("gstack-owned", "Owned by the legacy gstack source."));
      await publishLegacyGstackSkill(baseUrl, cwd, legacyRoot, "gstack-owned");
      await publishWorkspaceManagedSkill(baseUrl, cwd, "Workspace Owned");

      const sharedRoot = resolve(cwd, ".agents", "skills");
      await writeSkillDirectory(sharedRoot, "review", skillMarkdown("review", "Attempted builtin takeover."));
      await writeSkillDirectory(sharedRoot, "gstack-owned", skillMarkdown("gstack-owned", "Attempted gstack takeover."));
      await writeSkillDirectory(sharedRoot, "workspace-owned", skillMarkdown("workspace-owned", "Attempted workspace takeover."));

      const preview = await postJson(`${baseUrl}/skills/sync/shared/preview?${cwdQuery}`, { includeUserRoot: false });
      for (const skillId of ["review", "gstack-owned", "workspace-owned"]) {
        const record = preview.preview.records.find((entry) => entry.skillId === skillId);
        assert.ok(record, `expected a blocked record for ${skillId}`);
        assert.equal(record.state, "blocked");
        assert.equal(record.warnings.some((warning) => warning.code === "skill_id_conflict" && warning.severity === "error"), true);
        assert.equal(record.definitionPreview, undefined);
        assert.equal(record.snapshotPreview, undefined);
      }
      assert.equal(preview.preview.summary.blocked, 3);

      const rejected = await postRaw(`${baseUrl}/skills/sync/shared/publish?${cwdQuery}`, {
        includeUserRoot: false,
        selectedSkillIds: ["review", "gstack-owned", "workspace-owned"],
        allowNewSkills: true,
      });
      assert.equal(rejected.status, 409);
      const rejectionBody = await rejected.text();
      assert.match(rejectionBody, /skill_source_sync_not_publishable/);
      for (const skillId of ["review", "gstack-owned", "workspace-owned"]) {
        assert.match(rejectionBody, new RegExp(`${skillId}:blocked`));
      }

      // Nothing was published or overwritten for the conflicting ids.
      const listed = await getJson(`${baseUrl}/skills?${cwdQuery}`);
      const review = listed.skills.find((skill) => skill.id === "review");
      assert.equal(review.source, "builtin");
      assert.equal(listed.skills.find((skill) => skill.id === "gstack-owned").source, "gstack");
      assert.equal(listed.skills.find((skill) => skill.id === "workspace-owned").source, "workspace");

      const health = await getJson(`${baseUrl}/skills/source-health?${cwdQuery}`);
      const conflictingSnapshots = health.snapshots.filter((snapshot) => ["review", "workspace-owned"].includes(snapshot.skillId));
      assert.deepEqual(conflictingSnapshots, []);
      assert.equal(health.snapshots.filter((snapshot) => snapshot.skillId === "gstack-owned").length, 1);
      assert.equal(health.snapshots.find((snapshot) => snapshot.skillId === "gstack-owned").sourceKind, "gstack-skill-directory");
    });
  });
});

test("duplicate shared skill ids stay blocked even when the last root owns an unchanged snapshot", async () => {
  await withTempDir("ling-shared-duplicate-cwd-", async (cwd) => {
    await withTempDir("ling-shared-duplicate-user-", async (homeDir) => {
      const oldHome = process.env.HOME;
      process.env.HOME = homeDir;
      try {
        const projectRoot = resolve(cwd, ".agents", "skills");
        const userRoot = resolve(homeDir, ".agents", "skills");
        await writeSkillDirectory(userRoot, "shared-duplicate", skillMarkdown("shared-duplicate", "User copy."));
        await withDaemon(cwd, async (baseUrl) => {
          const query = `cwd=${encodeURIComponent(cwd)}`;
          const publishUrl = `${baseUrl}/skills/sync/shared/publish?${query}`;
          const userPublish = await postJson(publishUrl, {
            includeProjectRoot: false, selectedSkillIds: ["shared-duplicate"], allowNewSkills: true,
          });
          assert.equal(userPublish.snapshots.length, 1);
          await writeSkillDirectory(projectRoot, "shared-duplicate", skillMarkdown("shared-duplicate", "Project copy."));
          const preview = await postJson(`${baseUrl}/skills/sync/shared/preview?${query}`, {});
          assert.equal(preview.preview.records.filter((item) => item.skillId === "shared-duplicate").length, 2);
          const rejected = await postRaw(publishUrl, { selectedSkillIds: ["shared-duplicate"] });
          assert.equal(rejected.status, 409);
          assert.match(await rejected.text(), /skill_source_sync_not_publishable/);
          const health = await getJson(`${baseUrl}/skills/source-health?${query}`);
          assert.deepEqual(health.snapshots.filter((item) => item.skillId === "shared-duplicate").map((item) => item.id), [userPublish.snapshots[0].id]);
        });
      } finally {
        if (oldHome === undefined) delete process.env.HOME;
        else process.env.HOME = oldHome;
      }
    });
  });
});

test("shared preview never adopts a legacy gstack snapshot at the exact same source path", async () => {
  await withTempDir("ling-shared-legacy-cwd-", async (cwd) => {
    await withDaemon(cwd, async (baseUrl) => {
      const query = `cwd=${encodeURIComponent(cwd)}`;
      const sharedRoot = resolve(cwd, ".agents", "skills");
      await writeSkillDirectory(sharedRoot, "legacy-at-shared-path", skillMarkdown("legacy-at-shared-path", "Legacy-owned source."));
      await publishLegacyGstackSkill(baseUrl, cwd, sharedRoot, "legacy-at-shared-path");
      const preview = await postJson(`${baseUrl}/skills/sync/shared/preview?${query}`, { includeUserRoot: false });
      const record = preview.preview.records.find((item) => item.skillId === "legacy-at-shared-path");
      assert.equal(record.state, "blocked");
      assert.equal(record.existingSnapshotId, undefined);
      assert.equal(record.warnings.some((warning) => warning.code === "skill_id_conflict"), true);
    });
  });
});

test("a blocked shared candidate aborts a mixed publish batch before any new snapshot is written", async () => {
  await withTempDir("ling-shared-atomic-cwd-", async (cwd) => {
    await withDaemon(cwd, async (baseUrl) => {
      const query = `cwd=${encodeURIComponent(cwd)}`;
      const sharedRoot = resolve(cwd, ".agents", "skills");
      await writeSkillDirectory(sharedRoot, "batch-good", skillMarkdown("batch-good", "Good source."));
      await writeSkillDirectory(sharedRoot, "review", skillMarkdown("review", "Conflicts with built-in."));
      const publishUrl = `${baseUrl}/skills/sync/shared/publish?${query}`;
      const rejected = await postRaw(publishUrl, {
        includeUserRoot: false,
        selectedSkillIds: ["batch-good", "review"],
        allowNewSkills: true,
        publishArtifacts: true,
      });
      assert.equal(rejected.status, 409);
      assert.match(await rejected.text(), /review:blocked/);
      const health = await getJson(`${baseUrl}/skills/source-health?${query}`);
      assert.equal(health.snapshots.some((item) => item.skillId === "batch-good"), false);
      assert.equal((await getJson(`${baseUrl}/skills?${query}`)).skills.some((item) => item.id === "batch-good"), false);
      const accepted = await postJson(publishUrl, {
        includeUserRoot: false,
        selectedSkillIds: ["batch-good"],
        allowNewSkills: true,
        publishArtifacts: true,
      });
      assert.equal(accepted.snapshots.length, 1);
    });
  });
});

test("shared publish rejects error-severity warnings such as raw secrets", async () => {
  await withTempDir("ling-shared-secret-cwd-", async (cwd) => {
    await withDaemon(cwd, async (baseUrl) => {
      const query = `cwd=${encodeURIComponent(cwd)}`;
      const sharedRoot = resolve(cwd, ".agents", "skills");
      await writeSkillDirectory(
        sharedRoot,
        "leaky",
        skillMarkdown("leaky", "Carries a raw token.", "Use sk-fake-abcdef1234567890 for the vendor API."),
      );
      const publishUrl = `${baseUrl}/skills/sync/shared/publish?${query}`;
      // Preview must expose the error-severity secret_reference warning...
      const preview = await postJson(`${baseUrl}/skills/sync/shared/preview?${query}`, { includeUserRoot: false });
      const leaky = preview.preview.records.find((record) => record.skillId === "leaky");
      assert.equal(leaky.warnings.some((warning) => warning.code === "secret_reference" && warning.severity === "error"), true);
      // ...and the publish must be rejected instead of persisted.
      const rejected = await postRaw(publishUrl, {
        includeUserRoot: false,
        selectedSkillIds: ["leaky"],
        allowNewSkills: true,
        publishArtifacts: false,
      });
      assert.equal(rejected.status, 409);
      assert.match(await rejected.text(), /error-severity warnings|not publishable/);
      const health = await getJson(`${baseUrl}/skills/source-health?${query}`);
      assert.equal(health.snapshots.some((item) => item.skillId === "leaky"), false);
      assert.equal((await getJson(`${baseUrl}/skills?${query}`)).skills.some((item) => item.id === "leaky"), false);
    });
  });
});

test("shared snapshots stay isolated from the managed official source and legacy gstack preview", async () => {
  await withTempDir("ling-shared-isolation-cwd-", async (cwd) => {
    await withTempDir("ling-shared-isolation-user-", async (userRoot) => {
      const previousLingStackHome = process.env.LING_STACK_HOME;
      process.env.LING_STACK_HOME = userRoot;
      try {
        const official = await createManagedOfficialGstackCache(userRoot, "official-safe-sync");
        await withDaemon(cwd, async (baseUrl) => {
          const cwdQuery = `cwd=${encodeURIComponent(cwd)}`;
          const sharedRoot = resolve(cwd, ".agents", "skills");
          await writeSkillDirectory(sharedRoot, "shared-isolated", skillMarkdown("shared-isolated", "Adopted from the shared folders."));
          const published = await postJson(`${baseUrl}/skills/sync/shared/publish?${cwdQuery}`, {
            includeUserRoot: false,
            selectedSkillIds: ["shared-isolated"],
            allowNewSkills: true,
            publishArtifacts: false,
          });
          assert.equal(published.snapshots.length, 1);

          // Legacy gstack preview must not report the shared snapshot as a missing source.
          const legacyPreview = await postJson(`${baseUrl}/skills/sync/gstack/preview?${cwdQuery}`, {
            roots: [{ id: "official-fixture", rootPath: official.skillsRoot, sourceKind: "gstack-skill-directory" }],
          });
          assert.equal(legacyPreview.preview.records.some((record) => record.skillId === "shared-isolated"), false);
          assert.equal(
            legacyPreview.preview.records.some((record) => record.skillId === "official-safe-sync" && record.state === "new"),
            true,
          );

          // The official apply must ignore shared snapshots and still import its own revision.
          const applied = await postJson(`${baseUrl}/skills/sync/gstack/apply?${cwdQuery}`, {});
          assert.equal(applied.summary.synced, 1);
          assert.equal(applied.summary.unchanged, 0);
          assert.equal(applied.skills.some((skill) => skill.id === "official-safe-sync"), true);
          assert.ok(applied.source.revision);

          const status = await getJson(`${baseUrl}/skills/sync/gstack/status?${cwdQuery}`);
          assert.equal(status.status, "synced");
          assert.ok(status.source.revision);

          // Shared entries and provenance survive the official apply untouched.
          const listed = await getJson(`${baseUrl}/skills?${cwdQuery}`);
          const sharedSkill = listed.skills.find((skill) => skill.id === "shared-isolated");
          assert.equal(sharedSkill.source, "skill-directory");
          assert.equal(sharedSkill.packId, "shared-skill-source-sync");
          const officialSkill = listed.skills.find((skill) => skill.id === "official-safe-sync");
          assert.equal(officialSkill.source, "gstack");
          assert.equal(officialSkill.packId, "gstack-source-sync");

          const health = await getJson(`${baseUrl}/skills/source-health?${cwdQuery}`);
          const sharedSnapshots = health.snapshots.filter((snapshot) => snapshot.skillId === "shared-isolated");
          assert.equal(sharedSnapshots.length, 1);
          assert.equal(sharedSnapshots[0].reviewStatus, "published");
          assert.equal(sharedSnapshots[0].sourceKind, "workspace-skill-directory");

          // Shared preview only sees shared-root snapshots; the official entry is invisible there.
          const sharedPreview = await postJson(`${baseUrl}/skills/sync/shared/preview?${cwdQuery}`, { includeUserRoot: false });
          assert.equal(sharedPreview.preview.records.some((record) => record.skillId === "official-safe-sync"), false);
          const sharedRecord = sharedPreview.preview.records.find((record) => record.skillId === "shared-isolated");
          assert.equal(sharedRecord.state, "unchanged");
        });
      } finally {
        if (previousLingStackHome === undefined) {
          delete process.env.LING_STACK_HOME;
        } else {
          process.env.LING_STACK_HOME = previousLingStackHome;
        }
      }
    });
  });
});

test("published shared skills refresh from their shared source without touching official state", async () => {
  await withTempDir("ling-shared-refresh-cwd-", async (cwd) => {
    await withDaemon(cwd, async (baseUrl) => {
      const cwdQuery = `cwd=${encodeURIComponent(cwd)}`;
      const sharedRoot = resolve(cwd, ".agents", "skills");
      await writeSkillDirectory(sharedRoot, "shared-refresh", skillMarkdown("shared-refresh", "Initial shared description."));
      const firstPublish = await postJson(`${baseUrl}/skills/sync/shared/publish?${cwdQuery}`, {
        includeUserRoot: false,
        selectedSkillIds: ["shared-refresh"],
        allowNewSkills: true,
        publishArtifacts: false,
      });
      const firstSnapshot = firstPublish.snapshots[0];

      await writeSkillDirectory(
        sharedRoot,
        "shared-refresh",
        skillMarkdown("shared-refresh", "Updated shared description.", "Validate again and report blockers."),
      );

      const drifted = await postJson(`${baseUrl}/skills/sync/shared/preview?${cwdQuery}`, { includeUserRoot: false });
      const driftedRecord = drifted.preview.records.find((record) => record.skillId === "shared-refresh");
      assert.equal(driftedRecord.state, "drifted");
      assert.equal(driftedRecord.existingSnapshotId, firstSnapshot.id);
      assert.equal(driftedRecord.diff.some((item) => item.field === "sourceChecksum"), true);

      const updated = await postJson(`${baseUrl}/skills/sync/shared/publish?${cwdQuery}`, {
        includeUserRoot: false,
        selectedSkillIds: ["shared-refresh"],
        publishArtifacts: false,
      });
      assert.equal(updated.snapshots.length, 1);
      assert.notEqual(updated.snapshots[0].id, firstSnapshot.id);
      assert.equal(updated.snapshots[0].reviewStatus, "published");
      assert.equal(updated.snapshots[0].sourceKind, "workspace-skill-directory");

      const health = await getJson(`${baseUrl}/skills/source-health?${cwdQuery}`);
      const snapshots = health.snapshots.filter((snapshot) => snapshot.skillId === "shared-refresh");
      assert.equal(snapshots.length, 2);
      assert.equal(snapshots.find((snapshot) => snapshot.id === firstSnapshot.id).reviewStatus, "archived");
      assert.equal(snapshots.find((snapshot) => snapshot.id === updated.snapshots[0].id).reviewStatus, "published");

      // Updates refresh provenance only; the approved definition stays as the user owns it.
      const listed = await getJson(`${baseUrl}/skills?${cwdQuery}`);
      const skill = listed.skills.find((entry) => entry.id === "shared-refresh");
      assert.equal(skill.source, "skill-directory");
      assert.equal(skill.packId, "shared-skill-source-sync");
      assert.equal(skill.definition.summary, "Initial shared description.");

      // Official state is untouched by shared refreshes.
      const status = await getJson(`${baseUrl}/skills/sync/gstack/status?${cwdQuery}`);
      assert.equal(status.status, "ready");
      assert.equal(status.source.revision, undefined);

      // A gstack-style preview over an unrelated root must not surface the shared skill as missing.
      const unrelatedRoot = resolve(cwd, "unrelated-gstack-root");
      await mkdir(unrelatedRoot, { recursive: true });
      const legacyPreview = await postJson(`${baseUrl}/skills/sync/gstack/preview?${cwdQuery}`, {
        roots: [{ id: "unrelated", rootPath: unrelatedRoot, sourceKind: "gstack-skill-directory" }],
      });
      assert.equal(legacyPreview.preview.records.some((record) => record.skillId === "shared-refresh"), false);
    });
  });
});

test("shared publish rejects unchanged selections without replacing snapshots", async () => {
  await withTempDir("ling-shared-unchanged-cwd-", async (cwd) => {
    await withDaemon(cwd, async (baseUrl) => {
      const query = `cwd=${encodeURIComponent(cwd)}`;
      await writeSkillDirectory(resolve(cwd, ".agents", "skills"), "unchanged-shared", skillMarkdown("unchanged-shared", "Stable."));
      const url = `${baseUrl}/skills/sync/shared/publish?${query}`;
      const first = await postJson(url, { includeUserRoot: false, selectedSkillIds: ["unchanged-shared"], allowNewSkills: true });
      const repeated = await postRaw(url, { includeUserRoot: false, selectedSkillIds: ["unchanged-shared"] });
      assert.equal(repeated.status, 409);
      assert.match(await repeated.text(), /skill_source_sync_not_publishable/);
      const snapshots = (await getJson(`${baseUrl}/skills/source-health?${query}`)).snapshots;
      assert.deepEqual(snapshots.filter((item) => item.skillId === "unchanged-shared").map((item) => item.id), [first.snapshots[0].id]);
    });
  });
});

test("shared publishing stays explicit even when the official upgrade policy is auto-safe", async () => {
  await withTempDir("ling-shared-autosafe-cwd-", async (cwd) => {
    await withDaemon(cwd, async (baseUrl) => {
      const cwdQuery = `cwd=${encodeURIComponent(cwd)}`;
      const policy = await putJson(`${baseUrl}/skills/source-upgrade-policy?${cwdQuery}`, { mode: "auto-safe" });
      assert.equal(policy.policy.mode, "auto-safe");

      const sharedRoot = resolve(cwd, ".agents", "skills");
      await writeSkillDirectory(sharedRoot, "shared-explicit", skillMarkdown("shared-explicit", "Confirmed by the user."));
      const selected = ["shared-explicit"];

      // The official auto-safe whitelist never applies to shared folders: explicit
      // confirmation publishes, and the shared publish cannot change official policy state.
      const published = await postJson(`${baseUrl}/skills/sync/shared/publish?${cwdQuery}`, {
        includeUserRoot: false,
        selectedSkillIds: selected,
        allowNewSkills: true,
        publishArtifacts: false,
      });
      assert.equal(published.snapshots.length, 1);
      assert.equal(published.skills.some((skill) => skill.id === "shared-explicit"), true);

      const afterPolicy = await getJson(`${baseUrl}/skills/source-upgrade-policy?${cwdQuery}`);
      assert.equal(afterPolicy.policy.mode, "auto-safe");
      const status = await getJson(`${baseUrl}/skills/sync/gstack/status?${cwdQuery}`);
      assert.equal(status.status, "ready");
      assert.equal(status.source.revision, undefined);
    });
  });
});
