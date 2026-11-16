import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(new URL("../../.github/workflows/desktop-release.yml", import.meta.url), "utf8");
const reusableWorkflow = await readFile(new URL("../../.github/workflows/desktop-prerelease.yml", import.meta.url), "utf8");
const releasePolicy = await readFile(new URL("../../docs/release/README.md", import.meta.url), "utf8");

test("tag release workflow delegates to the reviewed desktop candidate build", () => {
  assert.match(workflow, /tags:\n\s+- ["']v\*\.\*\.\*["']/u);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/desktop-prerelease\.yml/u);
  assert.match(workflow, /operation: build/u);
  assert.match(workflow, /create_draft: true/u);
  assert.match(workflow, /permissions:\n\s+contents: write/u);
});

test("candidate workflow accepts reusable calls and tag-triggered publication while keeping publication as Draft", () => {
  assert.match(reusableWorkflow, /workflow_call:/u);
  assert.doesNotMatch(reusableWorkflow, /github\.event_name == 'push'/u);
  assert.equal((reusableWorkflow.match(/path: \.trusted-main/gu) ?? []).length, 2);
  assert.match(reusableWorkflow, /import \{ readCandidate \} from "\.\/\.trusted-main\/scripts\/release\/desktop-release\.mjs"/u);
  assert.equal((reusableWorkflow.match(/DESKTOP_ALLOW_EXISTING_TAG: \$\{\{ startsWith\(github\.ref, 'refs\/tags\/v'\) \}\}/gu) ?? []).length, 2);
  assert.match(reusableWorkflow, /node \.trusted-main\/scripts\/release\/desktop-release\.mjs assemble/u);
  assert.match(reusableWorkflow, /node \.trusted-main\/scripts\/release\/create-desktop-draft\.mjs/u);
  assert.doesNotMatch(reusableWorkflow, /\n\s+node scripts\/release\/(?:desktop-release|create-desktop-draft)\.mjs/u);
  assert.match(reusableWorkflow, /contents: write/u);
  assert.match(releasePolicy, /Release remains an explicit maintainer action/u);
});
