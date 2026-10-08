# Open-Source Readiness Checklist

Status: active publication checklist
Owner: repository maintainers
Last verified: 2026-10-08
Document type: repository governance
Code and workflow anchors: `README.md`, `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`,
`.github/workflows/ci.yml`, `.gitleaksignore`, `scripts/check-public-repo-safety.mjs`

## Publication Boundary

This checklist separates three decisions:

1. make the source repository public;
2. create a GitHub source prerelease;
3. distribute signed Desktop binaries.

Passing an earlier boundary does not authorize the next one.

## Local Repository Readiness

| Requirement | Status | Evidence or next action |
| --- | --- | --- |
| Root product README | Ready locally | Current Alpha scope, source startup, architecture, security, and support links |
| Open-source license | Ready | MIT `LICENSE` and package metadata |
| Contribution policy | Ready locally | `CONTRIBUTING.md` |
| Code of Conduct | Ready locally | Contributor Covenant 2.1 adaptation |
| Security reporting | Local policy ready; online entry deferred | `SECURITY.md` is present. Verification of the online private-reporting entry is outside the current preparation scope. |
| Support boundary | Ready locally | `SUPPORT.md` |
| Issue and PR intake | Ready locally | Issue Forms and pull request template |
| Ownership | Ready locally | `.github/CODEOWNERS` |
| Dependency updates | Ready locally | Dependabot configuration |
| Generic CI | Paused for Actions quota | Workflow configuration remains in the repository. Current preparation uses documented local checks; no online CI result is claimed. |
| Documentation links | Ready locally | `corepack pnpm check:docs` |
| Dependency licenses | Ready locally | `corepack pnpm check:licenses`; binary notices remain a separate gate |
| Current-tree safety scan | Ready locally | `corepack pnpm check:public` after personal-path cleanup |
| Main branch protection | Verification deferred | Online settings were not confirmed in this preparation pass. |
| Actions policy | File configuration present | The generic workflow has scoped permissions and pinned actions. Online organization/repository policy was not reverified. |
| Git-history secret scan | Ready locally | Gitleaks v8.30.1 scanned the source baseline reachable from `HEAD`; 32 historical fixture fingerprints are retained. See scope and exceptions below. |
| Public UI screenshots | Ready locally | New homepage capture from a fresh workspace before model configuration; historical screenshots with maintainer paths were removed in earlier cleanup. |
| Changelog and release policy | Ready locally | `CHANGELOG.md` and `docs/release/README.md`; current product version is `0.1.2-alpha.1`. |
| Source startup | Verified locally | Frozen install, CLI/daemon/Web dependency build, fresh daemon health, homepage, and Model Workbench navigation; no live model task. |
| Desktop development | Source build passed; packages pending | Mac arm64 source build passed. Mac packaging lacks the required Office review record; Windows packaging is assigned to a Windows host. See [development packages](../release/development-packages.md). |
| Asset provenance | Recorded | [Asset inventory](asset-provenance.md); maintainer confirms teammate avatars and social preview are project-made or AI-generated. |

## Online Settings And Deferred Work

CI execution is paused because of Actions quota. Branch-protection and private vulnerability
reporting verification are explicitly deferred by the maintainer for this preparation batch.
Their deferred status is not an online success claim. Revisit them during release setup.

The following remain an online configuration checklist; they were not applied by this pass:

- Verify private vulnerability reporting when the repository plan and visibility support it.
- Verify secret scanning and push protection when supported by the public repository.
- Enable dependency graph, Dependabot alerts, and security updates.
- Create a `main` ruleset requiring pull requests, review, conversation resolution, and
  the generic CI check.
- Disable force pushes and branch deletion for `main`.
- Keep default workflow token permissions read-only; grant write permissions only to a
  specific reviewed workflow job.
- Review and configure fork pull request approval before Actions run after the visibility
  change (GitHub does not expose this setting while the repository is private).
- Confirm Issues are enabled and Issue Forms render correctly.
- Set repository description, topics, website, social preview, and default branch.
- Review Actions artifact retention and repository storage limits.
- Confirm no repository or organization secret is exposed to untrusted pull requests.

These settings are online state and cannot be proven by committed files alone.

## Native Release Boundary

The public repository contains only the generic hosted CI workflow. Native Cua Driver
builds, signing, and Desktop artifact publication are intentionally kept out of this
repository because they require interactive, privileged platform hosts and private
credentials. Maintain that release lane in a separately reviewed private repository or
protected runner boundary; do not reintroduce self-hosted runner labels here.

## Legal And Distribution Review

- Keep the [asset provenance inventory](asset-provenance.md) with the source. Maintainer
  confirmation for the default avatars and social preview was recorded on 2026-10-08.
- Decide whether a trademark policy is required; the MIT License does not grant trademark
  rights.
- Confirm contributor sign-off policy. No CLA or DCO is currently required.
- Review patched or locked upstream native source and retain its license and notices.
- Generate exact binary third-party notices and an SBOM before distributing installers.
- Do not publish unsigned or internal-only artifacts as releases.

## Secret-Scan Exceptions

The Gitleaks ignore file contains 32 exact historical fingerprints reviewed as test or
documentation fixtures. New entries require manual inspection of the originating commit
and must explain the fixture category. Do not add path-wide, rule-wide, or entropy-wide
exclusions to make a scan pass.

The localization exception in `.gitleaks.toml` is restricted to `generic-api-key` findings
on generated locale JSON source-hash lines: the catalog path and complete 64-character
hexadecimal hash line must both match. Other rules and non-hash lines are still scanned.
A disposable fixture check confirms a credential-shaped catalog value and a non-catalog
64-character API-key value are detected. This typed exception cannot distinguish a real
64-character hexadecimal key deliberately placed on such a generated hash line; catalog
inputs must remain generated data and changes still require review.

The initial history check used `--log-opts=HEAD`, covering the full history reachable from
baseline `958fe499100cc4874e938eee45f6f92a9caa23d0`, rather than unrelated local work-in-progress branches. Gitleaks reported
874 commits with scanned diffs (135.59 MB); `git rev-list HEAD --count` reports 1,103 reachable
commits including merges and empty commits. No leaks were reported with the narrowed
localization exception. Preparation was subsequently rebased onto the dependency security
refresh in `49554b07652c4311fade8ec8dee858dd364b85fe`, with a frozen reinstall and dependency
security regression checks. The final candidate commit and any additional refs exposed at
publication must be scanned again before visibility changes.

## Final Local Commands

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check:docs
corepack pnpm check:licenses
corepack pnpm check:public
gitleaks git --redact=100 --config .gitleaks.toml --gitleaks-ignore-path .gitleaksignore --log-opts=HEAD .
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter './packages/**' --filter @ling-stack/web --filter @ling-stack/desktop typecheck
LING_STACK_HOME=/path/to/temporary/ling-home corepack pnpm --filter './packages/**' --filter @ling-stack/web test
corepack pnpm --filter @ling-stack/web build
git diff --check
```

Run the test command with a disposable `LING_STACK_HOME`. Never point publication checks
at a user's existing Ling data directory.

## Public Source Go/No-Go

The local documentation and source-startup preparation can be reviewed now. Actual source
publication remains a separate maintainer action, with the following final requirements:

- no native release workflow or self-hosted runner label remains in this repository;
- deferred online settings and CI status are recorded accurately, with any release-time
  exceptions explicitly owned by the maintainer;
- current UI screenshots and repository metadata are reviewed;
- the complete change is committed and reviewed, required local checks pass, and a final
  Gitleaks scan passes from a clean checkout; use CI when Actions capacity is restored.

Desktop binary distribution remains No-Go after source publication until every Desktop
release, signing, platform, accessibility, clean-machine, SBOM, and notice gate closes.
