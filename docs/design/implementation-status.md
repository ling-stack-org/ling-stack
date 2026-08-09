# Ling Implementation Status Index

Status: current planning index
Owner: repository maintainers
Last verified: 2026-08-10
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
| [Channel Conversation Continuity v2](channel-conversation-continuity-v2-implementation-plan.md) | G0 and S0 merged; S1+S2, S3, and S4 implemented and locally verified | S5-S7, final migration, recovery, performance, security, eval, and Web E2E gates pass |
| [Channel Context Processing](channel-context-processing-layer-implementation-plan.md) | Channel and direct-message context views exist | Condensation, quote eligibility, persistence and redaction ownership are closed |
| [Permission Presets](codex-inspired-settings-permission-presets-implementation-plan.md) | Enforcement modes exist | Preset UI, effective preview and run audit agree with daemon enforcement |
| [Conversation Surface](conversation-surface-contract-implementation-plan.md) | Shared primitives and initial package extraction are implemented | WorkCell, evidence, attachment, package CSS and Desktop-consumption boundaries close |
| [Bundled CUA Driver](cua-driver-bundled-embedded-implementation-plan.md) | Packaging, integrity and platform foundations exist | Computer Control Settings surface and remaining signed platform gates close |
| [Desktop Computer Use PiP](desktop-computer-use-picture-in-picture-implementation-plan.md) | Renderer and fail-closed local harness exist | Signed macOS, Windows, assistive-technology and clean-host release gates pass |
| [External Work Phase 8.0](external-work-phase-8.0-adapter-registry-implementation.md) | Approved registry refactor; not yet implemented | Generic GitHub/Linear registry lands without behavior drift |
| [External Work Phase 8.1](external-work-phase-8.1-workspace-git-remote-implementation.md) | Approved checkout-hint plan; not yet implemented | `workspace.gitRemoteUrl` remains separate from provider identity and authority |
| [Ling Agent Session](ling-agent-session-implementation-plan.md) | Initial P1-P6 control-plane slices exist | Durable identity, instruction, report and execution ownership decisions close |
| [Memory Review Policy](memory-review-policy-implementation.md) | MRP.1-MRP.5 and first MRP.7 surface exist | Recall audit closes and global review-center decision is recorded |
| [Thread-First Work History](thread-first-work-history-implementation-plan.md) | V1/V2 storage, evidence, archive and fork foundations exist | Diagnostics UI placement and remaining V2 work close |
| [Desktop Theme Persistence](ui2.0升级/modules/settings/10-Desktop-Theme-Pack-Persistence-implementation-plan.md) | Web, repository and Apple Silicon implementation exist | Intel macOS and Windows packaged gates pass |

## Pending Product Reopening Or Architecture Decision

| Work | Decision required |
|---|---|
| [Core Tools Runtime Boundary](core-tools-runtime-boundary-implementation-plan.md) | Approve removal of built-in tools from Plugin presentation while preserving approval and diagnostics ownership |
| [External Agent Runner Adapters](external-agent-runner-adapters-implementation-plan.md) | Approve ACP/Codex/OpenClaw/Hermes adapters after readiness and conformance gates |
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
| [Input Materialization](input-materialization-detailed-design.md) | Remaining rich-input materializers and ownership gates |
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
