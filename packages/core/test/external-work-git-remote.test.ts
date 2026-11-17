import assert from "node:assert/strict";
import { test } from "node:test";
import { ExternalWorkflowValidationError, normalizeGitRemoteUrl, parseExternalWorkflowMarkdown } from "../dist/external-work.js";

function fixtureBasicAuthUrl(user: string, password: string): string {
  return `https://${[user, password].join(":")}@git.example.com/repo.git`;
}

function workflowWithRemote(remote: unknown, sourceKind = "github"): string {
  return `---
source:
  kind: ${sourceKind}
  repository: owner/repo
  projectSlug: project
workspace:
  gitRemoteUrl: ${JSON.stringify(remote)}
---
Review {{ item.identifier }}.
`;
}

test("checkout hints accept HTTPS and SSH transports independently of source identity", () => {
  const remotes = [
    "git@github.com:owner/repo.git",
    "git@gitlab.com:group/subgroup/project.git",
    "git@[2001:db8::1]:owner/repo.git",
    "ssh://git@git.example.com:2222/owner/repo.git",
    "https://git.example.com/group/project.git",
  ];
  for (const remote of remotes) {
    assert.equal(normalizeGitRemoteUrl(` ${remote} `), remote);
    for (const sourceKind of ["github", "linear"]) {
      const workflow = parseExternalWorkflowMarkdown(workflowWithRemote(remote, sourceKind));
      assert.equal(workflow.config.workspace.gitRemoteUrl, remote);
      assert.equal(workflow.config.source.kind, sourceKind);
      assert.equal(workflow.config.source.repository, "owner/repo");
    }
  }
  assert.throws(() => parseExternalWorkflowMarkdown(workflowWithRemote(remotes[1], "gitlab")), /Unsupported external source kind/);
  const existing = parseExternalWorkflowMarkdown("---\nsource:\n  kind: github\n  repository: owner/repo\n---\nReview.");
  assert.equal(existing.config.workspace.gitRemoteUrl, undefined);
});

test("invalid checkout hints fail without echoing the remote or embedded secrets", () => {
  const invalid = [
    "", "   ", "file:///tmp/repo.git", "/tmp/repo.git", "../repo", "ftp://git.example.com/repo.git",
    "https:/git.example.com/repo.git", "ssh://git.example.com", "https://git.example.com/",
    fixtureBasicAuthUrl("fixture-user", "fixture-password"),
    "https://fixture-password@git.example.com/repo.git",
    "ssh://git:fixture-password@git.example.com/repo.git",
    "https://git.example.com/repo.git?access_token=fixture-password",
    "https://git.example.com/repo.git?%74oken=fixture-password",
    "https://git.example.com/repo.git#fixture-password",
    "git@git.example.com:repo.git\n", "\tgit@git.example.com:repo.git", "git@git.example.com:repo\u0000.git",
    "git@git.example.com:repo with spaces.git", "git@git.example.com:repo.git;touch sentinel",
    "git@git.example.com:repo.git&&touch", "git@git.example.com:$(touch)", "git@-oProxyCommand:repo.git",
    "ssh://-oProxyCommand@git.example.com/repo.git", "https://git.example.com\\repo.git",
  ];
  for (const remote of invalid) {
    assert.throws(() => parseExternalWorkflowMarkdown(workflowWithRemote(remote)), (error: unknown) => {
      assert.ok(error instanceof ExternalWorkflowValidationError, remote);
      assert.match(error.message, /workspace\.gitRemoteUrl/, remote);
      assert.doesNotMatch(error.message, /fixture-password/);
      return true;
    }, remote);
  }
  assert.throws(() => parseExternalWorkflowMarkdown(workflowWithRemote(42)), /workspace\.gitRemoteUrl must be a string/);
});
