import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const helperUrl = new URL("../scripts/packaged-human-qa-lane.mjs", import.meta.url);
const base = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).build;

test("fixed Human QA lane preserves the ordinary build when absent", async () => {
  const { selectPackagedOfficeBuildLane } = await import(helperUrl.href);
  assert.equal(selectPackagedOfficeBuildLane(base, {}), base);
});

test("Human QA has a distinct identity and output, preserving all evidence/signing hooks", async () => {
  const { selectPackagedOfficeBuildLane } = await import(helperUrl.href);
  const snapshot = structuredClone(base);
  const selected = selectPackagedOfficeBuildLane(base, { LING_DESKTOP_PACKAGE_HUMAN_QA: "1" });
  assert.equal(selected.appId, "com.lingstack.desktop.human-qa");
  assert.equal(selected.productName, "Ling Stack Human QA");
  assert.equal(selected.directories.output, "release/human-qa");
  assert.deepEqual(selected.extraMetadata.lingHumanQaPackage, {
    schemaVersion: 1, purpose: "synthetic-human-evaluation", release: false,
  });
  for (const field of ["afterPack", "afterSign", "artifactBuildCompleted", "mac", "files", "extraResources", "electronFuses"]) {
    assert.deepEqual(selected[field], base[field]);
  }
  assert.deepEqual(base, snapshot);
  assert.notEqual(selected, base);
  assert.notEqual(selected.directories, base.directories);
  assert.equal(selected.directories.buildResources, base.directories.buildResources);
});

test("QA selection rejects unsupported values and foreign base identities", async () => {
  const { selectPackagedOfficeBuildLane } = await import(helperUrl.href);
  for (const value of ["", "0", "true", "release", undefined]) {
    assert.throws(() => selectPackagedOfficeBuildLane(base, { LING_DESKTOP_PACKAGE_HUMAN_QA: value }),
      /packaged_human_qa_lane_invalid/u);
  }
  for (const changed of [{ appId: "foreign.app" }, { productName: "Foreign" }]) {
    assert.throws(() => selectPackagedOfficeBuildLane({ ...base, ...changed }, { LING_DESKTOP_PACKAGE_HUMAN_QA: "1" }),
      /packaged_human_qa_base_invalid/u);
  }
});
