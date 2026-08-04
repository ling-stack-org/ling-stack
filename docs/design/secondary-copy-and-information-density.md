# Secondary Copy And Information Density

Status: canonical product and visual contract
Owner: Web and product design maintainers
Last verified: 2026-08-04
Document type: product and visual contract
Code and test anchors: `apps/web/src/features`, `apps/web/src/shared/ui`, `apps/web/e2e`

## Purpose

Ling is an operational product. Primary content, current state, and available actions must
remain easy to scan. Secondary copy is not a decorative layer and must not be used to fill
empty space, narrate normal behavior, or repeat an adjacent title or control.

This contract governs helper text, subtitles, captions, descriptions, muted copy, and
normal-state notices across Web and Desktop-rendered Web surfaces. It does not require all
secondary text to be gray and does not authorize a global color override.

## Display Rules

Secondary copy stays visible only when it helps the user make an immediate decision or
understand a material consequence:

- Safety, permissions, destructive consequences, privacy, or approval boundaries.
- Validation requirements such as accepted formats, limits, and required input.
- Errors, blockers, degraded state, and concrete recovery instructions.
- Dynamic user-owned information such as counts, timestamps, current paths, and progress.
- Meaningful differences between options that cannot be understood from their labels.

Remove or hide secondary copy when it only:

- Repeats the page, panel, section, field, or action label.
- Describes the normal state as healthy, ready, available, or configured.
- Explains what an adjacent, familiar button already says.
- Repeats conversation, workspace, source, or privacy context already visible nearby.
- Exposes implementation detail without changing the user's decision.
- Fills a sparse page or empty state without giving the user a useful next action.

## Surface Rules

- Page headers use a title and actions. Add a description only when the page scope is
  genuinely ambiguous or has a material boundary the user must understand before acting.
- Forms place requirements and consequences beside the affected field. Do not add a second
  general explanation above or below the same control.
- Lists prioritize name, user-relevant summary, dynamic state, and actions. Normal rows do
  not carry health narration or repeated source descriptions.
- Empty states use a short title and, only when useful, one next-step sentence or action.
- Dialog descriptions communicate scope, consequence, or recovery. They do not restate the
  dialog title or enumerate the controls in the body.
- Technical identifiers and diagnostics remain behind explicit technical-detail disclosure
  unless they are the object the user is editing.
- Safety copy remains persistent when its consequence is not reversible or obvious. It must
  not rely on hover, tooltip-only access, or muted contrast below accessibility requirements.

## Visual Hierarchy

Primary labels use the normal text hierarchy. Secondary copy may use a quieter token, but
color alone cannot carry status or meaning. Errors, warnings, and blockers use their semantic
components and tones instead of generic muted text.

Removing copy must also remove obsolete wrappers, reserved rows, gaps, and CSS selectors.
Sparse content keeps a natural height; it is not padded with narration to simulate density.

## Acceptance

- A user can identify the object, current state, and next action without reading a paragraph.
- Removing a line of secondary copy does not remove a safety boundary, validation rule,
  dynamic state, recovery step, or meaningful option distinction.
- Keyboard and screen-reader users receive the same material consequence information as
  pointer users.
- Chinese and English layouts remain stable at 1280 x 800 and 1440 x 960 without orphaned
  gaps, clipped actions, or new page-level overflow.
- Focused E2E tests assert user-visible outcomes rather than obsolete explanatory prose.
