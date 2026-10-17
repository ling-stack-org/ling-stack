import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { capturePreparedRunnerInput } from "../dist/features/runs/prepared-runner-input.js";
import { executeUnifiedBashTool } from "../dist/features/runs/unified-exec.js";
import { PackagedSkillRuntime, installPackagedSkillRuntime } from "../dist/features/skills/packaged-runtime.js";
import { createUnifiedExecFixture } from "./support/unified-exec-fixture.mjs";

const checksum = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;

test("unified exec launches a frozen GStack task with package-owned runtime paths", async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-packaged-exec-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const packageRoot = join(cwd, "package"), skillPath = "runtime/skills/qa/SKILL.md";
  await mkdir(join(packageRoot, "runtime/skills/qa"), { recursive: true });
  const skill = "# Packaged QA\n";
  await writeFile(join(packageRoot, skillPath), skill);
  const manifest = { deliveryStage: "executable", upstream: { revision: "1".repeat(40) }, adaptationRevision: "ling-test",
    skills: [{ id: "qa", entryPath: skillPath }], files: [{ path: skillPath, checksum: checksum(skill), sizeBytes: skill.length }] };
  const manifestBytes = JSON.stringify(manifest);
  await writeFile(join(packageRoot, "manifest.json"), manifestBytes);
  const manifestChecksum = checksum(manifestBytes);
  const context = { loaded: true, runtimeViewKind: "original_source", sourceKind: "gstack-skill-directory",
    skillId: "qa", sourceChecksum: checksum(skill), truncated: false,
    referencedFiles: [{ path: "manifest.json", checksum: manifestChecksum, kind: "other", includedInSnapshot: false }] };
  const runtime = new PackagedSkillRuntime(packageRoot, { manifest, manifestChecksum });
  const bound = runtime.bind(context);
  installPackagedSkillRuntime(runtime);

  const task = { id: "packaged-exec-task", title: "Packaged exec", prompt: "Use the packaged skill." };
  const options = { cwd, agentDir: join(cwd, "agent"), task,
    provider: { provider: "fixture", model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1", reasoning: false },
    tools: ["bash"] };
  const preparedInput = await new PiRunnerAdapter().prepareTaskInput(options);
  const runnerExecutionInput = capturePreparedRunnerInput({ runnerId: "pi", options, preparedInput, skillSourceContext: bound });
  const f = createUnifiedExecFixture(t, cwd, task, "packaged-exec-run", {
    requestSnapshot: { runnerExecutionInput },
  });
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log(JSON.stringify({root:process.env.GSTACK_ROOT,home:process.env.GSTACK_HOME,browse:process.env.BROWSE_STATE_FILE,path:process.env.PATH}))")}`;
  const result = await executeUnifiedBashTool({ ...f,
    request: { toolCallId: "packaged-env", toolName: "bash", cwd, task, input: { command, timeoutMs: 4000 } },
    appendAndMaybeStream: (type, data) => f.store.appendEvent(f.run.id, type, data) });
  assert.equal(result.isError, false, JSON.stringify(result));
  const environment = JSON.parse(result.details.unifiedExec.stdout.preview);
  assert.equal(environment.root, join(packageRoot, "runtime"));
  assert.match(environment.home, new RegExp(`^${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.ling-stack/gstack-runs/[a-f0-9]{64}$`));
  assert.equal(environment.browse, join(environment.home, "browse.json"));
  assert.ok(environment.path.startsWith(join(packageRoot, "runtime/tools")), environment.path);
});
