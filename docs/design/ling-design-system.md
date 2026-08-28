# Ling Design System

## Related Docs

- [Ling UI 2.0](ui2.0升级/README.md)
- [UI 2.0 Iconography](ui2.0升级/foundations/07-Iconography与图标色系.md)
- [UI 2.0 CSS Architecture](./ui2.0升级/architecture/03-CSS所有权与迁移规则.md)
- [UI 2.0 Motion](./ui2.0升级/foundations/04-交互动效与无障碍.md)
- [UI 2.0 Theme Packs](ui2.0升级/themes/README.md)
- [Model Workbench UI 2.0](./ui2.0升级/modules/09-Model-Workbench.md)
- [Global Feedback Toast System](global-feedback-toast-system.md)

## Purpose

This document is the product design contract for Ling's desktop web UI. It turns
the P0-P10 convergence work into a reusable rule set so future changes do not
drift back into chat-shell copy, diagnostics walls, or internal module lists.

Ling is a local-first AI workspace. The interface should feel quiet, dense,
scannable, and operational. It should help the user act with confidence, not
explain implementation internals by default.

UI 2.0 is now the implementation-level source of truth for tokens, shared
components, module coverage, migration slices, and visual acceptance. This
document remains the concise product-language entry point.

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
- On macOS, the shared `48px` Desktop titlebar owns the traffic-light safe area. Settings
  begins below that row, and `Back to app` fills the navigation content width without a
  separate top offset, narrowing, or horizontal translation.
- The native traffic lights, Sidebar toggle, active title and titlebar actions share the
  same `y=24px` visual centerline. Native and renderer chrome must not use separate vertical
  alignment rules.
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

UI 2.0 实施以 [Toast 与 InlineFeedback](./ui2.0升级/components/02-浮层与反馈.md)
和 [全局反馈消息迁移矩阵](./ui2.0升级/migration/README.md) 为准。

- Lightweight save, copy, apply, created, and queued confirmations use the
  shared top-center `Ling Toast`.
- Toasts use a neutral elevated surface with a small tone bead; never use a
  large colored success pill.
- Feature pages should not define one-off toast styles or browser `alert()`
  calls for product feedback.
- Feature pages should not own toast lifecycle timers or mount a second toast
  viewport. Scope, dedupe, duration, pause, dismiss, ARIA, and motion belong to
  the shared provider.
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
- Lucide is the default source for UI action, navigation, menu, and status icons.
- UI icons use the shared size, stroke, and `currentColor` rules; feature pages
  must not assign arbitrary icon colors or dimensions.
- Remote icon fonts, PNG action icons, emoji controls, and character icons are
  not allowed. Brand/language/file-type icons require a documented local exception.
- `LingStackLogo.tsx` and the current favicon assets are protected: do not
  replace, redraw, recolor, distort, or substitute them during UI 2.0 work.
- Menus use fixed icon cells and a consistent row height.
- Menu descriptions are opt-in; they should not be used for routine actions.

## Copy And I18n

- Chinese and English must carry the same product meaning.
- Do not mix languages on the same visible surface.
- Technical English terms are allowed only when they are object names or inside
  diagnostic details.
- Keep visible copy action-oriented: what happened, what it means, what to do.
- Do not leave orphaned i18n keys after removing visible explanatory copy.

## Theme Packs

- Light and Dark are independent built-in Theme Packs: `ling-light` and
  `ling-dark`. A theme is not required to provide a paired opposite mode.
- `System` is a selection strategy that resolves an actual Theme Pack from the
  operating-system appearance; it is not itself a theme.
- The first painted frame must match the resolved Theme Pack, color scheme,
  and semantic token snapshot.
- Theme Packs may change semantic colors, surfaces, shadows, client material,
  and approved local artwork. They must not change layout, typography scale,
  control geometry, icons, Logo, navigation, or business behavior.
- Feature CSS must not branch on a Theme Pack ID. Add or refine a semantic
  token when a component needs a visual distinction.
- Imported themes are validated data and local assets only. They cannot ship
  arbitrary CSS, JavaScript, remote resources, fonts, or brand replacements.
- `ling-light` and `ling-dark` must be checked on Settings, conversations,
  plugin/skill diagnostics, dialogs, menus, empty states, Web, macOS, and Windows.

## Motion

- Motion explains state continuity; it is not decoration.
- Use the shared `120/180/240ms` duration and easing tokens.
- Open/close interactions must be reversible and respect the latest input.
- Dragging disables transition until pointer release.
- Do not use bounce, shake, staggered long lists, `transition: all`, or
  unregistered keyframes.
- `prefers-reduced-motion` removes translation, scaling, shimmer, pulse, and
  smooth scrolling while preserving understandable state feedback.

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
