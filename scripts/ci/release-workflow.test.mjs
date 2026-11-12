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

test("candidate workflow accepts reusable calls and keeps publication as Draft", () => {
  assert.match(reusableWorkflow, /workflow_call:/u);
  assert.doesNotMatch(reusableWorkflow, /on:\n\s+push:/u);
  assert.doesNotMatch(reusableWorkflow, /github\.event_name == 'push'/u);
  assert.match(reusableWorkflow, /create-desktop-draft\.mjs/u);
  assert.match(reusableWorkflow, /contents: write/u);
  assert.match(releasePolicy, /Release remains an explicit maintainer action/u);
});
