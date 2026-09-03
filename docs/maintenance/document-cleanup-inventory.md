# Documentation Governance And Cleanup Record

Status: cleanup completed locally; incremental documentation cleanup recorded
Baseline commit: `ea8c40e3a1f6a083df64c0a69e252805bc96a320`
Completed: 2026-09-03
Owner: repository maintainers
Last verified: 2026-09-03

## Outcome

The cleanup started with 549 Markdown files in the `docs/` working-tree baseline. After the
general cleanup, UI2 consolidation, and implementation-plan normalization, 213 Markdown
files remained. The open-source-readiness batch added two long-lived governance and
release documents, the data-revalidation contract, and the secondary-copy contract added
four current authorities. Subsequent conversation-continuity, Sidebar-stability, and Chrome
plugin work added four protected authorities. The 2026-08-27 incremental batch removed one
superseded selector and two completed Sidebar implementation plans, refreshed their inbound
links, and classified ten current documents that had been added since the previous ledger
update. The 2026-09-03 cleanup removed 38 test screenshots, removed three completed or
superseded documents from the default branch, and classified five still-current documents
plus the CI maintenance guide. The classified tree now contains 233 Markdown files, a net
reduction of 316 files.
The governance record, canonical design index, implementation-status index, publication
checklist, and release policy are the long-lived navigation documents.

Historical UI2 evidence was removed in the earlier cleanup. This batch also removed the
24 screenshots reintroduced under `docs/design/ui2.0升级/evidence/` and the 14 screenshots
under `docs/design/validation/sidebar-approval-dialogs-2026-08-26/`. The brand asset
`docs/design/assets/ling-stack-social-preview.png` remains because it is product artwork,
not test evidence. Git history remains the historical archive for deleted captures and
documents.

No runtime code, daemon API, database schema, migration, approval behavior, or release
state was changed by this cleanup.

## Executed Batches

| Batch | Removed | Result |
| --- | ---: | --- |
| Explicitly superseded first batch | 4 Markdown files | Current conversation and Team OS contracts now own the preserved invariants. |
| UI2 evidence | 107 Markdown files and 660 assets | Future captures belong in CI or Release artifacts. |
| UI2 execution history | 21 Markdown files | Foundations, architecture, components, modules, themes, migration contracts, and pending plans remain. |
| Channel version lineage | 33 Markdown files | Conversation Surface Contract and the UI2 Channel module are canonical. |
| Conversation and orchestration history | 13 Markdown files | Current conversation, operation-cell, state-machine, and orchestrator contracts remain. |
| Pre-UI2 product, Settings, and visual history | 40 Markdown files | UI2 contracts replace phase and convergence documents. |
| Completed plans and phase records | 51 Markdown files | Durable behavior remains in paired contracts; implementation history remains in Git. |
| UI2 contract consolidation | 55 net Markdown files | 101 UI2 documents became 46 current contracts, release/migration authorities, and active plans. |
| Implementation-plan normalization | 14 net Markdown files | Fifteen completed or duplicate plans were merged into contracts and replaced by one current status index. |
| Open-source readiness | 2 added Markdown files | Publication governance and release policy are now explicit long-lived authorities. |
| Data revalidation policy | 1 added Markdown file | Automatic focus revalidation replaces generic normal-state Refresh controls. |
| Secondary copy policy | 1 added Markdown file | Explanatory copy is limited to decisions, consequences, dynamic state, and recovery. |
| Incremental open-source documentation cleanup | 3 Markdown files | Removed one superseded selector reference and two completed Sidebar implementation plans; current contracts remain indexed. |
| 2026-09-03 document and screenshot cleanup | 38 screenshots and 3 Markdown files | Removed test captures and completed or superseded documents; current window, environment, internationalization, right-dock, and command-rule documents remain indexed. |

## Canonical Replacements

| Removed family | Canonical authority |
| --- | --- |
| Channel Workspace version documents | `conversation-surface-contract.md`, UI2 Conversation Surfaces |
| Collaboration cards and old conversation recovery plans | Conversation Surface Contract, Ling Agent Operation Cell UI |
| Product UX and Settings phase documents | UI2 product, foundation, component, and consolidated Settings contract |
| Skill implementation plans | Skill capability, ownership, import, editing, evolution, and source-sync contracts |
| Media canvas layout phases | Media Production Experience Refinement and Video Production Studio |
| External Work phases 2-7 | External Work Orchestration and current phase 8 adapter contracts |
| Plugin and Model Workbench layout phases | Plugin Manager and UI2 Model Workbench |
| UI screenshot and run evidence | CI or Release artifacts; UI2 Acceptance Contract keeps stable acceptance rules |
| Internationalization alignment and completed parity plans | Internationalization And Language Parity contract |
| Completed macOS titlebar layout plan | Codex Window Shell Parity contract |

## Retained Classification

Every remaining Markdown file is classified by the following closed rules. There are no
unclassified or review-pending files.

| Retained class | Files | Rule |
| --- | ---: | --- |
| `CANONICAL_CONTRACT` - product and architecture contracts | 124 | Current capability or bounded subsystem authority |
| `PROTECTED_SAFETY_RUNTIME` - safety, migration, recovery, and runtime contracts | 29 | Deletion requires explicit security or architecture review |
| `ACTIVE_PROTECTED_PLAN` - active or protected implementation plans | 21 | Material work remains, or the plan is part of a high-risk implementation boundary |
| `ADR_RELEASE_API` - ADR, release, and daemon API authority | 9 | Permanent architecture or release evidence |
| `UI2_CONTRACT` - UI2 contracts | 40 | Current foundation, architecture, component, module, theme, and index rules |
| `UI2_MIGRATION_RELEASE` - UI2 migration and release authority | 2 | One compatibility record and one packaged Desktop release checklist |
| `UI2_ACTIVE_PLAN` - active UI2 implementation plans | 4 | Work Board, Startup/Diagnostics, Workspace Tools, and protected Desktop theme publication |
| `GOVERNANCE_INDEX` - governance and indexes | 4 | Canonical design index, implementation-status index, cleanup record, and publication checklist |
| **Total** | **233** | |

## Path Classification

This closed manifest classifies every Markdown file currently under `docs/`. Classes are
mutually exclusive and use the retained-class definitions above. Update this table and the
aggregate counts in the same change whenever a document is added, deleted or reclassified.

| Path | Retained class |
| --- | --- |
| `docs/adr/0001-platform-kernel-and-extension-host.md` | `ADR_RELEASE_API` |
| `docs/adr/README.md` | `ADR_RELEASE_API` |
| `docs/architecture.md` | `CANONICAL_CONTRACT` |
| `docs/daemon-api.md` | `ADR_RELEASE_API` |
| `docs/design/README.md` | `GOVERNANCE_INDEX` |
| `docs/design/ai-councils.md` | `CANONICAL_CONTRACT` |
| `docs/design/ai-teammate-custom-create-flow.md` | `CANONICAL_CONTRACT` |
| `docs/design/ai-teammate-default-avatars.md` | `CANONICAL_CONTRACT` |
| `docs/design/ai-teammate-private-workspace.md` | `CANONICAL_CONTRACT` |
| `docs/design/ai-teammates-and-skills.md` | `CANONICAL_CONTRACT` |
| `docs/design/approval-policy.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/automations.md` | `CANONICAL_CONTRACT` |
| `docs/design/channel-and-agent-governance-notifications.md` | `CANONICAL_CONTRACT` |
| `docs/design/channel-auto-reply-router.md` | `CANONICAL_CONTRACT` |
| `docs/design/channel-context-budget-manager.md` | `CANONICAL_CONTRACT` |
| `docs/design/channel-context-processing-layer-implementation-plan.md` | `ACTIVE_PROTECTED_PLAN` |
| `docs/design/channel-context-processing-layer.md` | `CANONICAL_CONTRACT` |
| `docs/design/channel-conversation-continuity-v2.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/channel-environment-information-hierarchy.md` | `CANONICAL_CONTRACT` |
| `docs/design/channel-execution-completion-implementation-plan.md` | `ACTIVE_PROTECTED_PLAN` |
| `docs/design/channel-message-streaming.md` | `CANONICAL_CONTRACT` |
| `docs/design/channel-settings-tabbed-information-architecture.md` | `CANONICAL_CONTRACT` |
| `docs/design/channel-team-operating-system.md` | `CANONICAL_CONTRACT` |
| `docs/design/chrome-browser-built-in-plugin-implementation-plan.md` | `ACTIVE_PROTECTED_PLAN` |
| `docs/design/chrome-browser-built-in-plugin.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/cli-run-io-completion-p1.md` | `CANONICAL_CONTRACT` |
| `docs/design/cli-v0.1.md` | `CANONICAL_CONTRACT` |
| `docs/design/codex-inspired-runtime-tools-p2-permissions-shell-snapshots.md` | `CANONICAL_CONTRACT` |
| `docs/design/codex-inspired-runtime-tools-p2b-shell-snapshots-follow-ups.md` | `CANONICAL_CONTRACT` |
| `docs/design/codex-inspired-runtime-tools.md` | `CANONICAL_CONTRACT` |
| `docs/design/codex-inspired-settings-permission-presets-implementation-plan.md` | `ACTIVE_PROTECTED_PLAN` |
| `docs/design/codex-inspired-settings-permission-presets.md` | `CANONICAL_CONTRACT` |
| `docs/design/codex-like-execution.md` | `CANONICAL_CONTRACT` |
| `docs/design/codex-style-hunk-diff-review.md` | `CANONICAL_CONTRACT` |
| `docs/design/codex-window-shell-parity.md` | `CANONICAL_CONTRACT` |
| `docs/design/contracts-api-client.md` | `CANONICAL_CONTRACT` |
| `docs/design/conversation-activity-summary-and-exploration-batching-detailed-design.md` | `CANONICAL_CONTRACT` |
| `docs/design/conversation-command-execution-batching-detailed-design.md` | `CANONICAL_CONTRACT` |
| `docs/design/conversation-composer-unification.md` | `CANONICAL_CONTRACT` |
| `docs/design/conversation-media-generation-tools.md` | `CANONICAL_CONTRACT` |
| `docs/design/conversation-media-generation-tools-implementation-plan.md` | `ACTIVE_PROTECTED_PLAN` |
| `docs/design/conversation-memory-citations-and-sources.md` | `CANONICAL_CONTRACT` |
| `docs/design/conversation-model-binding-and-creation-validation.md` | `CANONICAL_CONTRACT` |
| `docs/design/conversation-performance-deferral-and-virtualization.md` | `CANONICAL_CONTRACT` |
| `docs/design/conversation-plan-and-goal-modes.md` | `CANONICAL_CONTRACT` |
| `docs/design/conversation-right-dock-responsive-visibility-implementation-plan.md` | `ACTIVE_PROTECTED_PLAN` |
| `docs/design/conversation-right-dock-workspace-tools.md` | `CANONICAL_CONTRACT` |
| `docs/design/conversation-session-full-access-confirmation.md` | `CANONICAL_CONTRACT` |
| `docs/design/conversation-shared-capabilities-detailed-design.md` | `CANONICAL_CONTRACT` |
| `docs/design/conversation-shared-capabilities.md` | `CANONICAL_CONTRACT` |
| `docs/design/conversation-surface-contract-implementation-plan.md` | `ACTIVE_PROTECTED_PLAN` |
| `docs/design/conversation-surface-contract.md` | `CANONICAL_CONTRACT` |
| `docs/design/conversation-surface-taxonomy.md` | `CANONICAL_CONTRACT` |
| `docs/design/core-tools-runtime-boundary-implementation-plan.md` | `ACTIVE_PROTECTED_PLAN` |
| `docs/design/core-tools-runtime-boundary.md` | `CANONICAL_CONTRACT` |
| `docs/design/cua-driver-bundled-embedded-detailed-design.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/cua-driver-bundled-embedded-implementation-plan.md` | `ACTIVE_PROTECTED_PLAN` |
| `docs/design/cua-driver-bundled-embedded.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/cua-driver-guided-installation-detailed-design.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/cua-driver-guided-installation.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/data-revalidation-and-manual-refresh-policy.md` | `CANONICAL_CONTRACT` |
| `docs/design/daemon-lifecycle-p0.md` | `CANONICAL_CONTRACT` |
| `docs/design/daemon-modularization.md` | `CANONICAL_CONTRACT` |
| `docs/design/desktop-adaptive-layout-model-workbench.md` | `CANONICAL_CONTRACT` |
| `docs/design/desktop-computer-use-picture-in-picture-detailed-design.md` | `CANONICAL_CONTRACT` |
| `docs/design/desktop-computer-use-picture-in-picture-implementation-plan.md` | `ACTIVE_PROTECTED_PLAN` |
| `docs/design/desktop-computer-use-picture-in-picture.md` | `CANONICAL_CONTRACT` |
| `docs/design/desktop-shell.md` | `CANONICAL_CONTRACT` |
| `docs/design/execution-orchestration-hardening.md` | `CANONICAL_CONTRACT` |
| `docs/design/external-agent-runner-adapters-implementation-plan.md` | `ACTIVE_PROTECTED_PLAN` |
| `docs/design/external-runtime-decision-hermes.md` | `CANONICAL_CONTRACT` |
| `docs/design/external-work-ga-hardening.md` | `CANONICAL_CONTRACT` |
| `docs/design/external-work-multi-forge-adapters.md` | `CANONICAL_CONTRACT` |
| `docs/design/external-work-orchestration.md` | `CANONICAL_CONTRACT` |
| `docs/design/external-work-phase-8.0-adapter-registry-implementation.md` | `ACTIVE_PROTECTED_PLAN` |
| `docs/design/external-work-phase-8.1-workspace-git-remote-implementation.md` | `ACTIVE_PROTECTED_PLAN` |
| `docs/design/external-work-roadmap.md` | `ACTIVE_PROTECTED_PLAN` |
| `docs/design/external-work-status-surface.md` | `CANONICAL_CONTRACT` |
| `docs/design/github-automation.md` | `CANONICAL_CONTRACT` |
| `docs/design/global-feedback-toast-system.md` | `CANONICAL_CONTRACT` |
| `docs/design/gstack-skill-source-sync.md` | `CANONICAL_CONTRACT` |
| `docs/design/gstack-source-upgrade-lifecycle.md` | `CANONICAL_CONTRACT` |
| `docs/design/implementation-status.md` | `GOVERNANCE_INDEX` |
| `docs/design/inline-runtime-approval-detailed-design.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/input-materialization-detailed-design.md` | `CANONICAL_CONTRACT` |
| `docs/design/internal-registry-plugin-sdk.md` | `CANONICAL_CONTRACT` |
| `docs/design/internationalization-language-parity.md` | `CANONICAL_CONTRACT` |
| `docs/design/ling-agent-operation-cell-ui.md` | `CANONICAL_CONTRACT` |
| `docs/design/ling-agent-session-implementation-plan.md` | `ACTIVE_PROTECTED_PLAN` |
| `docs/design/ling-agent-session.md` | `CANONICAL_CONTRACT` |
| `docs/design/ling-agent-terminal-report-protocol.md` | `CANONICAL_CONTRACT` |
| `docs/design/ling-design-system.md` | `CANONICAL_CONTRACT` |
| `docs/design/ling-framework.md` | `CANONICAL_CONTRACT` |
| `docs/design/ling-memory-v1.md` | `CANONICAL_CONTRACT` |
| `docs/design/ling-native-skill-recording-p0-detailed-design.md` | `CANONICAL_CONTRACT` |
| `docs/design/ling-web-tools.md` | `CANONICAL_CONTRACT` |
| `docs/design/local-service-manager.md` | `CANONICAL_CONTRACT` |
| `docs/design/locked-computer-control-detailed-design.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/locked-computer-control-policy.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/managed-official-skill-source-p16.md` | `CANONICAL_CONTRACT` |
| `docs/design/managed-worktree-lifecycle.md` | `CANONICAL_CONTRACT` |
| `docs/design/mcp-status-boundaries-p2.md` | `CANONICAL_CONTRACT` |
| `docs/design/media-automations-workbench-refinement.md` | `CANONICAL_CONTRACT` |
| `docs/design/media-production-experience-refinement.md` | `CANONICAL_CONTRACT` |
| `docs/design/media-production-external-workflows.md` | `CANONICAL_CONTRACT` |
| `docs/design/media-production-image-to-video-detailed-design.md` | `CANONICAL_CONTRACT` |
| `docs/design/memory-health-and-fanin.md` | `CANONICAL_CONTRACT` |
| `docs/design/memory-review-policy-implementation.md` | `ACTIVE_PROTECTED_PLAN` |
| `docs/design/mobile-approval-and-creation-detailed-design.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/mobile-conversation-ui2-detailed-design.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/mobile-remote-access-detailed-design.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/mobile-remote-access-implementation-plan.md` | `ACTIVE_PROTECTED_PLAN` |
| `docs/design/mobile-remote-access.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/model-workbench-video-production-studio.md` | `CANONICAL_CONTRACT` |
| `docs/design/multi-agent-app-detailed-design.md` | `CANONICAL_CONTRACT` |
| `docs/design/multi-agent-orchestration-experience.md` | `CANONICAL_CONTRACT` |
| `docs/design/multi-agent-orchestrator.md` | `CANONICAL_CONTRACT` |
| `docs/design/multi-agent-slash-commands.md` | `CANONICAL_CONTRACT` |
| `docs/design/multi-channel-concurrency.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/office-documents-native-plugin-implementation-plan.md` | `ACTIVE_PROTECTED_PLAN` |
| `docs/design/office-documents-native-plugin.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/openai-agents-sdk-adapter-decision-record.md` | `CANONICAL_CONTRACT` |
| `docs/design/openai-agents-sdk-runtime-patterns.md` | `CANONICAL_CONTRACT` |
| `docs/design/orchestrator-advanced.md` | `CANONICAL_CONTRACT` |
| `docs/design/platform-architecture.md` | `CANONICAL_CONTRACT` |
| `docs/design/plugin-manager-add-local-plugin.md` | `CANONICAL_CONTRACT` |
| `docs/design/plugin-manager.md` | `CANONICAL_CONTRACT` |
| `docs/design/post-compaction-snapshot-restore.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/post-compaction-undo.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/provider-domestic-templates.md` | `CANONICAL_CONTRACT` |
| `docs/design/provider-generation-runtime.md` | `CANONICAL_CONTRACT` |
| `docs/design/provider-hardening-and-media-adapter-completion.md` | `CANONICAL_CONTRACT` |
| `docs/design/provider-presets.md` | `CANONICAL_CONTRACT` |
| `docs/design/provider-runner-internal-modularization.md` | `CANONICAL_CONTRACT` |
| `docs/design/run-interruption-continuation.md` | `CANONICAL_CONTRACT` |
| `docs/design/run-store-facets.md` | `CANONICAL_CONTRACT` |
| `docs/design/runner-adapters.md` | `CANONICAL_CONTRACT` |
| `docs/design/runner-registry.md` | `CANONICAL_CONTRACT` |
| `docs/design/runtime-control-plane-detailed-design.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/runtime-control-plane-roadmap.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/runtime-provider-secrets-inheritance.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/runtime-supervisor.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/secrets-keychain.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/secondary-copy-and-information-density.md` | `CANONICAL_CONTRACT` |
| `docs/design/session-persistence.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/settings-advanced-workspace-policy-productization.md` | `CANONICAL_CONTRACT` |
| `docs/design/settings-archived-items-permanent-delete.md` | `CANONICAL_CONTRACT` |
| `docs/design/sidebar-approval-proposal-dialogs-implementation-plan.md` | `ACTIVE_PROTECTED_PLAN` |
| `docs/design/sidebar-archive-conversations-teammates.md` | `CANONICAL_CONTRACT` |
| `docs/design/skill-candidates-and-protocol-governance.md` | `CANONICAL_CONTRACT` |
| `docs/design/skill-capability-model-and-library-simplification.md` | `CANONICAL_CONTRACT` |
| `docs/design/skill-context-optimization.md` | `CANONICAL_CONTRACT` |
| `docs/design/skill-editing-and-revision.md` | `CANONICAL_CONTRACT` |
| `docs/design/skill-import-productization.md` | `CANONICAL_CONTRACT` |
| `docs/design/skill-library-height-and-ai-evolution-lifecycle.md` | `CANONICAL_CONTRACT` |
| `docs/design/skill-library-ownership-separation.md` | `CANONICAL_CONTRACT` |
| `docs/design/skill-source-sync-simplification-p15.md` | `CANONICAL_CONTRACT` |
| `docs/design/sqlite-storage-ling-and-domain-slices.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/sqlite-storage-modularization-next-slices.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/startup-readiness-chain.md` | `CANONICAL_CONTRACT` |
| `docs/design/state-machine-recovery.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/thread-first-work-history-implementation-plan.md` | `ACTIVE_PROTECTED_PLAN` |
| `docs/design/thread-first-work-history-v2-detailed-design.md` | `CANONICAL_CONTRACT` |
| `docs/design/thread-first-work-history.md` | `CANONICAL_CONTRACT` |
| `docs/design/two-layer-configuration.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/design/ui2.0升级/00-UI2.0整体升级方案.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/03-UI2.0验收总规范.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/README.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/architecture/01-ui-react共享包架构.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/architecture/02-Radix交互边界.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/architecture/03-CSS所有权与迁移规则.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/architecture/04-Web适配层与Desktop复用.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/architecture/07-主题注册表与运行时切换.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/components/01-基础控件与表单.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/components/02-浮层与反馈.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/components/03-导航与数据展示.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/components/04-会话与Composer.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/components/05-图标与主题控件.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/components/06-Desktop紧凑窗口.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/foundations/01-视觉语言与设计原则.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/foundations/02-Design-Tokens与主题.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/foundations/03-布局栅格与页面骨架.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/foundations/04-交互动效与无障碍.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/foundations/05-Web与Desktop表面规范.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/foundations/06-i18n与产品文案.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/foundations/07-Iconography与图标色系.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/migration/README.md` | `UI2_MIGRATION_RELEASE` |
| `docs/design/ui2.0升级/modules/01-AppShell与全局导航.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/modules/03-首次使用与初始化.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/modules/04-会话界面.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/modules/07-AI队友管理.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/modules/08-Council-Workspace.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/modules/09-Model-Workbench.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/modules/10-Plugin-Manager.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/modules/11-自动化运行与审批.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/modules/12-媒体生产.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/modules/14-Work-Board-implementation-plan.md` | `UI2_ACTIVE_PLAN` |
| `docs/design/ui2.0升级/modules/14-Work-Board.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/modules/17-Profile.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/modules/18-Desktop-Client-Shell.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/modules/19-Desktop-Computer-Use-PiP.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/modules/settings/08-Startup与Diagnostics-implementation-plan.md` | `UI2_ACTIVE_PLAN` |
| `docs/design/ui2.0升级/modules/settings/09-Workspace-Tools嵌入态-implementation-plan.md` | `UI2_ACTIVE_PLAN` |
| `docs/design/ui2.0升级/modules/settings/10-Desktop-Theme-Pack-Persistence-implementation-plan.md` | `UI2_ACTIVE_PLAN` |
| `docs/design/ui2.0升级/modules/settings/README.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/release/01-Desktop跨平台发布验收清单.md` | `UI2_MIGRATION_RELEASE` |
| `docs/design/ui2.0升级/themes/01-独立主题包产品模型.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/themes/02-主题包Schema与Token合同.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/themes/05-主题资源导入与安全.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/themes/07-AI生成主题产品流程.md` | `UI2_CONTRACT` |
| `docs/design/ui2.0升级/themes/README.md` | `UI2_CONTRACT` |
| `docs/design/web-api-facade-modularization.md` | `CANONICAL_CONTRACT` |
| `docs/design/web-appshell-domain-modularization.md` | `CANONICAL_CONTRACT` |
| `docs/design/web-e2e-acceptance-matrix.md` | `CANONICAL_CONTRACT` |
| `docs/design/web-modularization.md` | `CANONICAL_CONTRACT` |
| `docs/design/work-board-review-queue.md` | `CANONICAL_CONTRACT` |
| `docs/design/work-history-ia-cleanup.md` | `CANONICAL_CONTRACT` |
| `docs/design/workspace-change-review-recovery-and-open-actions.md` | `CANONICAL_CONTRACT` |
| `docs/design/workspace-command-rule-approval-implementation-plan.md` | `ACTIVE_PROTECTED_PLAN` |
| `docs/design/workspace-state-storage.md` | `PROTECTED_SAFETY_RUNTIME` |
| `docs/external-work-live-smoke.md` | `CANONICAL_CONTRACT` |
| `docs/maintenance/ci.md` | `ADR_RELEASE_API` |
| `docs/maintenance/document-cleanup-inventory.md` | `GOVERNANCE_INDEX` |
| `docs/maintenance/open-source-readiness.md` | `GOVERNANCE_INDEX` |
| `docs/pi-coding-agent-integration.md` | `CANONICAL_CONTRACT` |
| `docs/product-design.md` | `CANONICAL_CONTRACT` |
| `docs/provider-adapters.md` | `CANONICAL_CONTRACT` |
| `docs/release/desktop-windows-release-decisions.md` | `ADR_RELEASE_API` |
| `docs/release/desktop.md` | `ADR_RELEASE_API` |
| `docs/release/evidence/README.md` | `ADR_RELEASE_API` |
| `docs/release/locked-computer-control-windows-handoff.md` | `ADR_RELEASE_API` |
| `docs/release/README.md` | `ADR_RELEASE_API` |
| `docs/seedream-live-smoke.md` | `CANONICAL_CONTRACT` |

## Protected Boundaries

The cleanup retained:

- approval, permission, sandbox, secret, and authority policy;
- SQLite schema and migration rationale;
- state machines, idempotency, recovery, and concurrency;
- daemon/public API and contract boundaries;
- remote access and mobile approval security material, while Mobile remains outside the
  current product acceptance scope;
- CUA Driver, locked-computer control, PiP, native signing, release, and supply-chain
  evidence;
- active runtime control-plane and external-adapter plans.

## Active Plan Rule

An implementation plan may remain only when at least one material boundary is unfinished,
platform-scoped, intentionally hidden pending product work, or safety-sensitive. The current
authoritative list is [Ling Implementation Status](../design/implementation-status.md). It separates
active work, pending product decisions, protected platform gates and reference-only roadmaps.

When one of these plans completes, merge durable rules into its owning contract and
delete the plan in the same change.

## Evidence Policy

- Do not add screenshot folders, metadata diaries, per-run hashes, or test-by-test
  closeout logs under `docs/design`.
- Publish ephemeral UI and runtime evidence through CI or Release artifacts with an
  explicit retention period.
- Keep only stable acceptance rules, platform handoff summaries, signed release
  attestations, and schemas in the repository.
- Do not recreate a historical archive directory. Use Git history.

## Document Lifecycle

Every new long-lived document must declare:

- status and owner;
- last verified date;
- canonical replacement when superseded;
- code and test anchors;
- whether it is a product contract, architecture decision, protected detailed design,
  active implementation plan, or release authority.

Broad Ling features still start with a contract and an implementation plan. Completion
includes consolidating or deleting that implementation plan so the documentation tree
does not become an append-only work log.
