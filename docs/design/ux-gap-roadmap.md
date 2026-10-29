# UX Gap Roadmap — Competitive Gap Checklist

## Status

Status: approved roadmap
Owner: Product / Web / Desktop
Last verified: 2026-10-26

This roadmap compares Ling against Codex Desktop, MiniMax Code (Agent Desktop),
ZCode, and WorkBuddy from the user's point of view, and tracks the resulting work.
Two candidate items were deliberately excluded at roadmap review:

- Installer signing and auto-update — cost/infrastructure decision, tracked in
  `apps/desktop/README.md` open gates, not a UX roadmap item.
- Out-of-the-box hosted model access — contradicts the open-source, local-first,
  BYOK position. Replaced by onboarding friction reduction (see item 02 companion
  notes in `ux-gap-roadmap-13-startup-diagnostics.md`).

## Items

Implementation status on this branch (2026-10-26):

- Implemented with tests: 03 (notifications + preferences; exportable
  reports and IM destinations delivered via 04's sink), 04 (webhook
  destinations, builders, egress pinning, signing), 02 (interactive HTML
  artifacts), 09 (Phase A: bind guard + bearer token), 10 (index contract +
  inspect route), 11 (voice dictation), 13 (startup diagnostics panel).
- Design-complete, code as follow-up slices on the same plan: 01 (document
  deliverables), 05 (built-in browser), 06 (computer use hardening),
  07 (memory citations), 08 (work board acceptance), 12 (pack export/import
  UI and browse surface beyond the inspect route).

| # | Doc | Item | Priority |
|---|-----|------|----------|
| 01 | [ux-gap-roadmap-01-document-deliverables.md](ux-gap-roadmap-01-document-deliverables.md) | Document deliverables (PPT/Word/Excel generation loop) | P0 |
| 02 | [ux-gap-roadmap-02-gen-ui-artifacts.md](ux-gap-roadmap-02-gen-ui-artifacts.md) | Interactive HTML artifacts (Gen UI) | P0 |
| 03 | [ux-gap-roadmap-03-notifications-automations-p3.md](ux-gap-roadmap-03-notifications-automations-p3.md) | Desktop notifications + Automations P3 closure | P1 |
| 04 | [ux-gap-roadmap-04-im-integrations.md](ux-gap-roadmap-04-im-integrations.md) | IM integrations (Feishu/WeCom/DingTalk/Slack) | P1 |
| 05 | [ux-gap-roadmap-05-built-in-browser.md](ux-gap-roadmap-05-built-in-browser.md) | Built-in browser automation | P1 |
| 06 | [ux-gap-roadmap-06-computer-use-hardening.md](ux-gap-roadmap-06-computer-use-hardening.md) | Computer Use hardening | P1 |
| 07 | [ux-gap-roadmap-07-memory-citations.md](ux-gap-roadmap-07-memory-citations.md) | Automatic memory + memory citations in transcripts | P1 |
| 08 | [ux-gap-roadmap-08-parallel-work-board.md](ux-gap-roadmap-08-parallel-work-board.md) | Parallel work board (multi-task dashboard) | P1 |
| 09 | [ux-gap-roadmap-09-cloud-tasks-sync.md](ux-gap-roadmap-09-cloud-tasks-sync.md) | Cloud task execution + cross-device sync | P2 |
| 10 | [ux-gap-roadmap-10-skill-marketplace.md](ux-gap-roadmap-10-skill-marketplace.md) | Skill/plugin marketplace and sharing | P2 |
| 11 | [ux-gap-roadmap-11-voice-input.md](ux-gap-roadmap-11-voice-input.md) | Voice input | P2 |
| 12 | [ux-gap-roadmap-12-spreadsheet-viewer.md](ux-gap-roadmap-12-spreadsheet-viewer.md) | Interactive spreadsheet viewer | P2 |
| 13 | [ux-gap-roadmap-13-startup-diagnostics.md](ux-gap-roadmap-13-startup-diagnostics.md) | Startup & diagnostics settings panel | P2 |

## Principles

1. Every item reuses the existing product model (daemon features, contracts,
   approval/authority gates) before introducing a new subsystem.
2. Incompatible surfaces are upgraded behind versioned contracts; no breaking
   change to stored state without a documented migration.
3. Each item ships with `node --test` unit coverage and, where UI is involved,
   a mock-daemon Playwright spec; screenshot evidence uses
   `LING_CAPTURE_UI2_EVIDENCE=1`.
4. Items are independent; each lands as its own commit series on the roadmap
   branch so partial acceptance is possible.
