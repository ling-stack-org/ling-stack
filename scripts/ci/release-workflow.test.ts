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
  assert.match(reusableWorkflow, /if: github\.event_name != 'pull_request' \|\|/u);
  assert.match(reusableWorkflow, /if: inputs\.operation == 'build' && inputs\.create_draft/u);
  assert.equal((reusableWorkflow.match(/path: \.trusted-main/gu) ?? []).length, 2);
  assert.match(reusableWorkflow, /import \{ readCandidate \} from "\.\/\.trusted-main\/scripts\/release\/desktop-release\.mjs"/u);
  assert.equal((reusableWorkflow.match(/DESKTOP_ALLOW_EXISTING_TAG: \$\{\{ startsWith\(github\.ref, 'refs\/tags\/v'\) \}\}/gu) ?? []).length, 2);
  assert.match(reusableWorkflow, /node \.trusted-main\/scripts\/release\/desktop-release\.mjs assemble/u);
  assert.match(reusableWorkflow, /node \.trusted-main\/scripts\/release\/create-desktop-draft\.mjs/u);
  assert.doesNotMatch(reusableWorkflow, /\n\s+node scripts\/release\/(?:desktop-release|create-desktop-draft)\.mjs/u);
  assert.match(reusableWorkflow, /contents: write/u);
  assert.match(releasePolicy, /Release remains an explicit maintainer action/u);
});

test("the hosted candidate assembles prepared inputs through the same native packagers as local builds", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../apps/desktop/package.json", import.meta.url), "utf8"));
  const steps = [...reusableWorkflow.matchAll(/^      - name: (.+)\n([\s\S]*?)(?=^      - |^  draft:)/gmu)];
  const preparationIndex = steps.findIndex(([, name]) => name === "Build workspace dependencies for the Desktop candidate");
  const nativeIndex = steps.findIndex(([, name]) => name === "Build native inputs before collecting their locked source and notices");
  const materialsIndex = steps.findIndex(([, name]) => name === "Generate version-matched notices, original licenses and SBOM");
  const assemblyIndex = steps.findIndex(([, name]) => name === "Assemble the native unsigned development candidate from prepared inputs");
  const verificationIndex = steps.findIndex(([, name]) => name === "Verify actual final archives, bundled resources and runtime structure");
  assert.ok(preparationIndex >= 0 && preparationIndex < nativeIndex && nativeIndex < materialsIndex
    && materialsIndex < assemblyIndex && assemblyIndex < verificationIndex);

  const assembly = steps[assemblyIndex][2];
  const commands = assembly.split("\n").map(line => line.trim()).filter(line => line.startsWith("corepack pnpm "));
  for (const script of ["package:mac", "package:win"]) {
    const packager = manifest.scripts[script].split(" && ").at(-1);
    assert.ok(commands.includes(`corepack pnpm --filter @ling-stack/desktop exec ${packager}`), script);
  }
  assert.equal(commands.length, 2);
  assert.match(assembly, /LING_PACKAGED_RELEASE_REVIEW_REQUIRED=1/u);
});
