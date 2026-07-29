# Model Workbench Productization P13 Implementation Plan

## Related Docs

- [Model Workbench Productization P13](model-workbench-productization-p13.md)
- [Ling Design System](ling-design-system.md)
- [Provider Presets](provider-presets.md)

## Summary

Implement P13 as a frontend-only productization slice. Preserve provider CRUD, draft
validation, provider checks, model discovery/import, default selection, generation
readiness, and failed-run repair behavior.

## Implementation Steps

1. Add product view-models:
   - derive the neutral readiness summary items;
   - derive one primary row state with the documented precedence;
   - derive neutral usage labels and the contextual primary action;
   - retain technical facts for Advanced settings only.

2. Rebuild the default surface:
   - replace readiness pills with one neutral summary line;
   - keep Add model primary, Check all secondary, and Refresh icon-only;
   - collapse the table to Model, Usage, Status, and Actions;
   - remove inline technical disclosures, timestamps, duplicate secret/check chips, and
     generation placeholder text.

3. Rework the provider editor:
   - keep known-supplier common fields visible;
   - keep custom endpoint/protocol fields visible;
   - move all remaining route and capability controls into one Advanced settings
     disclosure;
   - remove routine helper descriptions;
   - use Add model and Save changes action labels without changing save/check behavior.

4. Align feedback and localization:
   - auto-clear successful row checks;
   - persist failed row checks until user action;
   - keep raw responses folded;
   - localize `Secret Headers` and remove unused helper keys after reference checks.

5. Isolate visual changes:
   - add a focused `model-workbench.css` imported after `providers.css`;
   - use existing theme tokens and semantic status variables;
   - do not append the P13 visual system to the oversized provider stylesheet.

6. Add focused E2E coverage:
   - create a P13 productization spec for summary, row states, progressive editor,
     persistent failures, localization, and overflow;
   - update old assertions only where the documented product contract changed.

7. Apply the P13.1 row refinement:
   - derive model-first identity, source marker text, optional supplier subtitle, and
     visible action availability in the provider row view-model;
   - render Edit and non-primary Check as 32px icon actions;
   - keep Add API key, Check, Set default, and Enable as the single labeled contextual
     action for their states;
   - remove Edit, Check, and Enable from More, leaving only Clear default, Disable, and
     Delete when applicable;
   - fix Actions at `184px`, right-align its header and action group, and let Model absorb
     the remaining width without adding horizontal overflow at `1280x800`;
   - remove the decorative divider before Actions while keeping Check, Edit, and More at
     least `32px` and retaining low-frequency actions in More.

## API And Types

- No HTTP API, daemon, contract, database, route, or persistence changes.
- Add only frontend display types for primary state, tone, usage labels, action, and
  summary items.
- Shared components remain presentational; provider domain decisions stay in the
  provider feature view-model.

## Test Plan

- `git diff --check`
- `corepack pnpm --filter @ling-stack/web check:i18n`
- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- model-workbench.spec.ts model-workbench-productization.spec.ts settings.spec.ts dark-mode.spec.ts`

Browser acceptance on the live Vite dev server:

- `1440x960` and `1280x800`;
- populated, empty, filtered-empty, missing-key, unchecked, failed, disabled, default,
  generation-ready, batch-check, and repair states;
- known supplier, custom supplier, model discovery success/empty/failure, advanced
  disclosure, and delete menu;
- no document/body horizontal overflow;
- no repeated green readiness blocks or hard-coded light surfaces in dark mode.

## Assumptions

- Desktop Web remains the only acceptance scope.
- The readiness summary stays visible as one neutral line.
- The editor remains a single sheet with progressive disclosure.
- Existing provider check and save semantics are authoritative and unchanged.

## Hard Stops

- Stop if implementation requires daemon/API/runtime changes.
- Stop if a table-to-card redesign becomes necessary.
- Extract before adding major logic to a source file over 800 lines.
- Do not add P13's main styles to `providers.css`.

## Implementation Evidence

- Replaced four readiness pills with one neutral summary line; zero-value attention
  counts are no longer rendered.
- Reduced the default table to Model, Usage, Status, and Actions. Every row now renders
  exactly one derived product state.
- Removed row-level technical disclosures, endpoint text, secret/check duplication,
  timestamps, and generation placeholder actions from the default layer.
- Moved Clear default into the row More menu and kept contextual repair actions visible.
- Failed row checks now persist; successful checks still clear after about two seconds.
- Added a progressive editor: known suppliers expose the common path, custom routes keep
  endpoint/protocol visible, and advanced route controls share one disclosure.
- Removed routine editor helper copy and localized `Secret headers` as `密钥请求头`.
- Added `ProviderAdvancedSettings` and focused `model-workbench.css`; no P13 styles were
  appended to the existing oversized provider stylesheet.
- Added focused P13 E2E coverage without adding the new state matrix to the existing
  thousand-line spec.
- P13.1 makes the model id the primary row label, removes the large Custom repetition,
  and exposes routine Edit and Check icon actions without reopening technical details.
- P13.1 reduces More to low-frequency and destructive actions while retaining one labeled
  state-specific action per row.
- The follow-up table refinement fixes Actions at `184px`, right-aligns its label and controls,
  removes the heavy left divider, and releases the remaining width to long model identities.

Verification:

- `git diff --check`
- `corepack pnpm --filter @ling-stack/web check:i18n`
- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- model-workbench.spec.ts model-workbench-productization.spec.ts settings.spec.ts dark-mode.spec.ts`: 36 passed.
- Live Vite dev server source at `http://127.0.0.1:5173/` checked at `1440x960` and
  `1280x800`: no document, body, or table horizontal overflow.
- Live P13.1 rows render model ids without the large Custom label; Check, Edit, and More
  measure 32px by 32px at both acceptance widths in light and dark themes.
- Live light and dark Settings > Model Workbench checked; dark status backgrounds remain
  transparent and the workspace theme was restored to light after verification.
