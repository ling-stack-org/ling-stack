# Changelog

All notable user-visible changes will be documented in this file from the public
open-source baseline onward.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and future
release versions will follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Public contribution, support, security, and community-governance documents.
- GitHub Issue Forms, pull request template, CODEOWNERS, Dependabot, and generic CI.
- Local Markdown-link, dependency-license, and public-repository safety checks.

### Changed

- Removed the duplicate normal-conversation processing card while Ling Agent is only
  thinking, while preserving action, approval, and report evidence.
- Simplified conversation message identity chrome and removed duplicate terminal-report
  artifact and file-reference presentation.
- Reworked the root README around the current source-first Alpha product and verified
  startup path.
- Consolidated the design documentation around current contracts and implementation
  status instead of completed implementation diaries.

### Fixed

- Channels and private teammate chats now continue in the selected Local workspace when
  Git is unavailable or the directory is not a Git repository, while missing workspaces
  and explicit managed-worktree creation still fail closed.

Historical changes before this baseline remain available in Git history. They are not
retroactively reconstructed as release notes.
