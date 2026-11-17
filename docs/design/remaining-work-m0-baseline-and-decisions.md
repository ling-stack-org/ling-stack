# Remaining Work M0 Baseline And Decisions

Status: active baseline audit; this document records evidence and pending decisions, not product approval
Owner: Ling maintainers; one integration owner and one platform contact must be assigned for each active package
Last verified: 2026-11-18
Source branch: `codex/remaining-work-implementation`
Remote: `https://github.com/ling-stack-org/ling-stack.git`

This is the evidence packet for M0 of the [Remaining Work Completion Plan](remaining-work-completion-plan.md).
It separates repository facts, local implementation evidence, remote review state, platform acceptance, and
product decisions. A row is not complete merely because its source code exists locally.

## 1. Baseline snapshot

| Item | Snapshot | Evidence or consequence |
|---|---|---|
| Protected source worktree | `/Users/tianxiao/ling-stack`, branch `codex/ling-companion`, `HEAD 65d2ed026` | Existing WIP is preserved and was not reset, cleaned, or rebased by this plan |
| Target worktree | `/Users/tianxiao/.codex/worktrees/remaining-work-implementation` | Isolated implementation worktree for this delivery target |
| Target branch | `codex/remaining-work-implementation` | Created from the latest `origin/main@81f216d7de8211257448451ddfecde94fcf0ec63`; role-view recovery (`1ce2a969f`) and refreshed M0 evidence are local commits, and the branch remains unpushed |
| Plan branch cut | `origin/main@81f216d7de8211257448451ddfecde94fcf0ec63` | Refreshed on 2026-11-18 before continuing the target work |
| Main currently integrated locally | `origin/main@81f216d7de8211257448451ddfecde94fcf0ec63` | Target starts at this mainline commit; no target-branch merge is claimed |
| Target remote state | No `origin/codex/remaining-work-implementation` ref and no target PR | Local commits are not reviewable from GitHub until explicitly pushed and a PR is opened |
| Deployment state | None | No source, package, daemon, or provider deployment is claimed |
| CI state for this target | Not started on GitHub | The target branch is not pushed; local checks remain separate from hosted CI |
| Latest observed main CI | GitHub Actions run `43986644173`, event `dynamic`, branch `main`, conclusion `success` | This is a mainline observation and does not validate the target branch |

### Remote PR audit snapshot

The following states were read from the GitHub pull request records on 2026-11-17:

| PR | Head | State | Merge commit | Planning interpretation |
|---:|---|---|---|---|
| #627 | `codex/memory-skill-learning` | merged | `825dcb494` | Source delivery merged; packaged follow-up acceptance remains a release boundary |
| #659 | `codex/ling-f3-f4-readonly` | merged | `0e56b76ba` | F3/F4 source delivery is in main |
| #677 | `codex/ling-companion-pr` | merged | `7cd5f3c6a` | Companion source code is merged; this answers the prior companion branch question |
| #679 | `codex/fix-assurance-lock-drift` | merged | `c9c1e23c6` | Assurance lock-drift fix is merged; affected PR acceptance is still tracked separately |
| #695 | `codex/f5-rerun-contract` | merged | `542d8a451` | F5 contract preflight is merged |
| #698 | `codex/f5-host-observation` | merged | `93fea5080` | Host admission observation is merged |
| #714 | `codex/agent-capabilities` | open | — | Must not be described as merged; review/CI and the open findings remain external dependencies |
| target branch | `codex/remaining-work-implementation` | no PR | — | Current F5, External Work, context, and plan changes are local only |

The merge status above distinguishes “source merged” from “deployed,” “packaged,” and “field accepted.”
The PR records are evidence for the listed PRs only; they do not close the M0 owner, platform, or decision gates.

## 2. Active work owner, input, output, and platform matrix

The repository does not provide a reliable named-person assignment for every active work item. The owner
column therefore uses the required role and explicitly marks assignment gaps. M0 cannot close until every
`assign` cell has a named owner and a reachable platform contact. No owner is inferred from a commit author.

| Active work package | Required owner | Authoritative input | Expected output | Platform/resource needed | M0 assignment |
|---|---|---|---|---|---|
| Ling Multi-Agent Safe Concurrency | Runtime safety owner | `ling-multi-agent-safe-concurrency-*` contracts and current Host/Daemon code | Reviewable concurrency boundary, recovery evidence, CI and main merge | macOS daemon, Pi SDK, Host/Git/SQLite/HTTP/SSE; later packaged macOS/Windows | assign |
| F5 Node Rerun Contract | Runtime + F5 integration owner | `ling-framework-complementary-*`, F5 contract tests, target branch F5 commits | Real Runner/Provider dispatch, stop confirmation, unknown-outcome restart proof, A17/A18 | Live daemon, real Provider, restartable Host capacity and a controlled workspace | assign |
| Native Execution Engines | Native runtime owner | `native-execution-engines-implementation-plan.md` and adapter contracts | T7 approval/remote-stop and remaining Electron/native acceptance | OpenClaw, Electron, macOS package, Windows package, signing and clean hosts | assign |
| Channel Execution Completion | Channel runtime owner | `channel-execution-completion-implementation-plan.md` | Review, hosted CI, remote merge, exact QA cleanup | Daemon restart, SSE/reload, channel browser surface | assign |
| Channel Context Processing | Context/data owner | `channel-context-processing-layer-implementation-plan.md` | Single condensation owner, quote policy, durable/restart-safe materialization, centralized redaction | SQLite reopen, daemon restart, channel and direct-message browser fixtures | assign |
| Ling Agent Session | Session control-plane owner | `ling-agent-session-implementation-plan.md` | Durable identity, instruction, report, and execution ownership closure | Daemon/API client, conversation and private-chat browser surfaces | assign |
| Memory Review Policy | Learning owner | `memory-review-policy-implementation.md` | Considered/excluded/supplied recall audit and release evidence | macOS/Windows packaged FTS/native acceptance and CPA test fixture | assign |
| Conversation and approval surfaces | Web conversation owner | Conversation Surface, P2, Right Dock, Sidebar/Approval/Proposal, Permission Presets plans | Shared state/approval semantics with browser evidence for empty, error, expired, narrow, and restore cases | Real browser at required widths, daemon-backed fixtures, accessibility tooling | assign |
| Workspace Command Rule Approval | Web/runtime policy owner | `workspace-command-rule-approval-implementation-plan.md` | Once/persistent/revoke/restart and unsafe-command rejection proof | Real browser plus restartable daemon | assign |
| Thread-First Work History | Conversation history owner | `thread-first-work-history-implementation-plan.md` | Diagnostics placement and remaining V2 recovery evidence | Browser, SQLite reopen, archive/fork fixtures | assign |
| Chrome Browser Built-in Plugin | Browser integration owner | `chrome-browser-built-in-plugin-implementation-plan.md` | Automatic Host connection, dual-platform packaging, real Chrome and Store evidence | macOS and Windows Chrome, Native Messaging install, Store submission path | assign |
| Desktop In-App Browser | Desktop browser owner | `desktop-browser-implementation-plan.md` | Real model annotation-to-edit, policy deny/revoke, Windows/native-view, signed clean-host proof | Electron macOS arm64 and Windows, controlled local site, signed package | assign |
| Bundled CUA Driver and PiP | Desktop automation owner | CUA and Desktop PiP implementation plans | Settings surface, signed platform runs, assistive-technology and clean-host evidence | macOS arm64, Windows x64, accessibility devices/tools, signed installers | assign |
| Office Documents Native Plugin | Office integration owner | `office-documents-native-plugin-implementation-plan.md` | Real Excel/WPS acceptance and packaged driver evidence | Windows Office/WPS, macOS Office, native driver package | assign |
| Bundled GStack Client | Developer-tooling owner | `gstack-bundled-client-upgrade-implementation-plan.md` | Review/merge, offline/damaged-resource checks, 57 workflow acceptance | macOS/Windows packages, simulated offline and resource corruption fixtures | assign |
| Conversation Media Generation | Media runtime owner | `conversation-media-generation-tools-implementation-plan.md` and provider hardening contract | Shared registration, paid-task idempotency, recovery projection, browser evidence | Explicitly authorized real media Provider, cost budget, cancellation/recovery fixtures | assign |
| External Work 8.0/8.1 | External integration owner | External Work phase plans and target-branch adapter/remote commits | Review/CI/merge and packaged checkout/reconcile acceptance | GitHub/Linear test accounts or fixtures, isolated workspace, redacted token paths | assign |
| Desktop themes and Journey UI | Desktop visual owner | theme/background and Journey implementation plans | User-art review, signed macOS/Windows package and assistive-technology evidence | macOS/Windows clean hosts, screen-reader/keyboard review, cleared media assets | assign |
| Provider catalog maintenance | Provider maintenance owner | `provider-model-catalog-and-discovery-p15-implementation-plan.md` | Routine catalog review and connector maintenance | Provider credentials only when needed; no new feature scope | assign |

The platform column is a resource reservation requirement, not evidence that the resource is currently
available. A local test fixture, synthetic provider, or successful build cannot fill a real-provider,
packaging, Windows, Office, Chrome Store, or accessibility slot.

## 3. Product and architecture decision packets

These six packets are deliberately written as **proposed defer decisions**. They do not reopen a product
surface or authorize implementation. A product owner and the relevant security/architecture owner must
record `approve`, `defer`, or `reject` with a date and rationale before the item can enter M1–M4.

### 3.1 External Agent Skill Discovery and Adoption

- **Proposal:** defer UI adoption for this Release Candidate; retain the fixed local `.agents/skills` scope,
  client-local ignore behavior, and P16 boundary guards as the minimum future contract.
- **Why:** discovery changes executable-skill trust and workspace authority. The current active queue does
  not need to broaden that boundary to close runtime safety or release evidence.
- **Approve only if:** the product owner accepts local-folder scope, discovery visibility, enable/disable
  semantics, provenance, and the security review of skill execution inputs.
- **Required evidence:** updated contract, threat review, migration/ignore behavior, browser acceptance, and
  a named owner. Until then the status is `pending decision`.

### 3.2 Core Tools Runtime Boundary

- **Proposal:** defer removal of built-in tools from Plugin presentation until ownership of approval,
  diagnostics, capability discovery, and backward-compatible tool errors is signed off.
- **Why:** moving presentation boundaries without a daemon contract can create duplicate authority or hide
  audit evidence.
- **Approve only if:** the core/runtime owner documents the canonical tool registry, approval path, error
  semantics, and migration behavior for existing clients.
- **Required evidence:** contract diff, compatibility tests, approval/revoke/restart tests, and a staged
  browser rollout plan. Status: `pending decision`.

### 3.3 Mobile Remote Access

- **Proposal:** defer and keep outside the current acceptance scope.
- **Why:** remote access changes the trust boundary and requires a separate threat model, enrollment,
  revocation, offline behavior, and secure transport review.
- **Reopen only if:** security and product owners explicitly approve a bounded use case, supported platforms,
  identity lifecycle, and a field-acceptance plan.
- **Required evidence:** threat model, protocol contract, device/revocation tests, privacy review, and named
  mobile/platform owners. Status: `deferred pending reopening`.

### 3.4 Work Board

- **Proposal:** defer reopening until workspace projection and current browser acceptance are revalidated.
- **Why:** the board depends on durable workspace projection and can otherwise become a second source of
  truth for plans, runs, and approvals.
- **Approve only if:** projection ownership, stale-write behavior, permissions, and navigation placement are
  confirmed against the current Conversation/Thread-first contracts.
- **Required evidence:** current product copy, projection contract, browser tests at narrow widths, and a
  named owner. Status: `pending decision`.

### 3.5 Startup and Diagnostics

- **Proposal:** defer reopening until product copy and current diagnostic state are revalidated.
- **Why:** diagnostics must report the current daemon/provider/workspace state without introducing a second
  recovery controller or exposing credentials.
- **Approve only if:** the surface, error taxonomy, redaction rules, and recovery actions are owned by the
  current control plane.
- **Required evidence:** updated design, redacted examples, browser/accessibility acceptance, and a named
  owner. Status: `pending decision`.

### 3.6 Workspace Tools Embedded

- **Proposal:** defer reopening until shared shell, scroll, overlay, and permission behavior are revalidated.
- **Why:** embedding tools in the workspace shell can change focus, overlay, and approval boundaries across
  conversation and desktop surfaces.
- **Approve only if:** shell ownership, navigation, overlay stacking, input focus, and tool authority remain
  compatible with the shared Conversation Surface contract.
- **Required evidence:** updated interaction contract, narrow/large browser cases, keyboard/accessibility
  review, and a named owner. Status: `pending decision`.

## 4. M0 checklist and exit criteria

### Recorded

- [x] Branch-cut and latest-main commit are recorded.
- [x] Target worktree is isolated and protected WIP is identified.
- [x] Remote PR status for the known delivery PRs is recorded, including #677 and open #714.
- [x] Local validation evidence is linked through the owning plans and status index.
- [x] Six decision packets use an explicit default defer posture and list the approval evidence required.

### Still open

- [ ] Assign one integration owner and one platform contact for every active work row.
- [ ] Reserve or explicitly waive each macOS, Windows, Chrome, Office/WPS, accessibility, signed-package,
      and real-provider slot.
- [ ] Record an explicit `approve`, `defer`, or `reject` outcome for each decision packet.
- [ ] Complete the PR/CI audit for every active package, including review state, required checks, and the
      actual remote merge commit where applicable.
- [ ] Attach the real Runner/Provider, stop-confirmation, A17/A18, and Channel Context evidence; the
      local two-process daemon restart unknown-outcome regression is recorded in the F5 owning plan.
      before declaring M0 closed.

M0 exits only when the open checklist is either completed or has an explicitly named owner, due date, and
documented exception. The existence of this document therefore records the M0 baseline but does not itself
mark M0 complete.

## 5. Current test and evidence baseline

The following evidence is already recorded on the target branch and in the owning plans:

- Current branch verification: Core selected implementation suites `104/104`, Core runtime-host-capacity
  migration suite `114/114`, and Daemon selected implementation suites `341/341` passed on 2026-11-17.
  These runs include the F5 route/capacity/cancellation/readiness/dispatch/restart paths, Automation,
  Goal supervision, Channel Context and External Work files listed in the local verification command. The
  follow-up Context lineage/projector/recovery set is `42/42`, with Core/Daemon production and test
  typechecks plus the Daemon build passing after the startup reconciliation worker was added.
- Core and Daemon production/test typechecks passed; Core and Daemon builds passed; `corepack pnpm check:docs`
  passed for 573 Markdown files. The full repository build and hosted CI remain separate gates and are not
  inferred from these package runs.
- The targeted context processing, projection, memory and restart-recovery set is now `52/52` on
  2026-11-18, including specialist and evidence-inspect prompt-envelope reconstruction after SQLite
  reopen. This is local source evidence only; browser, security, packaged and provider gates remain open.
- Hosted CI and remote merge are not inferred from these local results. Platform acceptance, real Provider
  smoke, signed packages, Windows/Office/Chrome, and accessibility remain open where the owning status says so.

Evidence anchors:

- [Remaining Work Completion Plan](remaining-work-completion-plan.md)
- [Implementation Status](implementation-status.md)
- [Ling Framework Complementary Detailed Design](ling-framework-complementary-detailed-design.md)
- [Ling Framework Complementary Implementation Plan](ling-framework-complementary-implementation-plan.md)
- [External Work Phase 8.0](external-work-phase-8.0-adapter-registry-implementation.md)
- [External Work Phase 8.1](external-work-phase-8.1-workspace-git-remote-implementation.md)

## 6. Next authorized implementation step

After the M0 decisions and owner/resource assignments are recorded, the next implementation slice is
Web/security/session surface acceptance, while the F5 track continues with external Provider,
stop-confirmation and A17/A18 evidence. The F5 receiver keeps the durable dispatch
receipt read-only after release, preserves fail-closed unknown-outcome behavior, and does not open
ordinary multi-agent write concurrency.

Until that evidence exists, the branch remains source-complete for the recorded local slices only. It is not
a release candidate, has no remote PR, and has not been deployed.
