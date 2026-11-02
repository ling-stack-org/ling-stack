import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { captureWorkflowBranchResult } from "../../dist/features/channels/workflow-branch-result.js";
import { createWorkflowGitWorktree, inspectWorkflowGitRepository, planWorkflowGitWorktree }
  from "../../dist/features/workspaces/workflow-git-repository.js";

const exec = promisify(execFile);
export const nativeGit = { skip: !["darwin", "linux"].includes(process.platform) };

export function resultJournal() {
  const intents = [], receipts = [], merges = [];
  return { intents, receipts, merges,
    recordIntent: async effect => { intents.push(structuredClone(effect)); return `intent-${intents.length}`; },
    recordReceipt: async receipt => { receipts.push(structuredClone(receipt)); },
    recordMergeIntent: async effect => { merges.push({ effect: structuredClone(effect) }); return `merge-${merges.length}`; },
    recordMergeReceipt: async receipt => { merges.find(entry => entry.effect.sequence === receipt.effect.sequence).receipt = structuredClone(receipt); },
  };
}

export async function workflowGitResultsFixture(t, options = {}) {
  const base = await mkdtemp(join(await realpath(tmpdir()), "ling-workflow-results-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "repository"), worktreeRoot = join(base, "worktrees");
  await mkdir(root); await mkdir(worktreeRoot);
  const gitAt = async (cwd, args, input) => {
    const running = exec("/usr/bin/git", args, { cwd, encoding: "buffer", maxBuffer: 8 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", HOME: base, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@ling.invalid", GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@ling.invalid" } });
    running.child?.stdin?.end(input);
    return (await running).stdout;
  };
  const git = async (...args) => (await gitAt(root, args)).toString().trim();
  await git("init", "--initial-branch=main");
  for (const [path, content] of Object.entries({ "owned.txt": "base\n", "delete.txt": "delete me\n", "mode.sh": "#!/bin/sh\ntrue\n", ...options.files })) {
    await writeFile(join(root, path), content);
    await git("add", "--", path);
  }
  await git("commit", "-m", "initial");
  await options.configure?.({ root, base, git });
  const repository = await inspectWorkflowGitRepository(root);
  const branch = async (stepId = "step-one", allowedPaths = ["owned.txt", "delete.txt", "mode.sh", "new.txt"]) => {
    const scope = await planWorkflowGitWorktree({ repository, worktreeRoot, roundId: "round-one", stepId, generation: 1 });
    const receipt = await createWorkflowGitWorktree(scope);
    const lineage = { workflowId: "workflow-one", canonicalWorkspaceId: "workspace-one", canonicalWorkspaceRoot: root,
      planId: `plan-${stepId}`, planDigest: `plan-digest-${stepId}`, bindingId: `binding-${stepId}`, bindingRevision: 1,
      runId: `run-${stepId}`, workUnitId: `unit-${stepId}`, attemptId: `attempt-${stepId}`, runtimeInstanceId: "runtime-one",
      fencingToken: `fence-${stepId}`, startOwner: { schemaVersion: 1, taskId: `task-${stepId}`, leaseId: `lease-${stepId}`,
        phase: "linked", authorityBasis: `wso1_${"a".repeat(64)}` } };
    const context = { scope, receipt, lineage, allowedPaths };
    const terminal = { lineage, outcome: "succeeded", terminalArtifactRef: `terminal-${stepId}`, quiescenceArtifactRef: `drain-${stepId}`,
      toolCompletionArtifactRef: `tools-${stepId}`, outputPacketArtifactRef: `output-${stepId}`, contextArtifactRefs: [`context-${stepId}`],
      validations: [{ id: "branch-test", command: ["node", "--test"], executionRoot: scope.executionRoot,
        inputScopeDigest: `scope-${stepId}`, exitCode: 0, artifactRef: `validation-${stepId}` }], unknownEffects: [] };
    const journal = resultJournal();
    const assertTerminalQuiescent = async () => structuredClone(terminal);
    const capture = overrides => captureWorkflowBranchResult({ ...context, assertTerminalQuiescent, journal, ...overrides });
    const originalIndex = await readFile(join((await inspectWorkflowGitRepository(scope.executionRoot)).gitDir, "index"));
    return { ...context, terminal, journal, capture, originalIndex, assertTerminalQuiescent,
      git: async (...args) => (await gitAt(scope.executionRoot, args)).toString().trim() };
  };
  return { base, root, worktreeRoot, repository, gitAt, git, branch };
}
