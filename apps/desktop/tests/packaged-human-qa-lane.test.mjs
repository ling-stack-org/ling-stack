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

test("retained-host R03 successor has fixed disjoint output and preserves the ordinary QA lane", async () => {
  const { readPackagedOfficeBuildLane, readPackagedOfficeHumanQaSelection, selectPackagedOfficeBuildLane } = await import(helperUrl.href);
  const environment = { LING_DESKTOP_PACKAGE_HUMAN_QA: "retained-host-r03" };
  const snapshot = structuredClone(base);
  const selected = selectPackagedOfficeBuildLane(base, environment);
  const ordinaryQa = selectPackagedOfficeBuildLane(base, { LING_DESKTOP_PACKAGE_HUMAN_QA: "1" });
  assert.equal(readPackagedOfficeBuildLane(environment), "human-qa-r03-successor");
  assert.equal(readPackagedOfficeHumanQaSelection(environment), true);
  assert.equal(selected.appId, "com.lingstack.desktop.human-qa.r03-successor");
  assert.equal(selected.productName, "Ling Stack R03 Successor QA");
  assert.equal(selected.directories.output, "release/human-qa-r03-successor");
  for (const field of ["appId", "productName"]) assert.notEqual(selected[field], ordinaryQa[field]);
  assert.notEqual(selected.directories.output, ordinaryQa.directories.output);
  for (const field of ["afterPack", "afterSign", "artifactBuildCompleted", "mac", "files", "extraResources", "electronFuses"]) {
    assert.deepEqual(selected[field], base[field]);
  }
  assert.deepEqual(selected.extraMetadata.lingHumanQaPackage, ordinaryQa.extraMetadata.lingHumanQaPackage);
  assert.deepEqual(base, snapshot);
});

test("retained-host R03 observation has a fixed third output without changing either retained QA identity", async () => {
  const { readPackagedOfficeBuildLane, readPackagedOfficeHumanQaSelection, selectPackagedOfficeBuildLane } = await import(helperUrl.href);
  const environment = { LING_DESKTOP_PACKAGE_HUMAN_QA: "retained-host-r03-observation" };
  const snapshot = structuredClone(base);
  const selected = selectPackagedOfficeBuildLane(base, environment);
  assert.equal(readPackagedOfficeBuildLane(environment), "human-qa-r03-observation");
  assert.equal(readPackagedOfficeHumanQaSelection(environment), true);
  assert.equal(selected.appId, "com.lingstack.desktop.human-qa.r03-observation");
  assert.equal(selected.productName, "Ling Stack R03 Observation QA");
  assert.equal(selected.directories.output, "release/human-qa-r03-observation");
  for (const selector of ["1", "retained-host-r03"]) {
    const retained = selectPackagedOfficeBuildLane(base, { LING_DESKTOP_PACKAGE_HUMAN_QA: selector });
    for (const field of ["appId", "productName"]) assert.notEqual(selected[field], retained[field]);
    assert.notEqual(selected.directories.output, retained.directories.output);
    assert.deepEqual(selected.extraMetadata.lingHumanQaPackage, retained.extraMetadata.lingHumanQaPackage);
  }
  for (const field of ["afterPack", "afterSign", "artifactBuildCompleted", "mac", "files", "extraResources", "electronFuses"]) {
    assert.deepEqual(selected[field], base[field]);
  }
  assert.equal(selected.directories.buildResources, base.directories.buildResources);
  assert.deepEqual(base, snapshot);
  for (const changed of [{ appId: "foreign.app" }, { productName: "Foreign" }]) {
    assert.throws(() => selectPackagedOfficeBuildLane({ ...base, ...changed }, environment), /packaged_human_qa_base_invalid/u);
  }
});

test("QA lane accepts no caller-chosen output or successor name", async () => {
  const { readPackagedOfficeBuildLane } = await import(helperUrl.href);
  assert.equal(readPackagedOfficeBuildLane({}), "ordinary");
  assert.equal(readPackagedOfficeBuildLane({ LING_DESKTOP_PACKAGE_HUMAN_QA: "1" }), "human-qa");
  for (const value of ["retained-host-r03/../human-qa", "release/human-qa-r03-successor", "r03", "retained-host-r04",
    "retained-host-r03-observation/../human-qa", "release/human-qa-r03-observation", "human-qa-r03-observation", "retained-host-r03-observation "]) {
    assert.throws(() => readPackagedOfficeBuildLane({ LING_DESKTOP_PACKAGE_HUMAN_QA: value }), /human_qa_lane_invalid/u);
  }
});

test("integrated-main QA has a fourth fixed identity without replacing retained Hosts' Apps", async () => {
  const { readPackagedOfficeBuildLane, readPackagedOfficeHumanQaSelection, selectPackagedOfficeBuildLane } = await import(helperUrl.href);
  const environment = { LING_DESKTOP_PACKAGE_HUMAN_QA: "integrated-main" };
  const snapshot = structuredClone(base);
  const selected = selectPackagedOfficeBuildLane(base, environment);
  assert.equal(readPackagedOfficeBuildLane(environment), "human-qa-integrated-main");
  assert.equal(readPackagedOfficeHumanQaSelection(environment), true);
  assert.equal(selected.appId, "com.lingstack.desktop.human-qa.integrated-main");
  assert.equal(selected.productName, "Ling Stack Integrated Main QA");
  assert.equal(selected.directories.output, "release/human-qa-integrated-main");
  for (const selector of ["1", "retained-host-r03", "retained-host-r03-observation"]) {
    const retained = selectPackagedOfficeBuildLane(base, { LING_DESKTOP_PACKAGE_HUMAN_QA: selector });
    for (const field of ["appId", "productName"]) assert.notEqual(selected[field], retained[field]);
    assert.notEqual(selected.directories.output, retained.directories.output);
    assert.deepEqual(selected.extraMetadata.lingHumanQaPackage, retained.extraMetadata.lingHumanQaPackage);
  }
  for (const field of ["afterPack", "afterSign", "artifactBuildCompleted", "mac", "files", "extraResources", "electronFuses"]) {
    assert.deepEqual(selected[field], base[field]);
  }
  assert.equal(selected.directories.buildResources, base.directories.buildResources);
  assert.deepEqual(base, snapshot);
  for (const changed of [{ appId: "foreign.app" }, { productName: "Foreign" }]) {
    assert.throws(() => selectPackagedOfficeBuildLane({ ...base, ...changed }, environment), /packaged_human_qa_base_invalid/u);
  }
  for (const value of ["integrated-main ", "integrated-main/../human-qa", "human-qa-integrated-main", "release/human-qa-integrated-main"]) {
    assert.throws(() => readPackagedOfficeBuildLane({ LING_DESKTOP_PACKAGE_HUMAN_QA: value }), /human_qa_lane_invalid/u);
  }
});
