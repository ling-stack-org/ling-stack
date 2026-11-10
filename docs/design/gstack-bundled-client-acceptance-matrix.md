# Bundled GStack Acceptance Matrix

Status: source matrix active; package and real-workflow rows pending
Owner: Skills, Desktop, and QA maintainers
Last verified: 2026-10-17 against Main `cd7d9d83`
Document type: active acceptance matrix
Code and test anchors: `packages/core/test/skill-source-publication.test.mjs`, `packages/daemon/test/bundled-skill-startup.test.mjs`, `scripts/gstack/host-workflow-integration.test.mjs`

## Evidence Levels

| Level | Meaning | Current state |
| --- | --- | --- |
| Source | Builds and focused tests pass for the checked-out revision | Ready for independent review |
| Component | Real pinned resource executes locally from authenticated external bytes | TestSavant and retained GStack/browser evidence available |
| Package | `.app`, DMG, ZIP, or NSIS contains and starts the same resource identity | Deferred |
| Installed client | Clean-machine UI and workflow acceptance on Mac/Windows | Deferred |

Passing one level never implies the next. Model quality observations do not block
source or component inclusion; they limit quality claims.

## Shared Source Gates

| Gate | Required result |
| --- | --- |
| Upstream identity | GStack `47d639ab` / `1.91.101.0`, exactly 57 skills |
| Source integrity | Complete bodies/references, no truncation, traversal, aliases, or unlisted bytes |
| Publication | Atomic batch, retry convergence, stale-writer fencing, reopen persistence |
| Upgrade lifecycle | Follow, pin, resume-following, rollback, custom/draft/archive preservation |
| Frozen execution | Exact resource binding persists and resumed tasks cannot silently upgrade |
| Runtime environment | Package-owned GStack, Node, browser, TestSavant, and isolated state only |
| TestSavant | Pinned model, real local inference, simulated offline, timeout/error cleanup |
| Browser | Package-owned launch/navigation/snapshot/screenshot/handoff paths |
| Desktop source build | Embedded identity, `extraResources`, post-pack byte verification |
| Scope | No answer/recovery UI, Wolf candidate, package output, release, or global install |

## TestSavant Gates

| Scenario | Source/component expectation | Package expectation |
| --- | --- | --- |
| Model identity | Exact revision, sizes, and SHA-256 values | Same files inside package |
| First use | No download, Python, system Node, or model API | Simulated offline first launch |
| Normal scan | Original classifier and upstream combiner semantics | Same result through client path |
| Long input | Complete bounded overlapping windows; no safe prefix | Same result through client path |
| Invalid output | Unavailable, never safe | Visible failure without app crash |
| Timeout/cancel | Child terminated/joined; state cleaned | No orphan process after app exit |
| Quality corpus | Report EN/ZH false positives and misses unchanged | Informational, not a build blocker |

## All 57 Skills

For this PR, every row must pass source inventory, complete loading, publication,
and frozen resource binding. The real scenario remains a later installed-client
gate.

| Skill | Minimum real scenario | Source | Installed client |
| --- | --- | --- | --- |
| autoplan | Ordered review chain and answer ownership | Required | Pending |
| benchmark-models | Compare configured model outputs and cost | Required | Pending |
| benchmark | Detect a seeded performance regression | Required | Pending |
| browse | Navigate, click, snapshot, and screenshot | Required | Pending |
| canary | Detect an injected deployment failure | Required | Pending |
| careful | Stop a dangerous fixture command | Required | Pending |
| claude-code | Use an explicitly configured external Claude CLI | Required | Pending |
| codex | Use an explicitly configured Codex CLI | Required | Pending |
| context-restore | Restore without changing frozen resources | Required | Pending |
| context-save | Save isolated, redacted context | Required | Pending |
| cso | Reproduce a security finding | Required | Pending |
| design-consultation | Produce approved design decisions | Required | Pending |
| design-html | Render and open nonblank HTML | Required | Pending |
| design-review | Detect a seeded visual defect | Required | Pending |
| design-shotgun | Produce declared design variants | Required | Pending |
| deslop-shared-libs | Identify fixture duplication | Required | Pending |
| devex-review | Reproduce a developer workflow failure | Required | Pending |
| diagram | Render a nonblank diagram | Required | Pending |
| document-generate | Generate linked fixture documentation | Required | Pending |
| document-release | Update an authorized release document | Required | Pending |
| eval-plan | Evaluate a fixture plan | Required | Pending |
| freeze | Enforce the approved edit boundary | Required | Pending |
| gstack-upgrade | Use Ling resources without global mutation | Required | Pending |
| guard | Enforce command and edit boundaries | Required | Pending |
| health | Report passing and failing checks | Required | Pending |
| investigate | Diagnose and verify a root cause | Required | Pending |
| ios-clean | Remove only an authorized fixture bridge | Required | Pending |
| ios-design-review | Capture a real device visual defect | Required | Pending |
| ios-fix | Fix and recheck a device defect | Required | Pending |
| ios-qa | Exercise real device flows | Required | Pending |
| ios-sync | Regenerate and connect the bridge | Required | Pending |
| land-and-deploy | Gate and deploy an authorized test target | Required | Pending |
| landing-report | Report queue state without mutation | Required | Pending |
| learn | Save and search scoped learning | Required | Pending |
| make-pdf | Produce and open a complete PDF | Required | Pending |
| office-hours | Produce an approved product decision | Required | Pending |
| open-gstack-browser | Start, use, and clean owned browser state | Required | Pending |
| pair-agent | Pair and revoke an authorized remote agent | Required | Pending |
| plan-ceo-review | Complete structured strategy review | Required | Pending |
| plan-design-review | Review fixture UX and persist decisions | Required | Pending |
| plan-devex-review | Review a real API/CLI workflow | Required | Pending |
| plan-eng-review | Review architecture, failure, and tests | Required | Pending |
| plan-tune | Persist only explicit user preference | Required | Pending |
| qa-only | Report a browser failure without edits | Required | Pending |
| qa | Reproduce, fix, and recheck browser failure | Required | Pending |
| retro | Produce a Git/run-evidence retrospective | Required | Pending |
| review | Detect a seeded code defect | Required | Pending |
| scrape | Extract content with source evidence | Required | Pending |
| setup-browser-cookies | Import only with explicit consent | Required | Pending |
| setup-deploy | Configure only an authorized target | Required | Pending |
| setup-gbrain | Configure and verify an authorized service | Required | Pending |
| ship | Publish only to an authorized disposable target | Required | Pending |
| skillify | Produce a working scoped skill | Required | Pending |
| spec | Produce a local executable specification | Required | Pending |
| sync-gbrain | Sync an authorized service with isolation | Required | Pending |
| test-audit | Detect a seeded test blind spot | Required | Pending |
| unfreeze | Revoke and verify the edit boundary | Required | Pending |

Ling-native `implement` and `checkpoint` are preservation checks, not part of the
57 upstream rows. Legacy `claude` bindings resolve to `claude-code`; they do not
install or authorize Claude.

## PR Exit

- Core and Daemon builds pass.
- Focused Core and Daemon GS suites pass.
- TestSavant and browser source suites pass or are explicitly marked as requiring
  the retained external component.
- Desktop packaged-resource source tests pass.
- All 57 source rows are present and authenticated.
- Documentation, public safety, and whitespace checks pass.
- The final diff contains no answer/recovery UI or Wolf candidate implementation.

## Deferred Release Gates

- Mac ARM64/x64 and Windows x64 package generation.
- Clean install, upgrade, rollback, and uninstall.
- Simulated offline first launch and no-system-Node operation.
- Missing/corrupt resource and timeout recovery.
- Real browser handoff and cleanup from the installed client.
- All 57 real scenarios above.
