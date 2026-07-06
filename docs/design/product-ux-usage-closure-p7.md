# Product UX Usage Closure P7

## Related Docs

- [Product UX System P5](product-ux-system-p5.md)
- [P5 Status Semantics Follow-up](product-status-semantics-p5-followup.md)
- [Product UX Priorities P6](product-ux-priorities-p6.md)
- [P7 Detailed Design](product-ux-usage-closure-p7-detailed-design.md)
- [P7 Implementation Plan](product-ux-usage-closure-p7-implementation-plan.md)

## Summary

P5 and P6 made Ling calmer and more consistent. P7 should move from first-screen polish
to real usage closure: after a user clicks a primary action, the product should clearly
show what is happening, what succeeded, what failed, and where to fix it.

The next four optimization areas are:

1. Image Generation real-use closure.
2. Automations enabled, scheduler, and recent-run clarity.
3. Model Workbench beginner setup path.
4. Skill Library and Maintenance compact inspectors.

This is still a desktop Web UX pass. It does not change backend APIs, database schema,
provider runtime behavior, media generation execution, scheduler behavior, or Settings
IA.

## Product Principle

Ling should not stop at "this control exists." A complete workflow answers four
questions:

- Can I start?
- What is happening now?
- What did I get?
- If it failed, what is the next fix?

Each P7 surface should keep the default layer outcome-oriented. Technical evidence and
raw runtime details remain available, but they must not be the first thing a normal user
needs to parse.

## Priority 1: Image Generation Real-Use Closure

### Problem

Image Generation now has better status buckets, but the real user question is still
broader than status labels. After clicking Start generation, the page must make the
execution lifecycle obvious:

- starting and generating feedback;
- failed provider or relay feedback;
- successful artifact viewing, copying, and reuse;
- clear setup paths when no runnable generation model exists.

### Design Direction

- Treat task execution as a visible loop: setup, start, generating, result, and recover.
- Keep stored media job state unchanged. Product UI derives user-facing state from
  existing job, artifact, runtime, and error data.
- Keep provider and relay error details available in a disclosure, but primary copy
  should say what the user can do next.
- Success should highlight the generated artifact first, not the job record.
- Empty or blocked model states should route to Model Workbench with one clear setup
  action.

### Acceptance Criteria

- Clicking Start generation gives immediate local feedback even before the daemon returns
  the final job state.
- Running jobs are visually distinct from ready-to-start jobs.
- Failure cards show a product reason and a repair path.
- Successful jobs show artifact preview and at least one result action: view, copy,
  download, or reuse existing task settings.
- No runnable generation model state opens or links to Model Workbench without exposing
  provider transport or adapter vocabulary.

## Priority 2: Automations State Friction

### Problem

Automations now distinguishes definitions, scheduler watches, and runs more clearly, but
users can still read enabled automation, scheduler running, and failed recent run as
competing states.

The product must keep these meanings separate:

- enabled means the automation definition can be used;
- scheduled means the scheduler can watch it automatically;
- running or failed belongs to a run, not the definition itself.

### Design Direction

- Header and tabs should explain definitions, scheduled watches, and run health as
  separate layers.
- Scheduler strip should explicitly say scheduled automations when it means timed
  automation watches.
- Needs attention should include failed recent runs, definition errors, and ready drafts.
- Each attention item should have one next action: inspect failure, edit automation,
  confirm draft, or start scheduler.

### Acceptance Criteria

- A manual enabled automation does not make the scheduler copy sound broken when watch
  count is zero.
- Failed recent runs appear as needs attention without implying the automation definition
  is disabled.
- Scheduler start/stop remains explicit and does not become a hidden automatic behavior.
- Existing automation creation, draft confirmation, run, and scheduler controls remain
  unchanged.

## Priority 3: Model Workbench Beginner Setup Path

### Problem

Model Workbench now has a readiness summary, but a first-time user still needs a simple
path from "no usable model" to "I can chat" or "I can generate images." Provider setup is
inherently technical, so the first layer needs to hide the wrong details and expose the
right next step.

### Design Direction

- No model state should offer two product actions: Add chat model and Add image
  generation model.
- Missing API key should show one repair path, not several competing warnings.
- Check success copy should say configuration check passed and where the model can be
  used.
- Image generation check success must not imply that a real image was generated.
- Same model through different routes remains visible and distinguishable.

### Acceptance Criteria

- A beginner can add a chat model or image generation model from the empty state without
  understanding provider transport.
- API key missing state has one dominant repair action.
- Check feedback uses product copy and points to the consuming surface: conversation or
  Image Generation.
- Advanced route and provider details remain available in row/editor details.

## Priority 4: Skill Library And Maintenance Compact Inspectors

### Problem

Settings is less noisy, but Skill Library and Maintenance remain dense because they are
evidence-heavy surfaces. That density is useful for support and debugging, but the
default inspector layer should still answer the user job before showing every fact.

### Design Direction

- Use summary-first inspectors: current status, main action, and blocker first;
  metadata and evidence second.
- Keep full diagnostics in details or lower panels.
- Do not remove startup readiness, skill health, plugin status, runner readiness, or
  maintenance evidence. Reorder it.
- Avoid per-row gray descriptions unless they unblock a decision.

### Acceptance Criteria

- Skill Library first screen shows health, selected skill readiness, and next action
  before raw metadata.
- Maintenance first screen shows readiness summary and primary maintenance action before
  detailed diagnostic evidence.
- Details remain accessible for support and development.
- Settings dark mode and desktop layout do not regress.

## Module Boundaries

- Feature view-models own product labels, derived status, action availability, and
  disabled reasons.
- Shared P5 components remain presentational and receive already-derived props.
- `i18n.tsx` remains the runtime/provider shell; visible copy belongs in locale modules.
- Do not add major behavior to large files. If a slice needs new logic in a large owner,
  extract a helper, inspector component, or view-model first.

Protected owners for P7:

- `MediaJobsPage` and media view-models: allowed for generation closure, but runtime
  resolver logic stays in core.
- `AutomationsPage` and automation view-models: allowed for summary and copy derivation,
  not scheduler behavior changes.
- `ProviderSettings` and provider workbench components: setup path only, no provider
  runtime changes.
- `SkillLibrarySettingsPanel`, `SkillLibraryWidgets`, and Maintenance panels: compact
  inspector only, no skill registry or runner changes.

## Hard Stops

- No backend API or database changes.
- No provider runtime, generation resolver, media executor, scheduler, or skill registry
  behavior changes.
- No new `ViewId`.
- No Work Board promotion to primary navigation.
- No mobile acceptance scope.
- No broad Settings or AppShell route refactor.

## Slice Order

1. Image Generation real-use closure.
2. Automations state friction.
3. Model Workbench beginner setup path.
4. Skill Library and Maintenance compact inspectors.

The order follows user-visible workflow risk: generation and automation are action
surfaces, Model Workbench is setup, and Skill Library/Maintenance are lower-frequency
support surfaces.

## Validation Standard

Every P7 implementation slice should record:

- dev-server browser evidence at `1440x960` and `1280x800`;
- no document/body horizontal overflow;
- focused e2e for the touched feature;
- dark-mode coverage when default inspector structure changes;
- i18n alignment for English and Chinese copy;
- a short evidence update in the implementation or detailed design document.

## Assumptions

- Desktop Web remains the only acceptance target.
- P7 improves the user's visible path through existing features.
- Real generation and scheduler behavior continue to come from existing daemon/runtime
  paths.
- Technical diagnostics remain available, but they move behind deliberate detail
  affordances where possible.
