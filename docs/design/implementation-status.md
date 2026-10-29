# Ling Implementation Status Index

Status: current planning index
Owner: repository maintainers
Last verified: 2026-10-27 (external shared skill-source decision row); 2026-10-19 (Native Execution Engines row); 2026-10-17 (P2 and bundled GStack rows); other work retains its owning plan's verification date
Document type: governance index

## Purpose

This is the only cross-feature index of unfinished or protected implementation work.
Owning contracts remain authoritative for behavior; this index answers only whether
material delivery work remains and where it is tracked.

The categories are mutually exclusive:

- **Active delivery or platform closure**: implementation or release work is currently
  defined and can proceed without a new product decision.
- **Pending product reopening or architecture decision**: code may exist, but the product
  entry or architecture is intentionally not approved for delivery.
- **Tracked follow-up without an active delivery plan**: the contract records a real gap,
  but it is not an active queue item.
- **Reference contract**: long-term boundary only, not a separate work queue.

Completed plans transfer durable behavior to their owning contracts and are deleted. Test
counts, screenshots, hashes and run diaries belong in CI or Release artifacts.

## Active Delivery Or Platform Closure

| Work | Current boundary | Closure condition |
|---|---|---|
| [Memory and Skill Learning](memory-and-skill-learning-implementation-plan.md) | Scoped FTS recall, bounded candidate-only learning, skill definition history/undo, optional semantic retrieval and exact-owner Wiki source are implemented on an isolated branch; owning derivative contract is [Optional Memory Derivatives](memory-derived-views.md) | Complete final source review/CI/merge and remaining browser/platform acceptance. Optional native LanceDB stays outside default bundles until packaged platform acceptance; a pre-existing developer-database FK orphan requires its own recovery before upgrade |
| [Native Execution Engines](native-execution-engines-implementation-plan.md) | T0–T6 implemented; complete frozen-source Core/daemon regression passes with explicit skips. License replacements and synthetic browser flows verified. Codex real owned scenes pass on their named snapshots. Kimi CLI 2.2.0 is installed locally; isolated real conversation, database-reopen recovery and cancellation pass after sandbox adaptation. OpenClaw real conversation/recovery pass after preventing detached self-respawn. Ling's completed-output delivery and cleanup cancellation races are repaired with adapter regression; host authority and identity revocation remain enforced. Electron IPC/migration/blocked composer have partial interaction evidence. See the validation record for source boundaries and failed historical runs | T7: OpenClaw approval/remote-stop and its retained unknown submission remain external acceptance boundaries, excluded from the Ling-only repair. Electron remaining interaction, complete Main/default startup, trusted checks/publication and production requests, other platforms/signing and language quality remain open. No production evidence was published or whole-repository pass claimed; uncertified native combinations stay blocked |
| [P2 Conversation Experience](five-point-optimization-implementation-plan.md) | UX1-UX3 source/local complete with concerns. Rebased onto `origin/main@a44c4377`; Core 3339, Daemon 4899 plus one existing skip, Runner 407, Contracts 88, API 91, Web 520, Desktop Node 2426 plus four conditional skips, renderer 28, accessibility 3 and P2 browser 285 pass. No UX4 | Review/CI/merge plus provider, installed-client, native Windows and packaging gates remain open. Native follow-up uses a local protocol fixture and normal chat, not all-surface external execution. Unknown effects stay blocked; original failed/interrupted reports remain retained. |
| [Bundled GStack Client](gstack-bundled-client-upgrade-implementation-plan.md) | Independent source delivery for GStack `1.91.101.0`, all 57 skills, original TestSavant, package-owned browser, source publication, follow/pin/rollback, and frozen resource binding | Review and merge the source PR, then complete Mac/Windows package, simulated-offline, damaged-resource, and 57 real-workflow acceptance without mixing the separate conversation answer/recovery UI follow-up |
| [Channel Execution Completion](channel-execution-completion-implementation-plan.md) | Required-participant fan-in, operation evidence, TerminalReport/source-Turn convergence, clean-break Attempt fencing, restart recovery, migration rollback/reopen, and aggregate source verification are green on the isolated delivery branch | Review the isolated diff, open PR/CI, merge, verify the actual remote `main` merge commit, then clean exact QA resources |
| [Channel Context Processing](channel-context-processing-layer-implementation-plan.md) | Channel and direct-message context views exist | Condensation, quote eligibility, persistence and redaction ownership are closed |
| [Chrome Browser Built-in Plugin](chrome-browser-built-in-plugin-implementation-plan.md) | Manual V1 pairing and six approved browser tools exist; Native Messaging `0.1.1` implementation is active | Automatic Host connection, dual-platform package gates, real Chrome acceptance and Store resubmission close |
| [Project Defect Remediation 2026-09](project-defect-remediation-plan-2026-09.md) | Source remediation and automated Web/daemon/native regression are green across right-dock review, Runs, Profile i18n, Native Broker startup, and Native migration | Real macOS/Windows packaged-client and Chrome-extension environment acceptance closes |
| [Workspace Command Rule Approval](workspace-command-rule-approval-implementation-plan.md) | Approval contracts, storage, daemon matching, and Composer split-button implementation exist | Real-browser proof of once versus persistent approval, cross-surface/restart behavior, revoke, and unsafe-command rejection closes |
| [Permission Presets](codex-inspired-settings-permission-presets-implementation-plan.md) | Enforcement modes exist | Preset UI, effective preview and run audit agree with daemon enforcement |
| [Provider Model Catalog And Discovery](provider-model-catalog-and-discovery-p15-implementation-plan.md) | Implemented and verified: versioned catalog, native discovery adapters, secure saved-key discovery and workbench provenance | Daily catalog PR review and normal provider connector maintenance continue |
| [Conversation Surface](conversation-surface-contract-implementation-plan.md) | Shared primitives and initial package extraction are implemented | WorkCell, evidence, attachment, package CSS and Desktop-consumption boundaries close |
| [Conversation Media Generation](conversation-media-generation-tools-implementation-plan.md) | Runner tools, target resolution, background MediaJob projection, and three-surface integration are defined | Shared tool registration, idempotent paid-task creation, recovery projection, and browser acceptance close |
| [Conversation Right Dock Responsive Visibility](conversation-right-dock-responsive-visibility-implementation-plan.md) | Shared requested/rendered/available state and narrow-width layout ownership are implemented | Real-browser proof at and around `900px` across channel, normal conversation, and private chat, including restoration and no reserved blank region, closes |
| [Bundled CUA Driver](cua-driver-bundled-embedded-implementation-plan.md) | Packaging, integrity and platform foundations exist | Computer Control Settings surface and remaining signed platform gates close |
| [Desktop Computer Use PiP](desktop-computer-use-picture-in-picture-implementation-plan.md) | Renderer and fail-closed local harness exist | Signed macOS, Windows, assistive-technology and clean-host release gates pass |
| [External Work Phase 8.0](external-work-phase-8.0-adapter-registry-implementation.md) | Approved registry refactor; not yet implemented | Generic GitHub/Linear registry lands without behavior drift |
| [External Work Phase 8.1](external-work-phase-8.1-workspace-git-remote-implementation.md) | Approved checkout-hint plan; not yet implemented | `workspace.gitRemoteUrl` remains separate from provider identity and authority |
| [Ling Agent Session](ling-agent-session-implementation-plan.md) | Initial P1-P6 control-plane slices exist | Durable identity, instruction, report and execution ownership decisions close |
| [Memory Review Policy](memory-review-policy-implementation.md) | MRP.1-MRP.5 and first MRP.7 surface exist; review remains in existing ownership surfaces | Full considered/excluded/supplied recall audit closes |
| [Memory And Skill Learning](memory-and-skill-learning-implementation-plan.md) | S0/S1 source implementation in progress on an isolated delivery branch | Learning jobs, definition revisions/undo, UI, optional semantic recall and Wiki acceptance close |
| [Office Documents Native Plugin](office-documents-native-plugin-implementation-plan.md) | Source implementation and automated acceptance are complete | Real Excel/WPS acceptance and Windows/macOS packaged driver gates close |
| [Sidebar, Approval, And Proposal Dialogs](sidebar-approval-proposal-dialogs-implementation-plan.md) | Sidebar context previews, runtime approval queue, and channel proposal dialog boundaries are defined | Focused Web, Playwright, and real-browser acceptance across all three surfaces closes |
| [Thread-First Work History](thread-first-work-history-implementation-plan.md) | V1/V2 storage, evidence, archive and fork foundations exist | Diagnostics UI placement and remaining V2 work close |
| [Desktop Theme Persistence](ui2.0升级/modules/settings/10-Desktop-Theme-Pack-Persistence-implementation-plan.md) | Web, repository and Apple Silicon implementation exist | Intel macOS and Windows packaged gates pass |

| [Shared Component Theme Presentation](component-theme-presentation-implementation-plan.md) | Local implementation complete: shared appearance ownership, Night/Ocean/Journey refinement, 85 UI + 26 conversation tests, Web build/lint and browser cases pass; current evidence is in [validation](component-theme-presentation-validation.md) | User art review; real daemon/model paths and signed Desktop acceptance remain unverified; no theme PR or merge in this round |
| [Official Scene Themes And Custom Media Background](full-window-theme-background-implementation-plan.md) | Six built-in themes are implemented locally; custom PNG/JPEG/static WebP/MP4/WebM overrides remain local under the hardening contract | Final visual review, public-redistribution clearance, signed macOS/Windows packages, native drag/drop, resource budgets and assistive-technology gates remain open |
| [Ling Journey UI Visual Adaptation](ling-journey-ui-adaptation-implementation-plan.md) | P0–P6 basic palette/background and functional checks exist; component refinement and shared conversation surface adaptation are local | Current local test/screenshot results and remaining Desktop acceptance boundaries are maintained in the hardening contract; no theme PR or merge in this round |

## Pending Product Reopening Or Architecture Decision

| Work | Decision required |
|---|---|
| [External Agent Skill Discovery And Adoption](external-agent-skill-discovery.md) | Approve the **Local skill folders** section, fixed `.agents/skills` scope, client-local ignore, and the P16 boundary guards before the UI slice is accepted; implementation plan tracks remaining gates |
| [Core Tools Runtime Boundary](core-tools-runtime-boundary-implementation-plan.md) | Approve removal of built-in tools from Plugin presentation while preserving approval and diagnostics ownership |
| [Mobile Remote Access](mobile-remote-access-implementation-plan.md) | Mobile remains outside current acceptance until explicitly reopened after security review |
| [Work Board Reopening](ui2.0升级/modules/14-Work-Board-implementation-plan.md) | Reopen only after workspace projection and fresh browser acceptance |
| [Startup And Diagnostics Reopening](ui2.0升级/modules/settings/08-Startup与Diagnostics-implementation-plan.md) | Reopen only after product-copy and current-state revalidation |
| [Workspace Tools Embedded Reopening](ui2.0升级/modules/settings/09-Workspace-Tools嵌入态-implementation-plan.md) | Reopen only after shared shell, scroll and overlay revalidation |

## Tracked Follow-Ups Without Active Delivery Plan

These are real gaps, but they must not be described as currently scheduled work.

| Contract | Remaining boundary |
|---|---|
| [Provider Hardening And Media Adapters](provider-hardening-and-media-adapter-completion.md) | Jimeng live generation and stored-artifact image-edit materialization |
| [Two-Layer Configuration](two-layer-configuration.md) | Provider-profile cleanup and remaining Keychain migration, shared with [runtime inheritance](runtime-provider-secrets-inheritance.md) |
| [Workspace State Storage](workspace-state-storage.md) | Opt-in rollout and remaining migration ownership |
| [AI Councils](ai-councils.md) | Council runtime and remaining product surfaces |
| [Governance Notifications](channel-and-agent-governance-notifications.md) | Teammate-private delivery and Ling Agent/workspace digest |
| [Conversation Memory Citations](conversation-memory-citations-and-sources.md) | Transcript citation footer and active source presentation |
| [Conversation Activity Summary And Exploration Batching](conversation-activity-summary-and-exploration-batching-detailed-design.md) | Approved reversible presentation projection; implementation pending |
| [Input Materialization](input-materialization-detailed-design.md) | Remaining rich-input materializers and ownership gates |
| [Media Production Image To Video](media-production-image-to-video-detailed-design.md) | Source implementation is locally verified; real Provider acceptance still requires explicit paid authorization |
| [Multi-Agent App](multi-agent-app-detailed-design.md) | Next multi-agent protocol and product slices |
| [Native Skill Recording](ling-native-skill-recording-p0-detailed-design.md) | Message-overflow and Settings follow-up entry points |
| [SQLite Modularization](sqlite-storage-modularization-next-slices.md) | Further split only after transaction and coordinator ownership is designed |
| [Automations](automations.md) | Richer monitor sources, desktop notification policy and external destinations |

## Reference Contracts, Not Separate Queues

| Document | Role |
|---|---|
| [External Work Roadmap](external-work-roadmap.md) | Shipped phase ledger and ordering authority for the active 8.x plans |
| [Conversation Plan And Goal Modes](conversation-plan-and-goal-modes.md) | Active product and control-plane contract |
| [Runtime Control Plane Roadmap](runtime-control-plane-roadmap.md) | Single phased roadmap for operator, daemon-owned state and transport evolution |
| [Runtime Control Plane Detailed Design](runtime-control-plane-detailed-design.md) | Object, API, event, ownership and verification contract |

## Maintenance Rules

- Update this index in the same change that changes a material work status.
- Do not infer implementation state from filenames or old phase numbers.
- A completed plan must move durable rules into its owning contract and be deleted.
- A real but unscheduled gap belongs in the tracked-follow-up table, not the active queue.
- Platform evidence plans remain only while a real signing, architecture or target-platform
  gate is open.
- Security, approval, recovery, migration and release boundaries require explicit review
  before consolidation.
