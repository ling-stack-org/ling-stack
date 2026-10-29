import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

async function withDaemon(cwd, fn) {
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await daemon.stop();
  }
}

async function writeSharedSkill(skillRoot, skillId, markdown, reference = "# Checklist\n") {
  const skillDir = resolve(skillRoot, skillId);
  await mkdir(resolve(skillDir, "references"), { recursive: true });
  await writeFile(resolve(skillDir, "SKILL.md"), markdown);
  await writeFile(resolve(skillDir, "references", "checklist.md"), reference);
}

function skillMarkdown(description, body = "Validate the change.") {
  return ["---", "name: shared-qa", `description: ${description}`, "---", "# Shared QA", body].join("\n");
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

test("shared .agents/skills scan exposes candidates and publishes through the existing sync flow", async () => {
  await withTempDir("ling-shared-api-cwd-", async (cwd) => {
    await withTempDir("ling-shared-api-home-", async (homeDir) => {
      await writeSharedSkill(
        resolve(cwd, ".agents", "skills"),
        "shared-qa",
        skillMarkdown("Run shared QA checks."),
      );
      await withDaemon(cwd, async (baseUrl) => {
        const cwdQuery = `cwd=${encodeURIComponent(cwd)}`;
        const previewUrl = `${baseUrl}/skills/sync/shared/preview?${cwdQuery}`;
        const publishUrl = `${baseUrl}/skills/sync/shared/publish?${cwdQuery}`;
        const previewBody = { includeUserRoot: false };

        // Candidates are display-ready and grouped by auto-detected root.
        const scanned = await postJson(previewUrl, previewBody);
        assert.equal(scanned.cwd, cwd);
        assert.ok(scanned.scannedAt);
        assert.equal(scanned.preview.roots.length, 1);
        assert.equal(scanned.preview.roots[0].id, "shared-agents-workspace");
        assert.equal(scanned.preview.roots[0].rootPath, resolve(cwd, ".agents", "skills"));
        assert.equal(scanned.preview.roots[0].sourceKind, "workspace-skill-directory");
        assert.equal(scanned.preview.roots[0].label, "Project shared .agents skill root");
        const candidate = scanned.preview.records.find((record) => record.skillId === "shared-qa");
        assert.ok(candidate);
        assert.equal(candidate.state, "new");
        assert.equal(candidate.sourceKind, "workspace-skill-directory");
        assert.equal(candidate.frontMatter.description, "Run shared QA checks.");
        assert.equal(candidate.definitionPreview.name, "shared-qa");
        assert.equal(scanned.preview.summary.new, 1);

        // Selecting an unknown id is rejected by the shared sync contract.
        const missingSelection = await postRaw(publishUrl, {
          ...previewBody,
          selectedSkillIds: ["not-in-preview"],
        });
        assert.equal(missingSelection.status, 400);
        assert.match(await missingSelection.text(), /skill_source_sync_selection_not_found/);

        // A brand new skill still needs explicit confirmation.
        const missingConfirmation = await postRaw(publishUrl, {
          ...previewBody,
          selectedSkillIds: ["shared-qa"],
        });
        assert.equal(missingConfirmation.status, 409);
        assert.match(await missingConfirmation.text(), /skill_source_sync_new_skills_require_confirmation/);

        const published = await postJson(publishUrl, {
          ...previewBody,
          selectedSkillIds: ["shared-qa"],
          allowNewSkills: true,
          publishArtifacts: true,
        });
        assert.ok(published.publishedAt);
        assert.equal(published.snapshots.length, 1);
        assert.equal(published.snapshots[0].skillId, "shared-qa");
        assert.equal(published.snapshots[0].sourceKind, "workspace-skill-directory");
        assert.equal(published.snapshots[0].upstreamName, "shared-qa");
        assert.equal(published.snapshots[0].reviewStatus, "published");
        assert.equal(published.artifacts.some((artifact) => artifact.path === "SKILL.md"), true);
        assert.equal(published.artifacts.some((artifact) => artifact.path === "references/checklist.md"), true);
        assert.equal(published.skills.some((skill) => skill.id === "shared-qa"), true);
        const publishedSkill = published.skills.find((skill) => skill.id === "shared-qa");
        assert.equal(publishedSkill.source, "skill-directory");
        assert.equal(publishedSkill.packId, "shared-skill-source-sync");

        const listed = await getJson(`${baseUrl}/skills?${cwdQuery}`);
        assert.equal(listed.skills.some((skill) => skill.id === "shared-qa"), true);

        // The official P16 source contract is untouched by shared publishes.
        const officialStatus = await getJson(`${baseUrl}/skills/sync/gstack/status?${cwdQuery}`);
        assert.equal(officialStatus.status, "ready");
        assert.equal(officialStatus.source.revision, undefined);

        // Re-scanning an unchanged source reports unchanged, then drift after an edit.
        const unchanged = await postJson(previewUrl, previewBody);
        assert.equal(unchanged.preview.records.find((record) => record.skillId === "shared-qa").state, "unchanged");

        await writeSharedSkill(
          resolve(cwd, ".agents", "skills"),
          "shared-qa",
          skillMarkdown("Run shared QA checks.", "Validate the change and report blockers."),
        );
        const drifted = await postJson(previewUrl, previewBody);
        const driftedCandidate = drifted.preview.records.find((record) => record.skillId === "shared-qa");
        assert.equal(driftedCandidate.state, "drifted");
        assert.equal(driftedCandidate.existingSnapshotId, published.snapshots[0].id);
        assert.equal(driftedCandidate.diff.some((item) => item.field === "sourceChecksum"), true);
      });
    });
  });
});

test("shared scan detects the user .agents/skills root and ignores arbitrary path input", async () => {
  await withTempDir("ling-shared-user-cwd-", async (cwd) => {
    await withTempDir("ling-shared-user-home-", async (homeDir) => {
      const previousHome = process.env.HOME;
      const previousLingStackHome = process.env.LING_STACK_HOME;
      process.env.HOME = homeDir;
      process.env.LING_STACK_HOME = resolve(homeDir, ".ling-stack");
      try {
        await writeSharedSkill(
          resolve(homeDir, ".agents", "skills"),
          "user-shared-skill",
          ["---", "name: user-shared-skill", "description: Shared across projects.", "---", "# User shared", "Read the checklist."].join("\n"),
        );
        const arbitraryRoot = resolve(cwd, "external-skills");
        await writeSharedSkill(arbitraryRoot, "arbitrary-skill", skillMarkdown("Should never be scanned."));

        await withDaemon(cwd, async (baseUrl) => {
          const cwdQuery = `cwd=${encodeURIComponent(cwd)}`;
          const previewUrl = `${baseUrl}/skills/sync/shared/preview?${cwdQuery}`;

          const userOnly = await postJson(previewUrl, { includeProjectRoot: false });
          assert.deepEqual(userOnly.preview.roots.map((root) => root.id), ["shared-agents-user"]);
          assert.equal(userOnly.preview.roots[0].rootPath, resolve(homeDir, ".agents", "skills"));
          assert.equal(userOnly.preview.roots[0].label, "User shared .agents skill root");
          assert.equal(userOnly.preview.records.some((record) => record.skillId === "user-shared-skill"), true);

          // Unknown request fields cannot add source roots: only the fixed shared locations scan.
          const withArbitraryInput = await postJson(previewUrl, {
            includeProjectRoot: false,
            skillRoots: [arbitraryRoot],
            gstackRepoRoots: [arbitraryRoot],
            codexSkillRoots: [arbitraryRoot],
            roots: [{ id: "injected", rootPath: arbitraryRoot, sourceKind: "workspace-skill-directory" }],
          });
          assert.deepEqual(withArbitraryInput.preview.roots.map((root) => root.id), ["shared-agents-user"]);
          assert.equal(withArbitraryInput.preview.records.some((record) => record.skillId === "arbitrary-skill"), false);
        });
      } finally {
        if (previousHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = previousHome;
        }
        if (previousLingStackHome === undefined) {
          delete process.env.LING_STACK_HOME;
        } else {
          process.env.LING_STACK_HOME = previousLingStackHome;
        }
      }
    });
  });
});

test("shared scan returns an empty preview instead of failing when no shared directory exists", async () => {
  await withTempDir("ling-shared-empty-cwd-", async (cwd) => {
    await withDaemon(cwd, async (baseUrl) => {
      const cwdQuery = `cwd=${encodeURIComponent(cwd)}`;
      const preview = await postJson(`${baseUrl}/skills/sync/shared/preview?${cwdQuery}`, {
        includeProjectRoot: true,
        includeUserRoot: false,
      });
      assert.deepEqual(preview.preview.roots, []);
      assert.deepEqual(preview.preview.records, []);
      assert.equal(preview.preview.summary.totalRecords, 0);
    });
  });
});
