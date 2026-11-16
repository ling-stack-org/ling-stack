import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { promisify } from "node:util";
import { captureCodeAssessmentSnapshot } from "../dist/features/code-assessments/snapshot.js";

const exec = promisify(execFile);
async function repo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "ling-snapshot-boundary-"));
  await exec("git", ["init", "-q", "-b", "main"], { cwd });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd });
  await exec("git", ["config", "user.name", "Ling Test"], { cwd });
  await writeFile(join(cwd, "app.ts"), "export const value = 1;\n");
  await exec("git", ["add", "."], { cwd }); await exec("git", ["commit", "-qm", "initial"], { cwd });
  return cwd;
}

async function wrappedGit(cwd: string, behavior: "move" | "metadata_timeout" | "diff_timeout", run: (statePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ling-assessment-git-wrapper-"));
  const realGit = (await exec("/usr/bin/which", ["git"])).stdout.trim();
  const statePath = join(directory, "state.json");
  const wrapper = join(directory, "git");
  const priorPath = process.env.PATH;
  const source = `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
const behavior = ${JSON.stringify(behavior)};
const metadata = args.includes('--name-only');
const diff = args.includes('diff') && args.includes('--unified=3');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { captures: 0, blocked: false };
if (metadata) state.captures++;
if (behavior === 'move' && metadata && state.captures === 2) fs.writeFileSync(${JSON.stringify(join(cwd, "app.ts"))}, 'export const value = 3;\\n');
if (behavior === 'metadata_timeout' && metadata || behavior === 'diff_timeout' && diff) {
  state.blocked = true;
  fs.writeFileSync(statePath, JSON.stringify(state));
  setInterval(() => {}, 1000);
} else {
  fs.writeFileSync(statePath, JSON.stringify(state));
  const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
  process.exit(result.status === null ? 1 : result.status);
}
`;
  await writeFile(wrapper, source); await chmod(wrapper, 0o755);
  process.env.PATH = `${directory}:${priorPath ?? ""}`;
  try { await run(statePath); }
  finally { if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath; await rm(directory, { recursive: true, force: true }); }
}

test("capture includes at most 80 paths and explicitly excludes the remaining file", async () => {
  const cwd = await repo();
  try {
    await Promise.all(Array.from({ length: 81 }, (_, index) => writeFile(join(cwd, `file_${String(index).padStart(3, "0")}.ts`), "export const added = true;\n")));
    const snapshot = await captureCodeAssessmentSnapshot(cwd, { type: "working_tree" });
    assert.equal(snapshot.totalFileCount, 81);
    assert.equal(snapshot.files.length, 80);
    assert.deepEqual(snapshot.exclusions, [{ path: "file_080.ts", reason: "budget" }]);
    assert.equal(snapshot.coverage, "partial");
    assert.equal(snapshot.files.at(-1)?.path, "file_079.ts");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("aggregate Diff bytes stay within 256 KiB while individual source files remain eligible", async () => {
  const cwd = await repo();
  try {
    for (const [index, size] of [88000, 88000, 85000, 1024].entries()) await writeFile(join(cwd, `file_${index}.ts`), `${"x".repeat(size)}\n`);
    const snapshot = await captureCodeAssessmentSnapshot(cwd, { type: "working_tree" });
    const bytes = snapshot.files.reduce((sum, file) => sum + Buffer.byteLength(file.diff, "utf8"), 0);
    assert.equal(snapshot.files.length, 3);
    assert.ok(bytes > 260000 && bytes <= 256 * 1024, String(bytes));
    assert.deepEqual(snapshot.exclusions, [{ path: "file_3.ts", reason: "budget" }]);
    assert.equal(snapshot.coverage, "partial");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("a real edit between the two captures rejects the moving snapshot", async () => {
  const cwd = await repo();
  try {
    await writeFile(join(cwd, "app.ts"), "export const value = 2;\n");
    await wrappedGit(cwd, "move", async statePath => {
      await assert.rejects(captureCodeAssessmentSnapshot(cwd, { type: "working_tree" }), /repository changed during capture/u);
      assert.equal(JSON.parse(await readFile(statePath, "utf8")).captures, 2);
      assert.equal(await readFile(join(cwd, "app.ts"), "utf8"), "export const value = 3;\n");
    });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

for (const behavior of ["metadata_timeout", "diff_timeout"] as const) {
  test(`capture rejects ${behavior} at the production Git timeout`, { timeout: 30000 }, async () => {
    const cwd = await repo();
    try {
      await writeFile(join(cwd, "app.ts"), "export const value = 2;\n");
      await wrappedGit(cwd, behavior, async statePath => {
        const started = performance.now();
        await assert.rejects(captureCodeAssessmentSnapshot(cwd, { type: "working_tree" }), error => {
          if (behavior === "metadata_timeout") return Boolean(error && typeof error === "object" && "killed" in error && error.killed);
          return error instanceof Error && /git diff exited with code unknown/u.test(error.message);
        });
        const elapsedMs = performance.now() - started;
        assert.ok(elapsedMs >= 14500 && elapsedMs < 25000, String(elapsedMs));
        assert.equal(JSON.parse(await readFile(statePath, "utf8")).blocked, true);
      });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}
