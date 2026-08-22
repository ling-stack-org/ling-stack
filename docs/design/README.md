# Ling Design Documentation

Status: canonical documentation index
Owner: repository maintainers
Last verified: 2026-08-22
Document type: governance index
Code and test anchors: each linked contract owns its anchors

## Purpose

This directory keeps current product contracts, long-lived architecture decisions, and
security, migration, recovery, API, and release boundaries. Completed implementation
plans, version-by-version UI history, and screenshot evidence belong in Git history or
CI/Release artifacts instead of the default documentation tree.

## Product And Architecture

- [Implementation Status](implementation-status.md)
- [Product Design](../product-design.md)
- [Architecture](../architecture.md)
- [Platform Architecture](platform-architecture.md)
- [Ling Framework](ling-framework.md)
- [Contracts And API Client](contracts-api-client.md)
- [Daemon API](../daemon-api.md)
- [Architecture Decision Records](../adr/README.md)

## Conversations And Channels

- [Conversation Surface Contract](conversation-surface-contract.md)
- [Conversation Surface Taxonomy](conversation-surface-taxonomy.md)
- [Conversation Composer Unification](conversation-composer-unification.md)
- [Conversation Model Binding And Creation Validation](conversation-model-binding-and-creation-validation.md)
- [Conversation Full Access Confirmation](conversation-session-full-access-confirmation.md)
- [Conversation Right Dock Workspace Tools](conversation-right-dock-workspace-tools.md)
- [Conversation Shared Capabilities](conversation-shared-capabilities.md)
- [Run Interruption And Continuation](run-interruption-continuation.md)
- [Channel Context Processing Layer](channel-context-processing-layer.md)
- [Channel Team Operating System](channel-team-operating-system.md)
- [Ling Agent Session](ling-agent-session.md)
- [Ling Agent Terminal Report Protocol](ling-agent-terminal-report-protocol.md)
- [Thread-First Work History](thread-first-work-history.md)

## Teammates, Memory, And Skills

- [AI Teammate Private Workspace](ai-teammate-private-workspace.md)
- [AI Teammates And Skills](ai-teammates-and-skills.md)
- [AI Councils](ai-councils.md)
- [Ling Memory v1](ling-memory-v1.md)
- [Memory Health And Fan-In](memory-health-and-fanin.md)
- [Skill Capability Model](skill-capability-model-and-library-simplification.md)
- [Skill Library Ownership](skill-library-ownership-separation.md)
- [Skill Import Productization](skill-import-productization.md)
- [Skill Editing And Revision](skill-editing-and-revision.md)
- [Skill Library And AI Evolution](skill-library-height-and-ai-evolution-lifecycle.md)
- [Skill Source Sync](skill-source-sync-simplification-p15.md)

## Runtime, Security, And Storage

- [Approval Policy](approval-policy.md)
- [Inline Runtime Approval](inline-runtime-approval-detailed-design.md)
- [State Machines And Recovery](state-machine-recovery.md)
- [Multi-Channel Concurrency](multi-channel-concurrency.md)
- [Runtime Supervisor](runtime-supervisor.md)
- [Runtime Control Plane](runtime-control-plane-roadmap.md)
- [Secrets And Keychain](secrets-keychain.md)
- [Workspace State Storage](workspace-state-storage.md)
- [SQLite Storage Slices](sqlite-storage-ling-and-domain-slices.md)
- [Locked Computer Control](locked-computer-control-policy.md)
- [Bundled Computer Use Driver](cua-driver-bundled-embedded.md)
- [Remote Access Security Contract](mobile-remote-access.md)

The remote-access documents are retained for protocol and approval safety. Mobile is not
part of the current product acceptance scope.

## Models, Media, And Integrations

- [Provider Presets](provider-presets.md)
- [Provider Generation Runtime](provider-generation-runtime.md)
- [Video Production Studio](model-workbench-video-production-studio.md)
- [Media Production Experience](media-production-experience-refinement.md)
- [Media External Workflows](media-production-external-workflows.md)
- [Plugin Manager](plugin-manager.md)
- [Office Documents Native Plugin](office-documents-native-plugin.md)
- [Automations](automations.md)
- [External Work Orchestration](external-work-orchestration.md)

## Web, Desktop, And UI 2.0

- [UI 2.0 Documentation](ui2.0升级/README.md)
- [UI 2.0 Product Contract](ui2.0升级/00-UI2.0整体升级方案.md)
- [UI 2.0 Acceptance Contract](ui2.0升级/03-UI2.0验收总规范.md)
- [Ling Design System](ling-design-system.md)
- [Secondary Copy And Information Density](secondary-copy-and-information-density.md)
- [Data Revalidation And Manual Refresh Policy](data-revalidation-and-manual-refresh-policy.md)
- [Web Modularization](web-modularization.md)
- [Web E2E Acceptance Matrix](web-e2e-acceptance-matrix.md)
- [Desktop Shell](desktop-shell.md)
- [Desktop Release](../release/desktop.md)

## Open Source And Release

- [Open-Source Readiness Checklist](../maintenance/open-source-readiness.md)
- [Release Policy](../release/README.md)
- [Security Policy](../../SECURITY.md)
- [Contribution Guide](../../CONTRIBUTING.md)

## Retention Rules

- Keep one canonical product contract per capability or bounded subsystem.
- Keep an implementation plan only while material work remains unfinished.
- Keep detailed designs for complex protocols and safety, migration, recovery, API,
  native release, signing, and supply-chain boundaries.
- Move screenshots, test captures, hashes, and run-by-run evidence to CI or Release
  artifacts.
- Use Git history instead of creating an archive directory.
- Every new long-lived document must declare status, owner, last verification date,
  canonical replacement when applicable, and code or test anchors.
