# Open-Source Readiness Checklist

Status: active publication checklist
Owner: repository maintainers
Last verified: 2026-08-03
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
| Security reporting | Ready locally | `SECURITY.md`; GitHub private reporting still needs online enablement |
| Support boundary | Ready locally | `SUPPORT.md` |
| Issue and PR intake | Ready locally | Issue Forms and pull request template |
| Ownership | Ready locally | `.github/CODEOWNERS` |
| Dependency updates | Ready locally | Dependabot configuration |
| Generic CI | Ready locally | Locally verified typecheck, unit, Web build, docs, i18n, UI, and Git-history secret checks |
| Documentation links | Ready locally | `corepack pnpm check:docs` |
| Dependency licenses | Ready locally | `corepack pnpm check:licenses`; binary notices remain a separate gate |
| Current-tree safety scan | Ready locally | `corepack pnpm check:public` after personal-path cleanup |
| Git-history secret scan | Ready locally | Gitleaks v8.30.1 scanned 765 commits and 67.2 MB; 21 reviewed false positives are fingerprint-scoped in `.gitleaksignore` |
| Public UI screenshots | Pending | Capture the current product; do not restore outdated UI2 concept screenshots |
| Changelog and release policy | Ready locally | `CHANGELOG.md` and `docs/release/README.md` |

## GitHub Settings Required Before Visibility Change

- Enable private vulnerability reporting.
- Enable secret scanning and push protection for contributors.
- Enable dependency graph, Dependabot alerts, and security updates.
- Create a `main` ruleset requiring pull requests, review, conversation resolution, and
  the generic CI check.
- Disable force pushes and branch deletion for `main`.
- Keep default workflow token permissions read-only; grant write permissions only to a
  specific reviewed workflow job.
- Review whether fork pull requests require maintainer approval before Actions run.
- Confirm Issues are enabled and Issue Forms render correctly.
- Set repository description, topics, website, social preview, and default branch.
- Review Actions artifact retention and repository storage limits.
- Confirm no repository or organization secret is exposed to untrusted pull requests.

These settings are online state and cannot be proven by committed files alone.

## Hard Stop: Self-Hosted Runners

The Cua Driver macOS and Windows runners are interactive repository-scoped hosts. Existing
release documentation explicitly forbids sharing them with a public repository.

Before making the repository public:

1. disable or unregister both runners;
2. revoke their repository registration credentials;
3. verify no public or fork-triggered workflow can select their labels;
4. move native release work to a separately reviewed private repository or protected
   runner boundary;
5. inspect retained artifacts and logs for private paths or signing metadata.

Do not rely only on `workflow_dispatch` or actor-name checks as the public-repository
security boundary.

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

- self-hosted native runners are detached or moved behind a private boundary;
- required GitHub security and branch settings are enabled;
- current UI screenshots and repository metadata are reviewed;
- the complete change is committed and CI plus a final Gitleaks scan pass from a clean checkout.

Desktop binary distribution remains No-Go after source publication until every Desktop
release, signing, platform, accessibility, clean-machine, SBOM, and notice gate closes.
