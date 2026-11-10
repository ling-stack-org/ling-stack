import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

function jobSource(id) {
  const match = new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, "mu").exec(workflow);
  assert.ok(match, `Missing job ${id}`);
  return match[1];
}

// Value: protects=CI exercises frozen controls and real packed SDKs without user state;
// fails_when=history, fresh builds, external outputs or required aggregation are removed;
// why_new=the offline assurance CLI now owns a required CI lane; seam=none
test("assurance keeps frozen history and the pinned offline-capable toolchain", () => {
  const source = jobSource("framework-assurance");
  assert.match(source, /^    needs: scope$/mu);
  assert.match(source, /execution-tier == 'complete' && needs\.scope\.outputs\.mode != 'docs'/u);
  assert.match(source, /^    runs-on: ubuntu-latest$/mu);
  assert.match(source, /^    timeout-minutes: 20$/mu);
  assert.match(source, /fetch-depth: 0/u);
  assert.match(source, /persist-credentials: false/u);
  assert.match(source, /node-version: 22\.22\.1/u);
  assert.match(source, /version: 10\.0\.0/u);
  assert.match(source, /pnpm install --frozen-lockfile --prefer-offline/u);
  assert.doesNotMatch(source, /continue-on-error|secrets\.|download-artifact|--reuse|--skip-build/u);
});

test("assurance runs both zero-model commands in an external output tree", () => {
  const source = jobSource("framework-assurance");
  assert.match(source, /run: node --test scripts\/framework-assurance\/\*\.test\.mjs/u);
  for (const [command, directory] of [["calibrate", "offline"], ["sdk-consumer", "sdk"]]) {
    assert.ok(source.includes(`run: node scripts/framework-assurance/index.mjs ${command} --output "$RUNNER_TEMP/ling-framework-assurance/${directory}"`));
  }
  assert.match(jobSource("quality"), /needs: \[[^\n]*framework-assurance[^\n]*\]/u);
  assert.match(jobSource("quality"), /ASSURANCE_RESULT: \$\{\{ needs\.framework-assurance\.result \}\}/u);
});

test("assurance retains bounded reports on failure without uploading installed toolchains", () => {
  const source = jobSource("framework-assurance");
  const upload = source.slice(source.indexOf("      - name: Preserve assurance reports"));
  assert.match(upload, /if: always\(\)/u);
  assert.match(upload, /if-no-files-found: error/u);
  assert.match(upload, /retention-days: 7/u);
  assert.ok(upload.includes("/offline/*.json"));
  assert.ok(upload.includes("/sdk/sdk-consumer.json"));
  assert.ok(upload.includes("/sdk/sdk-consumer-*/sdk-consumer-report.json"));
  assert.ok(upload.includes("/sdk/sdk-consumer-*/*.log"));
  assert.doesNotMatch(upload, /node_modules|toolchain|\.tgz|path: \$\{\{ runner\.temp \}\}\/ling-framework-assurance\/\*\*/u);
});
