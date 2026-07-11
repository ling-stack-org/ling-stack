# Ling Design System

## Related Docs

- [Model Workbench Productization P13](model-workbench-productization-p13.md)
- [Global Feedback Toast System](global-feedback-toast-system.md)

## Purpose

This document is the product design contract for Ling's desktop web UI. It turns
the P0-P10 convergence work into a reusable rule set so future changes do not
drift back into chat-shell copy, diagnostics walls, or internal module lists.

Ling is a local-first AI workspace. The interface should feel quiet, dense,
scannable, and operational. It should help the user act with confidence, not
explain implementation internals by default.

## Product Language

- Quiet: no marketing hero treatment, decorative panels, or loud empty chrome.
- Dense: show useful work objects and actions without oversized cards.
- Scannable: rows, badges, tabs, and summaries must align to a predictable grid.
- Semantic first: name the user task, object, state, consequence, and next step.
- Diagnostics folded: raw ids, paths, hashes, metadata, transports, adapters,
  checksums, and event payloads belong in details or inspectors, not the first
  layer.

## Surface Contract

Every surface must answer four questions in the default layer:

1. What object am I managing?
2. What state is it in?
3. What is the primary action?
4. What needs my attention?

If a sentence does not answer one of those questions, it should usually move to
a details disclosure, field help, tooltip, inspector, or diagnostic panel.

## Settings

Settings is a management workspace, not a second copy of the main app.

- The left Settings navigation owns navigation between settings pages.
- The right panel owns the current task.
- Do not repeat the Settings nav label as a large page title plus another panel
  title unless the page has no other task title.
- Settings-owned actions must stay inside Settings.
- Leaving Settings requires `Back to app` or an explicit `Open ... in app`
  label.
- Diagnostics opened from Settings must render inside the Settings shell.
- Long explanations, policy previews, paths, runner ids, plugin ids, and source
  evidence are collapsed by default.

## Lists And Inspectors

Operational lists use compact rows:

- Row default: status, object name, source or owner, one availability summary,
  one primary action.
- Details: raw identifiers, timestamps, hashes, paths, metadata, secondary
  actions, and technical evidence.
- Inspector default: summary first, then folded requirements, policy, raw
  details, history, and artifacts.
- Do not show item descriptions in list rows when the same description is
  available in the details panel.
- Every list that can grow must have a scroll boundary and must not stretch the
  whole Settings page indefinitely.

## Dialogs

Dialogs follow one creation syntax:

- Title and one concise context sentence.
- Required fields first.
- Optional role/member/model choices second.
- Advanced settings and raw preview folded.
- One primary CTA in the footer.
- Esc and backdrop close must work unless a destructive confirmation is in
  progress.

## States

Product states are not raw storage states.

- Show product groupings such as Ready to start, Generating, Needs attention,
  Completed, Enabled, Paused, Scheduled, and Recent failure.
- Raw states such as queued, waiting_for_approval, runningJobId, metadata, or
  scheduler watch counts can exist in details when useful.
- Empty states are compact and actionable.
- Blocking states explain the repair path before the technical reason.
- Success feedback can be brief; destructive or blocking failures persist until
  resolved or dismissed.

## Feedback And Toasts

Use [Global Feedback Toast System](global-feedback-toast-system.md) for transient
action feedback.

- Lightweight save, copy, apply, created, and queued confirmations use the
  shared top-center `Ling Toast`.
- Toasts use a neutral elevated surface with a small tone bead; never use a
  large colored success pill.
- Feature pages should not define one-off toast styles or browser `alert()`
  calls for product feedback.
- Blocking errors, field validation, destructive warnings, readiness blockers,
  approval states, and diagnostics remain inline near the object they affect.
- A toast is correct only when the user does not need the message to complete
  the next action.

## Buttons, Icons, And Menus

- Primary actions are visually unique and task-level.
- Secondary actions sit near the object they affect or inside details.
- Low-frequency actions use details or a more menu.
- Buttons with icons use inline-flex alignment, a stable gap, and a minimum
  32px hit area.
- Icon-only controls require an accessible label and a tooltip/title.
- Menus use fixed icon cells and a consistent row height.
- Menu descriptions are opt-in; they should not be used for routine actions.

## Copy And I18n

- Chinese and English must carry the same product meaning.
- Do not mix languages on the same visible surface.
- Technical English terms are allowed only when they are object names or inside
  diagnostic details.
- Keep visible copy action-oriented: what happened, what it means, what to do.
- Do not leave orphaned i18n keys after removing visible explanatory copy.

## Dark Theme

- The first painted frame should match the eventual app theme.
- Bootstrap theme storage must prefer the latest effective preference over
  legacy keys.
- Do not hard-code white or black surfaces outside theme tokens.
- Dark mode must be checked on Settings, plugin/skill diagnostics, dialogs,
  menus, and empty states.

## Reachable-State Review Rule

Every reachable state is part of the design surface:

- page default state
- all tabs and segmented controls
- popovers and menus
- dialogs and confirmation flows
- details disclosures
- inspectors and diagnostic previews
- empty, loading, disabled, error, success, stale, and destructive states
- both `1440x960` and `1280x800` desktop viewports

A page is not accepted if only the first visible tab was reviewed.

## Hard Stops

- Do not promote Work Board to primary navigation without a separate IA plan.
- Do not add backend APIs, contracts, schema, or state-machine changes for a
  visual productization slice.
- Do not add major behavior to files over 800 lines; extract a helper,
  component, or focused CSS module first.
- Do not make Settings pages look like marketing pages or raw diagnostic logs.
