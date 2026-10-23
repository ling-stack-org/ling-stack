# Changelog

All notable user-visible changes will be documented in this file from the public
open-source baseline onward.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and future
release versions will follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Unified workspace summaries show sessions, net Git changes, recent commits, and
  linked pull requests in the existing Summary panel. Change details open in the
  current conversation's right review drawer.

### Changed

- Normal conversations now combine model selection and reasoning strength in one
  compact popover, with three approval shortcuts beside the input. Sandbox and
  independent authorization defaults remain in Settings.
- Simplified the public README and added source setup, troubleshooting, and platform
  development-package instructions with a fresh workspace screenshot.

### Fixed

- Source setup now documents and checks Rust/Cargo requirements, and doctor suggests
  the source CLI command when invoked through pnpm.
- Built-in skills no longer show epoch placeholder dates. Chinese skill metadata,
  permission menu labels, and the QA role now stay translated.
- Run history retains its lazy-loaded Web chunk.
- Desktop packaging now starts the installed Electron Builder CLI directly with Node,
  avoiding Windows `.cmd` shim execution failures while preserving governed arguments.

## [0.1.2-alpha.1] - 2026-08-27

### Added

- Durable Channel execution completion now tracks required participants, operation evidence,
  fan-in, final reports, and source-turn settlement as one recoverable workflow lineage.
- Public contribution, support, security, and community-governance documents.
- GitHub Issue Forms, pull request template, CODEOWNERS, Dependabot, and generic CI.
- Local Markdown-link, dependency-license, and public-repository safety checks.
- A neutral public product screenshot and explicit Chrome, Plugin Manager, Office native,
  MCP/local-tool, and model-provider integration boundaries in the root README.

### Changed

- Accepted Channel turns now survive daemon and stream reconnects, including approval waits
  that resume on the same logical Run with a new process attempt.
- Removed the duplicate normal-conversation processing card while Ling Agent is only
  thinking, while preserving action, approval, and report evidence.
- Simplified conversation message identity chrome and removed duplicate terminal-report
  artifact and file-reference presentation.
- Reworked the root README around the current source-first Alpha product and verified
  startup path.
- Consolidated the design documentation around current contracts and implementation
  status instead of completed implementation diaries.
- Moved native runner, signing, and Desktop artifact workflows out of the public source
  repository boundary.
- Unified the product release version as Semantic Versioning across `VERSION`, the root
  package, Desktop package, and changelog.

### Fixed

- Delegated Agent promise/ready text can no longer complete work without tool or output
  evidence, and missing participant model bindings now fail before creating a workflow or Run.
- Channels and private teammate chats now continue in the selected Local workspace when
  Git is unavailable or the directory is not a Git repository, while missing workspaces
  and explicit managed-worktree creation still fail closed.

## [0.1.1] - 2026-08-26

### Fixed

- Channel message feeds no longer move sideways when wide execution content is swiped or
  horizontally scrolled; switching channels and jumping to the latest message also clear
  any stale horizontal offset.
- Added browser regression coverage for contained horizontal gestures and offset resets.

## [0.1.0] - 2026-08-25

### Added

- Structured channel transcripts now keep canonical conversation items and render tool calls,
  tool results, approvals, handoffs, artifacts, operations, and final results in typed content
  layers instead of mixing them into ordinary prose.
- Added focused unit and browser coverage for structured content projection, stream updates,
  visibility boundaries, status semantics, and legacy-item deduplication.

### Changed

- Channel transcript projection now preserves canonical item revisions, domain references, and
  stable ordering across initial loads, stream events, and pagination.

### Fixed

- Operator-only and agent-private content is excluded from channel transcripts, while failed and
  cancelled tool and approval states retain their correct visible status.
- Stale channel or thread refreshes can no longer overwrite the currently selected conversation.

Historical changes before this baseline remain available in Git history. They are not
retroactively reconstructed as release notes.
