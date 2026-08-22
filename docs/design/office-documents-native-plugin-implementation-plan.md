# Office Documents Native Plugin Implementation Plan

Status: source implementation and automated acceptance complete; real application acceptance remains open
Owner: Desktop, daemon, Runner, Plugin Manager, and release maintainers
Last verified: 2026-08-22
Document type: temporary staged delivery plan
Canonical contract: [Office Documents Native Plugin](office-documents-native-plugin.md)
Code and test anchors: `packages/contracts/src/office-documents.ts`,
`packages/daemon/src/features/office-documents/`, `apps/desktop/main/office-driver/`,
`packages/daemon/test/office-documents.test.mjs`, `apps/desktop/tests/office-driver-*.test.mjs`

## Slice 1: Contracts And Product Projection

Status: implemented and covered by contracts, daemon API, and Web view-model tests.

- Add stable ids, protocol parsers, session/capability DTOs, bounded errors, and Office setup
  projection to `packages/contracts`.
- Register the built-in plugin descriptor and logical MCP server without adding database tables.
- Add Office-specific Plugin Manager row/detail state and bilingual copy.

Exit gate: malformed/oversized/unknown protocol input fails closed; Plugin Manager can distinguish
file-only, Desktop-required, permission, missing Office, limited, ready, and driver-error states.

## Slice 2: File-Level OOXML Runtime

Status: implemented with deterministic source-level OOXML fixtures; real Office/WPS visual
acceptance remains open.

- Add feature-owned XLSX, DOCX, and PPTX artifact adapters using structured libraries. DOCX and
  PPTX edits preserve the existing ZIP package and mutate only allowlisted XML text nodes.
- Expose bounded inspect/create/edit/render/validate tools through the Office generation broker.
- Replace the materializer's permanent `.xlsx`/`.pptx` unsupported rule with safe extraction for
  the supported subset.

Exit gate: deterministic fixtures round-trip typed values and supported formatting, preserve
unmodified OOXML members, reject macros/embedded payloads/unsafe paths, render escaped bounded
previews, and open successfully in Microsoft Office/WPS acceptance environments.

## Slice 3: Native Driver And Desktop Lease

Status: implemented; the macOS helper builds and returns the truthful `office_missing` state on the
current host. Windows source and protocol tests are present, but a Windows package run remains open.

- Add the length-framed driver client, process owner, generation fencing, deadlines, cancellation,
  parent-loss shutdown, process-failure restart, Daemon-failure isolation, and redacted diagnostics.
- Add a signed macOS Apple Events helper and a self-contained Windows x64 COM helper.
- Publish Desktop availability to the daemon through the existing authenticated Desktop authority
  boundary; do not open a new listener.

Exit gate: mocked platform helpers pass protocol and lifecycle tests; packaged resources and signing
coverage are verified for each platform.

## Slice 4: Live Excel Tools And Recovery

Status: implemented with mocked broker/helper coverage; real Excel read/write acceptance remains
open on both platforms.

- Add live session discovery, range read/write, search, sheet mutation, formatting, save, and
  save-as tools with per-adapter capabilities.
- Add per-workbook mutation serialization, stable idempotency, generation fencing, external-change
  checks, and one recovery copy before the first run write.
- Protect approved save-as overwrites with a sibling displacement and restoration path so a failed
  native save cannot silently destroy the previous target.
- Keep raw COM, AppleScript, VBA, and macro execution unreachable from MCP.

Exit gate: duplicate requests do not repeat writes; ambiguous, stale, read-only, protected, and
unsafe-save scenarios fail closed and retain recovery evidence.

## Slice 5: Product And Release Acceptance

Status: automated source checks and isolated browser acceptance are complete. Real Excel and WPS
gates remain open and must not be represented as complete.

- Complete Plugin Manager install/disable/check/repair flows without Office-side installation.
- Validate light/dark and Chinese/English Desktop and Web-only states.
- Run contracts, daemon, Runner, Web, Desktop, docs, public-safety, and package checks.
- Complete real Excel acceptance on Windows and macOS plus OOXML compatibility acceptance in WPS.

Exit gate: no Excel add-in or task pane is required; only the macOS system Automation prompt may
require first-use user action. Any unavailable real-host gate remains explicitly open rather than
being represented as complete.

## Verification Record

Verified on 2026-08-22 against the uncommitted `codex/office-native-plugin` worktree based on
`origin/main@43fc109f`:

- Contracts: 41 tests passed.
- Core: 368 tests passed.
- Runner Pi: 19 tests passed.
- Daemon: 941 full-suite tests passed, including 10 focused Office artifact, broker, and
  platform-projection tests.
- Desktop: 10 Office driver protocol, process, parent-loss, recovery, and native-helper tests passed.
- Web: 55 Plugin Manager view-model tests passed; typecheck, i18n, lint, and production build passed.
- Security and repository gates: dependency security, license policy, Markdown links, public-repo
  safety, and `git diff --check` passed.
- macOS helper: source build and ad-hoc signing passed; without Microsoft Excel installed, only the
  truthful `office_missing` path was exercised.
- Browser acceptance: Chinese light and English dark Plugin Manager states passed at `1280x720`
  without overlap, horizontal overflow, console errors, or page errors.

Still open:

- macOS live Excel Apple Events acceptance, including first-use Automation permission handling.
- Windows x64 helper compilation, packaging, Excel COM control, and installer acceptance on a
  Windows host with Microsoft Excel.
- Microsoft Office and WPS visual compatibility for the supported XLSX, DOCX, and PPTX artifact
  subset.
