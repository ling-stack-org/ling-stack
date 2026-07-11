# Model Workbench Productization P13

## Related Docs

- [Ling Design System](ling-design-system.md)
- [Product UX Priorities P6](product-ux-priorities-p6.md)
- [Product UX Usage Closure P7](product-ux-usage-closure-p7.md)
- [Provider Presets](provider-presets.md)

## Summary

Model Workbench already supports provider setup, discovery, checks, default selection,
generation routes, and repair flows. Its remaining product problem is presentation:
the default layer repeats readiness through colored counts, capability sentences,
secret state, check state, default state, timestamps, and technical disclosures.

P13 keeps the existing table and provider behavior, but makes the surface answer four
questions quickly:

1. How many model routes are usable?
2. What is each route used for?
3. What is the single current state of each route?
4. What action, if any, should the user take next?

No daemon API, provider runtime, persistence, route, or state-machine behavior changes.

## Default Surface

### Readiness Summary

Use one neutral sentence instead of four colored count pills:

`2 models - 1 chat ready - 1 image ready`

- Do not render zero-value `Needs API key` or `Disabled` counts.
- When an attention count is non-zero, append one concise attention item.
- Success counts remain neutral. Only the attention item receives semantic color.
- The summary does not repeat a separate page description in Settings mode.

### Toolbar

- Keep search, status filter, and `Add model` visible.
- Keep `Check all` as a secondary command.
- Render Refresh as an icon-only command with an accessible name and tooltip.
- Keep one stable toolbar row at `1440x960` and `1280x800`.

### Table

The default table has four columns:

| Column | Default content |
| --- | --- |
| Model | Display name and model id |
| Usage | Neutral `Chat`, `Image`, or `Video` labels |
| Status | Exactly one product state |
| Actions | One contextual action and the more menu |

Endpoint, provider id, API protocol, secret header metadata, capability source, adapter,
and last-check timestamp are not default-row content.

### P13.1 Row Identity And Action Balance

- The model id is the primary row label. Do not repeat generated names such as
  `Custom - gpt-5.5` above `gpt-5.5`.
- A compact source marker remains at the left. Custom routes use the marker and a
  `Custom access` tooltip instead of a visible `Custom` subtitle.
- Known suppliers may show one compact secondary source label only when it adds useful
  identity beyond the model id.
- Routine Edit and Check commands stay visible as icon buttons. Each icon command has a
  tooltip, accessible name, and a hit area of at least 32px.
- The contextual repair/default action remains a labeled button. Do not duplicate Check
  when Check is already the primary action, or Edit when Add API key already opens Edit.
- More contains only Clear default, Disable, and Delete when applicable.
- Rebalance the table toward actions at approximately `35 / 18 / 19 / 28` percent so the
  action column is useful at both desktop acceptance widths.

## Product State Model

Each row exposes one primary state with this precedence:

1. `disabled`
2. `missing_api_key`
3. `check_failed`
4. `needs_check`
5. `current_default`
6. `ready`

The state view-model owns label, tone, hint, and primary action. JSX and locale files do
not contain precedence logic.

| State | Default label | Primary action |
| --- | --- | --- |
| disabled | Disabled | Enable |
| missing_api_key | Needs API key | Add API key |
| check_failed | Needs attention | Check or Edit |
| needs_check | Needs check | Check |
| current_default | Current default | None; clear default stays in More |
| ready chat | Ready | Set default when eligible |
| ready generation | Ready | None; do not show a `Generation model` placeholder |

Success uses one small status indicator. Amber is reserved for repairable blockers, red
for a real failed check, and gray for disabled or neutral metadata.

## Row Details And Feedback

- Remove inline `Technical details` disclosures from table rows.
- Technical route facts remain available in the editor's Advanced settings disclosure.
- The More menu contains only Clear default, Disable, and Delete when applicable.
- Edit and non-primary Check remain visible in the row; Enable is the labeled primary
  action for disabled routes.
- Row check success clears after about two seconds.
- Row check failure remains visible until the user retries, edits, dismisses, or changes
  the affected route.
- Raw provider responses remain folded under `Check details`.
- Batch check shows one compact aggregate result and does not create feedback rows for
  every route.

## Progressive Provider Editor

### Known Suppliers

Default visible fields:

- model supplier;
- model;
- API key;
- fetch/select available models.

The provider display name is derived from the supplier by default. Base URL and API
protocol remain available in Advanced settings but do not compete with the common path.

### Custom OpenAI-Compatible Supplier

Default visible fields:

- model supplier;
- provider name;
- model;
- Base URL;
- API key;
- API protocol.

These fields remain visible because the custom route cannot be configured truthfully
without them.

### Advanced Settings

One collapsed disclosure contains:

- Base URL and API protocol for known suppliers;
- secret header refs;
- transport;
- context and max-token overrides;
- capability overrides;
- enabled, auth-header, and reasoning controls when editing requires them.

Do not render persistent gray descriptions such as `Optional header refs`, `Optional
manual override`, or `Fetch available models from the endpoint`. Labels and state-specific
errors provide enough context.

Create uses `Add model`; edit uses `Save changes`. Existing draft validation, saved-route
check, import, warning, and partial-success semantics remain unchanged.

## Empty, Error, And Repair States

- Empty state uses one sentence and two setup actions: chat model and image model.
- Filter-empty state names the active filter without adding setup documentation.
- Missing API key shows one repair action.
- Discovery failure shows the product reason first; raw endpoint/provider response stays
  in details.
- Failed-run repair stays summary-first: affected model, one repair action, and folded
  run/provider evidence.

## Visual Rules

- Neutral surfaces and text carry normal and successful states.
- Do not use multiple green backgrounds to repeat readiness.
- Use design tokens in the touched surface; do not add more hard-coded white, black, or
  provider-specific colors.
- Keep row height stable and scannable.
- Do not replace the table with cards.
- Desktop Web is the acceptance target.

## Module Boundaries

- `provider-workbench-view-models.ts` owns summary, state, usage, and action derivation.
- Header, route table, and editor remain presentational feature components.
- Advanced editor fields may be extracted into a focused component.
- New P13 styling belongs in a focused stylesheet rather than expanding the existing
  oversized `providers.css`.
- New P13 E2E coverage belongs in a focused spec rather than growing the existing
  thousand-line workbench spec substantially.

## Acceptance Criteria

- The first screen contains one neutral readiness summary, not four colored pills.
- Each provider row shows one primary state and no inline technical details.
- Each row uses the model id as its primary identity and does not repeat a large Custom
  label for custom routes.
- Ready and current-default routes expose Edit and Check without requiring the More menu.
- Zero-value attention counts are absent.
- A ready generation model does not render a fake action label.
- Known-supplier creation initially exposes only the common setup fields.
- Custom creation still exposes the endpoint and protocol fields it genuinely needs.
- Technical fields and raw errors remain accessible through Advanced settings/details.
- English and Chinese carry the same meaning without visible mixed-language helper copy.
- `1440x960` and `1280x800` have no horizontal overflow or action compression.
- Dark mode uses the same hierarchy without hard-coded light surfaces.

## Hard Stops

- No daemon API, contract, database, provider state-machine, or runtime changes.
- No new Settings route or `ViewId`.
- No card-based provider gallery.
- No major behavior added to a source file over 800 lines or stylesheet over 1200 lines.
