# Contributing

Ling Stack is currently private, so GitHub branch protection for `main` may be
unavailable on the active GitHub plan. Until server-side protection can be enabled,
the repository uses the process rules below.

## Main Branch Policy

- Do not push feature, fix, or documentation work directly to `main`.
- Create a topic branch for every change and open a pull request before landing it.
- Merge into `main` only after the pull request has been reviewed and the relevant
  local validation has passed.
- Do not force-push `main`.
- Do not delete `main`.
- Keep unrelated dirty worktree changes out of commits.
- Use emergency direct pushes only with explicit owner approval and document the
  reason in the commit or follow-up issue.

For local work in this repository, prefer branch names with the `codex/` prefix for
Codex-generated changes.

## Pull Request Expectations

Every pull request should state:

- what changed;
- what product, runtime, API, or documentation boundary is affected;
- which validation commands were run;
- any known limitations or deferred follow-ups.

Use the narrowest validation that proves the change. For larger implementation slices,
run the relevant typecheck, tests, build, and targeted smoke checks before merging.

## Future GitHub Protection

When this repository becomes public, or when the GitHub plan supports protected
branches for this private repository, enable protection on `main` with these minimum
rules:

- require a pull request before merging;
- require at least one approval;
- dismiss stale approvals after new commits;
- require conversation resolution;
- disable force pushes;
- disable branch deletion;
- include administrators in the rule.

Do not enable required status checks until the repository has stable GitHub Actions
workflow check names. Revisit this rule after CI is added.
