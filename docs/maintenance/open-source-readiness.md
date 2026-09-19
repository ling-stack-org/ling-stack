# Open-Source Readiness Checklist

Status: active publication checklist
Owner: repository maintainers
Last verified: 2026-08-27
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
| Security reporting | Partially ready | `SECURITY.md` is ready; GitHub private reporting and Advanced Security controls must be enabled after the repository is public (the current private plan/API does not expose them) |
| Support boundary | Ready locally | `SUPPORT.md` |
| Issue and PR intake | Ready locally | Issue Forms and pull request template |
| Ownership | Ready locally | `.github/CODEOWNERS` |
| Dependency updates | Ready locally | Dependabot configuration |
| Generic CI | Ready locally | Locally verified typecheck, unit, Web build, docs, i18n, UI, and Git-history secret checks |
| Documentation links | Ready locally | `corepack pnpm check:docs` |
| Dependency licenses | Ready locally | `corepack pnpm check:licenses`; binary notices remain a separate gate |
| Current-tree safety scan | Ready locally | `corepack pnpm check:public` after personal-path cleanup |
| Main branch protection | Configured online | PR-only `main`, required CI, one approval, conversation resolution, linear history, and no force-push/delete |
| Actions policy | Configured online | Default read-only token permissions and full-length SHA pinning are enabled; allowed actions remain temporarily broad for the existing generic CI |
| Git-history secret scan | Ready locally | Gitleaks v8.30.1 scanned 765 commits and 67.2 MB; 21 reviewed false positives are fingerprint-scoped in `.gitleaksignore` |
| Public UI screenshots | Ready locally | Neutral deterministic workspace overview is checked in; historical screenshots with maintainer paths were removed |
| Changelog and release policy | Ready locally | `CHANGELOG.md` and `docs/release/README.md` |

## GitHub Settings Required Before Visibility Change

- Enable private vulnerability reporting after the repository visibility change (GitHub does
  not expose this control for the current private repository plan).
- Enable secret scanning and push protection for contributors after the visibility change
  (the current private repository API returns `404` for both controls).
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

- Confirm the project name, logo, screenshots, sample content, and bundled assets may be
  published under the intended terms.
- Decide whether a trademark policy is required; the MIT License does not grant trademark
  rights.
- Confirm contributor sign-off policy. No CLA or DCO is currently required.
- Review patched or locked upstream native source and retain its license and notices.
- Generate exact binary third-party notices and an SBOM before distributing installers.
- Do not publish unsigned or internal-only artifacts as releases.

## Secret-Scan Exceptions

The Gitleaks ignore file contains only exact historical fingerprints reviewed as test or
documentation fixtures. New entries require manual inspection of the originating commit
and must explain the fixture category. Do not add path-wide, rule-wide, or entropy-wide
exclusions to make a scan pass.

## Final Local Commands

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check:docs
corepack pnpm check:licenses
corepack pnpm check:public
gitleaks git --redact --gitleaks-ignore-path .gitleaksignore .
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

Source publication is **No-Go** until all of the following are true:

- no native release workflow or self-hosted runner label remains in this repository;
- required GitHub security and branch settings are enabled;
- current UI screenshots and repository metadata are reviewed;
- the complete change is committed and CI plus a final Gitleaks scan pass from a clean checkout.

Desktop binary distribution remains No-Go after source publication until every Desktop
release, signing, platform, accessibility, clean-machine, SBOM, and notice gate closes.
