# Changelog

All notable user-visible changes will be documented in this file from the public
open-source baseline onward.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and future
release versions will follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0.0] - 2026-08-25

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

## [Unreleased]

### Added

- Durable Channel execution completion now tracks required participants, operation evidence,
  fan-in, final reports, and source-turn settlement as one recoverable workflow lineage.
- Public contribution, support, security, and community-governance documents.
- GitHub Issue Forms, pull request template, CODEOWNERS, Dependabot, and generic CI.
- Local Markdown-link, dependency-license, and public-repository safety checks.

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

### Fixed

- Delegated Agent promise/ready text can no longer complete work without tool or output
  evidence, and missing participant model bindings now fail before creating a workflow or Run.
- Channels and private teammate chats now continue in the selected Local workspace when
  Git is unavailable or the directory is not a Git repository, while missing workspaces
  and explicit managed-worktree creation still fail closed.

Historical changes before this baseline remain available in Git history. They are not
retroactively reconstructed as release notes.
