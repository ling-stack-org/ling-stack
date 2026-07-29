# Model Workbench UI 2.0 Implementation Plan

## 0. Execution Contract

This plan implements [`09-Model-Workbench.md`](09-Model-Workbench.md) as the P9/U10 Model Workbench
slice. It is intentionally frontend-only and preserves every current provider domain behavior.

Implementation may change:

- feature component boundaries and display-only types;
- ephemeral frontend state for search, filter, editor, discovery, stale presentation, menu, and confirmation;
- Web adapter usage, focused CSS, localization, E2E fixtures, and screenshot evidence;
- callback return types needed to surface existing mutation completion, such as returning the existing delete Promise.

Implementation must not change:

- daemon routes, API-client request/response contracts, database schema, provider persistence, secret stores;
- provider state/check precedence at the domain level, check codes, save/check/import ordering;
- default-provider scope, delete reference blocking, failed-run routing, Settings IA, routes, or `ViewId`;
- Logo assets, mobile scope, or business capability.

## 1. Preconditions And Worktree Rules

Before each implementation slice:

1. Read current `git status --short --branch` and preserve every unrelated dirty change.
2. Record current line counts and selector owners for all touched files.
3. Run the focused existing Model suites to establish a reproducible baseline.
4. Confirm the active browser points to the Vite source, not a stale `dist` or packaged renderer.
5. Do not reset, clean, stash, switch, rebase, merge, or rewrite unrelated files.

Current architectural baseline:

```text
ProviderSettings.tsx                   705 lines
ProviderRouteList.tsx                  305 lines
ProviderEditorPanel.tsx                353 lines
ProviderModelImportPanel.tsx           174 lines
ProviderAdvancedSettings.tsx           123 lines
ProviderWorkbenchHeader.tsx            136 lines
provider-workbench-view-models.ts       399 lines
use-providers-domain.ts                552 lines
model-workbench.css                    617 lines
providers.css                         2354 lines
AppShell.tsx                           >3000 lines
```

The implementation must reduce `ProviderSettings.tsx` before adding stale/delete/discovery behavior. It
must never append major behavior to `AppShell.tsx` or add new Model Workbench selectors to `providers.css`.

## 2. Delivery Slices

| Slice | Function IDs | Primary result | Must remain regression-only |
|---|---|---|---|
| P9.0 | all | baseline inventory and fixtures | daemon/API behavior |
| P9.1 | SUMMARY/LIST/ROW | pure UI state and view-model boundaries | provider mutations |
| P9.2 | LIST/ROW/DEFAULT/DANGER | shared table, row actions, Menu, delete Dialog | editor behavior |
| P9.3 | EDITOR/DISCOVERY/ADVANCED | shared Dialog/forms/discovery/details | CRUD/check semantics |
| P9.4 | CHECK/REPAIR/FEEDBACK | feedback lifecycle, loading and stale states | check/save pipelines |
| P9.5 | DESKTOP + all visual IDs | focused CSS removal, responsive/theme/Desktop | platform business fork |
| P9.6 | all | browser regression and evidence closeout | global UI2 completion claims |

Each slice must keep the application runnable and tests passing. A slice cannot defer its own duplicate CSS,
dead selector, keyboard state, or error state to a later cleanup PR unless this plan explicitly assigns it.

## 3. P9.0 Baseline Audit And Fixture Freeze

### 3.1 Read-Only Inventory

Capture before-edit evidence:

```bash
git status --short --branch
wc -l \
  apps/web/src/features/providers/ProviderSettings.tsx \
  apps/web/src/features/providers/ProviderRouteList.tsx \
  apps/web/src/features/providers/ProviderEditorPanel.tsx \
  apps/web/src/features/providers/ProviderModelImportPanel.tsx \
  apps/web/src/features/providers/ProviderAdvancedSettings.tsx \
  apps/web/src/features/providers/provider-workbench-view-models.ts \
  apps/web/src/styles/model-workbench.css \
  apps/web/src/styles/providers.css
rg -n "provider-(workbench|route|row|table|sheet|editor|model|status|action|menu|check)" \
  apps/web/src/styles/model-workbench.css apps/web/src/styles/providers.css
```

Record:

- provider feature direct raw `button/input/select/textarea/details` usage;
- direct Lucide `size/color/strokeWidth` action usage;
- direct/compatibility `ActionMenuItem`, `SelectControl`, `OperationEmptyState`, and visual classes;
- body scroll locking, private overlay keyframes, hover-open menu positioning, and local timers;
- all current role/class E2E selectors and current screenshot coverage;
- current `providers.css` Model selector count, color literals, `!important`, keyframes, and line count.

### 3.2 Fixture Catalog

Create one focused mock catalog with stable ids for:

| Fixture id | Required facts |
|---|---|
| `model_empty` | zero routes |
| `model_ready_chat` | ready chat, not default |
| `model_default_chat` | ready chat, workspace default |
| `model_ready_image` | ready image generation only |
| `model_ready_video` | ready video generation only |
| `model_missing_key` | secret required, key not configured |
| `model_needs_check` | enabled, no usable check/readiness |
| `model_check_failed` | failed latest check with raw message |
| `model_disabled` | configured but disabled |
| `model_selected_blocked` | selected default plus higher-priority blocker |
| `model_custom_long` | custom source, long model id/Base URL |
| `model_known_fixed` | known provider with fixed protocol |
| `model_delete_blocked` | daemon 409 with reference blockers |

The fixture catalog must not contain real credentials. Use unmistakably fake values and assert screenshots/DOM
do not expose them outside the password input fixture.

### 3.3 Baseline Gate

```bash
git diff --check
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test:e2e -- \
  model-workbench-productization.spec.ts \
  model-workbench.spec.ts \
  ui2-settings-workspace-tools.spec.ts \
  settings.spec.ts \
  dark-mode.spec.ts
```

If baseline failures are unrelated, record them and do not silently rewrite expectations. If a required fixture
cannot be reached without a backend change, stop and report before implementation.

## 4. P9.1 State, Type, And View-Model Extraction

### 4.1 New Display Types

Add `provider-workbench-types.ts` with display-only contracts:

```ts
type ProviderListFreshness = "initial" | "fresh" | "refreshing" | "stale" | "error";
type ProviderEditorMode = "closed" | "create" | "edit";
type ProviderDiscoveryPhase = "idle" | "loading" | "ready" | "empty" | "error";
type ProviderMutationKind = "check" | "batch-check" | "save" | "import" | "default" | "enable" | "disable" | "delete";

interface ProviderRouteActionView {
  primary?: "add_api_key" | "check" | "set_default" | "enable";
  showCheck: boolean;
  showEdit: boolean;
  more: readonly ("clear_default" | "disable" | "delete")[];
}

interface ProviderFeedbackView {
  owner: "field" | "editor" | "row" | "page" | "toast";
  scope: string;
  tone: "info" | "success" | "warning" | "error";
  dismiss: "auto" | "input-change" | "object-change" | "retry" | "manual";
}
```

- These types contain no API response duplication.
- Existing `ProviderPreset`, `ProviderFormState`, `ProviderCheckResult`, and import response types remain canonical.
- Do not move translation functions or JSX into these types.

### 4.2 Pure View-Model Work

Keep and extend `provider-workbench-view-models.ts` as the only decision owner for:

- neutral summary clauses and attention clauses;
- query/filter composition and current sorting;
- model-first identity/source/secondary label;
- usage labels;
- status precedence, label key, tone, hint, and one primary action;
- exact More/action availability matrix;
- known/custom field visibility;
- discovery result identity, usage, metadata details, and selection affordance;
- productized check/delete blocker summaries.

Required pure tests:

- one test row for every state/action combination in the contract;
- selected default with disabled/missing/failed precedence;
- custom source never repeats a large Custom label;
- ready generation never receives `Set default` or placeholder text;
- search plus every filter value;
- field visibility for known/custom/media/Codex-response protocol/edit/create;
- long/empty labels and unknown capabilities.

The current pure view-model is already at the `400`-line boundary. Before adding editor/discovery derivation, split
that responsibility into `provider-editor-view-models.ts` and/or `provider-discovery-view-models.ts`; keep status
precedence and the action matrix together. No focused decision owner may exceed `400` lines.

### 4.3 UI Controller Extraction

Extract `useProviderWorkbenchController.ts` from `ProviderSettings.tsx`.

It owns only:

- search and status filter;
- editor open/mode/setup intent and exact return-focus trigger ref;
- show/hide API key;
- model discovery phase, request id, results, source, search, selection, notice, and error;
- stale/refresh presentation derived from existing load callbacks;
- delete target/open/busy presentation;
- editor-local error/warning display state.

It does not own:

- provider list truth, templates, saved form truth, selected default, checks, mutations, or API calls;
- domain error persistence or navigation;
- Toast viewport/timers.

Discovery race rule: increment a request id when supplier/API/Base URL/API key changes; only the latest request
may publish results. Closing or switching supplier invalidates an in-flight result without cancelling domain truth.

### 4.4 P9.1 Completion Gate

- `ProviderSettings.tsx <= 450` after this extraction and `<=400` by P9.3.
- View-model/controller unit tests pass.
- Existing P13/model workbench E2E pass unchanged.
- No API/domain/AppShell behavior changes and no CSS changes beyond temporary stable owner attributes.

## 5. P9.2 Header, Table, Row Actions, Menu, And Delete

### 5.1 Header Migration

Refactor `ProviderWorkbenchHeader` to consume Web shared UI adapters:

- shared Input with Search prefix;
- shared Select for status filter;
- shared Button for Add model and Check all;
- shared IconButton for Refresh;
- shared StatusIndicator only for non-zero attention/stale/refresh state.

Delete raw button/input/SelectControl visual ownership in the same slice. Keep `settingsToolMode` shell behavior
and the exact toolbar order from the contract.

### 5.2 Table Split

Replace `ProviderRouteList.tsx` with:

```text
ProviderRouteTable.tsx
  first-load Skeleton
  true EmptyState
  filter EmptyState
  shared Table header/body/footer
  ProviderRouteRow[]

ProviderRouteRow.tsx
  identity slot
  usage Badge slot
  StatusIndicator/hint slot
  ProviderRouteActions
  optional ProviderCheckFeedback
```

- Use semantic Table elements through the shared Table primitive.
- Preserve four columns and `35/18/19/28` tracks.
- Keep a stable compatibility data attribute only if legacy tests need it during this slice.
- Replace `OperationEmptyState` with shared EmptyState and use separate true-empty/no-result copy.

### 5.3 Row Actions And Menu

Implement `ProviderRouteActions.tsx` from the derived action view:

- text Button for the one primary action;
- IconButton for Check/Edit/More;
- shared Menu for low-frequency commands;
- no hover-open state, viewport math, estimated menu height, or manual focus/blur listeners.

The component receives callbacks and already-derived availability only. It does not inspect provider capabilities,
check state, selected default, or secret state.

### 5.4 Delete Confirmation

Add `ProviderDeleteDialog.tsx`:

- receives target display model, current secret-source summary, busy state, blockers/feedback, and callbacks;
- uses shared Dialog, danger Button, InlineFeedback, and InspectorSection for raw blocker details;
- opens after Menu closes;
- idle Esc/outside/Cancel restore More trigger focus;
- busy state blocks dismissal;
- successful Promise closes Dialog, removes the row through existing refresh, and emits scoped Toast;
- 409/reference or network failure keeps target and feedback available.

Domain/AppShell adjustment is limited to returning the existing `removeProvider(providerId)` Promise through the
existing prop chain. No delete endpoint or behavior changes are allowed.

### 5.5 P9.2 Tests

Add focused cases for:

- toolbar order and hit areas;
- all status/action/More rows;
- Menu click and full keyboard behavior at top/bottom viewport edges;
- no Edit/Check duplication in More;
- set/clear default focus and scroll preservation;
- enable/disable busy/failure rollback;
- delete cancel, busy, success, reference-blocked, network failure, and focus return;
- empty/no-result/long row/1280 action containment.

### 5.6 P9.2 Completion Gate

- manual menu positioning code is deleted;
- Model Workbench no longer imports `ActionMenuItem`;
- all icon actions use shared IconButton and standard icon map;
- no immediate permanent delete remains;
- current editor/check behavior passes regression unchanged.

## 6. P9.3 Editor, Fields, API Key, Discovery, And Advanced

### 6.1 Dialog Composition

Rename or refactor `ProviderEditorPanel` into `ProviderEditorDialog` and split core fields.

Use:

- shared Dialog/Header/Body/Footer;
- shared Field/Input/Select/Textarea/Switch;
- shared Button/IconButton/Spinner;
- one Dialog body scroll owner;
- no feature body overflow effect, private backdrop, private focus trap, or provider sheet keyframe.

The Dialog component receives editor/controller state and callbacks. It does not call provider APIs directly.

### 6.2 Known And Custom Fields

Implement the exact field order and visibility table from contract sections 13 and 16.

Assertions must prove:

- known provider default: supplier, model, API key, discovery, collapsed advanced;
- custom provider default: supplier, provider name, model, Base URL, API key, protocol, discovery, advanced;
- advanced route/protocol fields for known providers;
- secret headers/transport/context/max/capabilities/toggles for both paths as conditional;
- Enabled absent in create and present in edit;
- fixed protocol disabled rather than silently editable;
- media runtime adapter read-only and not styled as an editable control.

### 6.3 API Key Field

Create a focused `ProviderSecretField` if needed, target `<=220` lines.

- It consumes Field/Input/IconButton only.
- It never receives or renders raw secret refs as visible copy.
- It distinguishes untouched empty input from explicit clear using existing form flags.
- Show/Hide/Clear preserve input focus and do not submit the Dialog.
- Load failure for a Ling-local secret becomes field InlineFeedback; external secret refs stay unmaterialized.
- Tests scan visible text/title/tooltip/raw details for the fake secret and must find none.

### 6.4 Model Discovery

Refactor `ProviderModelImportPanel` to shared compact rows:

- first add generic `packages/ui-react/src/controls/Checkbox.tsx`, focused package CSS, exports, Web adapter,
  and package tests; use `checked`, `indeterminate`, `disabled`, `loading`, `label`, and `onCheckedChange`, with
  a `16px` visual box, `>=32px` containing hit area, and no provider/domain import;
- Fetch models Button with scoped loading;
- retained results during refresh;
- result search Input;
- selected count, Select visible, Clear selection;
- shared DataRow/Checkbox rows and bounded result scroll;
- shared EmptyState for returned-empty and search-empty;
- InlineFeedback for request failure/fallback notice;
- Tooltip or InspectorSection for owner/capability source/thinking metadata.

Preserve exact create/edit selection behavior. Add explicit E2E for the edit-mode dual footer when additional
models are selected; do not simplify it without a separate product decision.

### 6.5 Advanced And Raw Details

- The user-visible disclosure label is exactly `Advanced settings` / `高级设置`.
- Replace native visual `details` ownership with shared InspectorSection/Collapsible.
- Keep Advanced collapsed on each fresh open.
- Keep check/source/raw provider details separately collapsed.
- Keep the secret-header safety description; remove duplicate optional/manual/fetch helper copy.
- Use shared Switch for Enabled/Auth header/Reasoning.

### 6.6 Editor Feedback And Footer

Footer order is fixed:

```text
Cancel
[Save current preset, edit mode with import selection only]
Add model | Save changes | Import selected models (n)
```

- Exactly one primary action is rendered.
- Mutation replaces primary icon with Spinner but preserves width/label.
- Busy blocks dismissal and duplicate submit.
- First invalid Field receives focus after local/blocking validation.
- Accepted save/import closes Dialog only after the current domain pipeline resolves.

### 6.7 P9.3 Completion Gate

- `ProviderSettings.tsx <=400`;
- editor composition `<=400`; each new component follows documented budget;
- raw form controls and feature overlay behavior are removed;
- known/custom/import/edit behavior passes current and new specs;
- no API/DB/secret-store changes.

## 7. P9.4 Feedback, Loading, Refresh, Stale, And Repair

### 7.1 Global Feedback Adapter

Migrate Model Workbench success feedback to the existing Web Toast adapter:

| Event | Toast operation |
|---|---|
| save success | upsert `provider:<id>:save`, success, 3000ms |
| import success | upsert `provider:import:save`, success, 3000ms |
| row check success | upsert `provider:<id>:check`, success, 3000ms |
| batch all success | upsert `provider:batch-check`, success, 3000ms |
| delete success | upsert `provider:<id>:delete`, success, 3000ms |

Delete feature timers for save success, row success, and batch success. The shared Toast owner controls duration,
pause, dedupe, exit motion, and viewport.

### 7.2 Persistent Feedback

Use InlineFeedback for:

- first-load/refresh failure;
- retained stale data;
- row check failure and repair;
- batch partial/all failure;
- save accepted-with-warning;
- import partial warning;
- enable/disable/default/delete failure;
- failed-run repair blockers.

Each feedback record has an object/scope and clear condition. No unrelated navigation or row operation clears it.

### 7.3 Loading And Freshness

Extend only frontend presentation state:

```text
initial + no rows       -> table Skeleton
refreshing + rows       -> retained table + refreshing indicator
refresh success         -> fresh table
refresh failure + rows  -> retained table + stale indicator + InlineFeedback
refresh failure + none  -> error EmptyState + InlineFeedback
```

If current `refreshProviders` cannot expose completion/error without changing API, return its existing Promise/error
through the controller boundary. Do not add a backend freshness field or persist stale state.

### 7.4 Repair Surface

Refactor current `ProviderNextAction` and `ProviderRunRepairPanel` into focused presentation owners if they cause
`ProviderSettings.tsx` to exceed budget. Preserve all callbacks and routing. Use shared InlineFeedback,
InspectorSection, Button, IconButton, and Spinner; raw run/provider facts stay folded.

### 7.5 P9.4 Completion Gate

- Feature-level success timers and `.provider-batch-result` success banners are gone;
- successful operations create one Toast only;
- failed/blocking states remain visible after Toast duration;
- stale refresh retains content, selection, table scroll, query, and filter;
- request race and unmounted update tests pass.

## 8. P9.5 CSS, Theme, Responsive, Motion, And Desktop

### 8.1 Target CSS Split

Create:

```text
apps/web/src/styles/features/model-workbench/index.css
apps/web/src/styles/features/model-workbench/surface-toolbar.css
apps/web/src/styles/features/model-workbench/route-table.css
apps/web/src/styles/features/model-workbench/editor.css
apps/web/src/styles/features/model-workbench/feedback.css
apps/web/src/styles/features/model-workbench/responsive.css
```

`index.css` imports the five focused files inside `@layer ling.features`. Update the Web feature CSS manifest
according to the architecture load order. Do not create unlayered first-party CSS.

### 8.2 Selector Migration Matrix

| Current family | Target owner | Required action |
|---|---|---|
| `.provider-workbench-surface`, header/meta/toolbar/search | `surface-toolbar.css` + shared controls | move geometry, delete control visuals |
| `.provider-table*`, name/usage/status/actions/footer | `route-table.css` + shared Table/Badge/Status | move tracks/slots, delete primitive visuals |
| `.provider-row-menu*`, `.hover-action-menu*` | shared Menu | delete entirely |
| `.provider-sheet-*`, backdrop/body lock/keyframes | shared Dialog | delete entirely |
| editor field grids/discovery result layout | `editor.css` | move domain geometry only |
| check/batch/repair placement | `feedback.css` + shared feedback | move placement, delete color/chrome |
| `@media max-width:1320px` and containment rules | `responsive.css` | retain only explicit 1320/980 geometry |
| Model-owned `action-menus.css` rules | shared Menu | delete after reference count reaches zero |
| Model selectors in `providers.css` | focused files or shared primitives | remove in same slice; never duplicate |

### 8.3 CSS Budgets And Guards

Run after each CSS edit:

```bash
wc -l apps/web/src/styles/features/model-workbench/*.css apps/web/src/styles/providers.css
rg -n '#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(' apps/web/src/styles/features/model-workbench
rg -n '!important|transition:\s*all|@keyframes|animation:' apps/web/src/styles/features/model-workbench
rg -n '\.ling-ui-|data-ui-theme|data-theme|data-ui-presentation' apps/web/src/styles/features/model-workbench
rg -n 'provider-(workbench|table|row|sheet|editor|model|status|action|menu|check)' apps/web/src/styles/providers.css
```

Expected final Model focused result:

- combined focused files `<=650` lines;
- each file `<=300` preferred and `<=500` mandatory;
- color literals, `!important`, `transition:all`, private keyframes, and private `.ling-ui-*` selectors: `0`;
- live Model selector owners remaining in `providers.css`: `0`;
- `providers.css` line count decreases and no unrelated selector is removed.

### 8.4 Motion

- Remove `provider-sheet-slide-in` and all provider-private overlay motion.
- Shared Dialog/Menu/InspectorSection/Toast own transitions and reduced-motion behavior.
- Feature CSS may transition only domain layout properties approved by the Motion contract.
- Verify rapid open/close, Menu-to-Dialog handoff, disclosure reversal, and no layout shift under loading.

### 8.5 Desktop Surface

No Model Workbench-specific Desktop component or CSS fork is created.

Validate the shared main-window renderer:

- macOS client area at `1440x960`, Retina/2x;
- Windows client area at `1280x800`, 125% and 150% display scale;
- `ling-light` and `ling-dark` first visible frame;
- title bar/traffic-light exclusion, Dialog/Menu Portal bounds, internal scrolling, hit areas, and no mixed theme;
- reduced transparency/high contrast use token fallback without hiding status/action.

If Windows real-client evidence is not available, retain `MODEL-DESKTOP-001` as partial. Do not substitute a Web
user-agent string or browser screenshot and call it Windows verification.

### 8.6 P9.5 Completion Gate

- shared primitives are the sole visual/interaction owner for controls/overlays/feedback/status;
- Model focused CSS owns only domain geometry;
- Light/Dark/imported-theme screenshot comparison shows no hard-coded surface or status-color pile;
- Web and Desktop main renderer share the same component tree.

## 9. P9.6 E2E And Original-Size Evidence Closeout

### 9.1 Focused Spec Structure

Create `apps/web/e2e/ui2-model-workbench.spec.ts` with isolated describe blocks:

```text
summary and list
filter and overflow
status and action matrix
menu and destructive actions
row and batch checks
known editor
custom editor and API key
model discovery and import
advanced and raw details
loading, stale, empty and error
theme, locale, keyboard and reduced motion
```

Prefer roles, accessible names, `aria-current/pressed/busy`, and stable public data attributes. Legacy visual
class selectors may be used only to assert their absence during migration.

### 9.2 Required Browser Assertions

- exactly one primary status and at most one labeled row primary action;
- exact action/More matrix for every fixture;
- all icon action bounding boxes `>=32x32`;
- toolbar/table/editor do not overflow at acceptance sizes;
- `documentElement.scrollWidth <= clientWidth + 1` and table/Dialog equivalent measurements;
- Menu/Tooltip/Dialog collision and exact focus restoration;
- Dialog busy blocks Escape/outside/close;
- no secret appears in visible text, title, Tooltip, feedback, or screenshot metadata;
- success Toast disappears within five seconds; blocker InlineFeedback remains;
- reduced motion has no transform/scale provider animation;
- console has no error, unhandled rejection, focus warning, ResizeObserver loop, or accessibility warning.

### 9.3 Screenshot Capture Procedure

For each image:

1. Start the repo Vite command and record the exact URL/port.
2. Reset mock fixture, locale, Theme Pack, viewport, and device scale factor.
3. Navigate through the real Settings/App entry and perform the changed-state interaction.
4. Wait for fonts, stable network state, and the intended overlay/state; do not hide warnings or errors.
5. Assert console and overflow before capture.
6. Capture `fullPage:false` at exact viewport pixels; do not crop or resize.
7. Compute SHA-256 and append metadata immediately.
8. Restore theme/locale and close any running browser/server session when finished.

Required Web images:

| File | Required state |
|---|---|
| `1440x960-ling-light-list-ready.png` | populated seven-route matrix, summary, filters and routine actions |
| `1280x800-ling-dark-list-ready.png` | same state/action matrix under Dark at the compact acceptance viewport |
| `1440x960-ling-light-search-no-result.png` | focused search, no-result state and Clear filters |
| `1440x960-ling-light-delete-confirm.png` | initial permanent-delete confirmation Dialog |
| `1440x960-ling-light-retained-refresh-error.png` | synthetic refresh failure with all stale rows retained |
| `1440x960-ling-light-delete-blocked.png` | delete Dialog with productized reference blocker |
| `1280x800-ling-dark-check-failure-details.png` | persistent row failure with raw details expanded |
| `1280x800-ling-dark-editor-advanced.png` | fetched models, selection controls and expanded Advanced fields in a contained Dialog |

This eight-image archive is the P9 Web closeout set. Menu keyboard behavior, known/custom field switching, empty
state, localization, discovery failures, save validation, import behavior, and enable/check behavior remain
reproducible assertions in the same green combined regression even when they do not each receive a separate PNG.
Imported Theme Pack screenshots remain owned by the broader theme integration gate rather than being fabricated
as Model evidence.

Required Desktop images:

| File | Required environment/state |
|---|---|
| `desktop-macos-1440x960-ling-light-loaded.png` | real Electron main renderer, Retina, populated list |
| `desktop-windows-1280x800-ling-dark-editor.png` | real Electron main renderer, 125%+, editor open |

### 9.4 Metadata

Create `docs/design/ui2.0升级/evidence/features/model-workbench/metadata.md` during implementation with:

- Function IDs and final status;
- branch, commit, dirty worktree declaration, timestamp;
- source URL or packaged renderer build and platform;
- fixture ids, locale, Theme Pack, Presentation Profile, viewport, device scale factor;
- exact test commands and pass counts;
- console/a11y/overflow measurements;
- CSS before/after metrics and deleted selector families;
- each PNG filename, scenario, and SHA-256;
- unresolved Desktop/platform limitations.

Do not update the global coverage matrix or status board until all relevant Function IDs pass this closeout.

## 10. Full Verification Command Set

Static and package guards:

```bash
git diff --check
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/ui-react test
```

Focused and regression browser suites:

```bash
corepack pnpm --filter @ling-stack/web test:e2e -- \
  ui2-model-workbench.spec.ts \
  model-workbench-productization.spec.ts \
  model-workbench.spec.ts \
  ui2-settings-workspace-tools.spec.ts \
  settings.spec.ts \
  dark-mode.spec.ts
```

Provider API/daemon regression, using existing package scripts or direct focused Node tests:

```bash
corepack pnpm --filter @ling-stack/api-client test
corepack pnpm --filter @ling-stack/daemon test
```

If the full daemon suite is too broad for an intermediate UI slice, run the focused provider API tests and run
the full package suite before closeout. Record exactly what ran; never report an unrun suite as passed.

## 11. Per-Slice Review Checklist

### Behavior

- [ ] Current CRUD/check/discovery/import/default/secret/delete behavior is unchanged.
- [ ] Every reachable state has one truthful owner and a next action where applicable.
- [ ] No capability or diagnostic evidence is fabricated or hidden from reachable Details.
- [ ] Search/filter/selection/focus/scroll survive unrelated mutations.

### Components

- [ ] Feature imports UI through Web shared adapters, not direct Radix.
- [ ] Shared Button/IconButton/Input/Select/Dialog/Menu/Tooltip/Feedback/Status/Empty/Skeleton/Table are used.
- [ ] Icon map, hit area, Tooltip, ARIA, loading, and disabled reason match UI 2.0.
- [ ] No Feature Toast viewport, timer, body lock, focus trap, or menu positioning remains.

### Architecture

- [ ] `ProviderSettings.tsx <=400` at final closeout.
- [ ] `AppShell.tsx` contains only required prop/Promise wiring changes.
- [ ] View-model is pure; controller owns only ephemeral UI state; domain owns mutations.
- [ ] No new production file exceeds 800 lines; new owners follow the plan budgets.

### CSS

- [ ] No new Model selector in legacy global files.
- [ ] Moved selectors are deleted from old owners in the same slice.
- [ ] Focused CSS has zero color literals, `!important`, `transition:all`, private keyframes, and Theme ID selectors.
- [ ] `providers.css` only decreases and has zero live Model selectors at closeout.

### Evidence

- [ ] Focused and regression tests pass.
- [ ] Real Vite changed-state QA covers both desktop sizes and Light/Dark.
- [ ] Original-size images, metadata, hashes, console, and overflow evidence are complete.
- [ ] Desktop partial/full status is reported honestly and does not borrow Web evidence.

## 12. Rollback Boundaries

Each slice must be reversible without data migration because it changes frontend composition only.

- If shared Menu causes behavior regression, revert only the P9.2 component/CSS slice; do not restore hover-open
  behavior as a permanent fallback.
- If Dialog migration exposes a missing shared primitive contract, fix `@ling-stack/ui-react` generically and
  add package tests; do not patch `.ling-ui-*` internals from feature CSS.
- If stale presentation needs backend truth, stop and keep current refresh behavior rather than adding a field.
- If delete confirmation cannot explain actual daemon semantics, inspect existing endpoint/tests and update copy;
  do not change delete behavior inside a UI slice.
- If existing P13 behavior and this plan conflict on provider business semantics, preserve current tested behavior
  and document the conflict before continuing.

## 13. Completion Definition

P9 Model Workbench may be marked UI 2.0 `verified` only when:

1. All Function IDs in the module contract satisfy their reachable-state checklist.
2. Shared primitives own controls, overlays, menus, feedback, status, loading, and empty-state interaction.
3. Exact status/action/field-visibility matrices are covered by pure tests and browser tests.
4. `ProviderSettings.tsx` and CSS ownership meet their final budgets.
5. All Model Workbench selectors have left `providers.css` and duplicate legacy owners are deleted.
6. Required static, focused, regression, console, accessibility, and overflow checks pass.
7. Original-size Web evidence is complete and Desktop status is explicitly full or partial by real evidence.
8. No backend/API/database/runtime behavior changed.

Passing P13's existing 36-test regression, compiling successfully, or capturing only the default list is not
sufficient by itself. Tabs are N/A for Model Workbench, but Menu, Dialog, Advanced, raw Details, failure,
empty/no-result, stale, delete confirmation, locale, theme, keyboard, and Desktop surface are mandatory acceptance
surfaces.

## 14. 2026-07-22 Execution Record

### 14.1 Completed Slices

- [x] P9.1 composition and pure view-model extraction.
- [x] P9.2 shared Button/IconButton/Input/Select/Field/Table/DataRow/Badge/Status migration.
- [x] P9.3 Radix-backed shared Menu, Tooltip, Dialog, InspectorSection, and delete confirmation migration.
- [x] P9.4 editor/discovery split, request-id race protection, API Key field containment, and shared Checkbox.
- [x] P9.5 focused CSS ownership migration and legacy Model selector removal from `providers.css`.
- [x] Focused UI2 browser verification at both acceptance viewports and Settings embedded regression.
- [x] Legacy assertion migration and complete green Model regression (`25/25`).
- [x] Eight-image original-size Web PNG evidence and SHA-256 archive.
- [ ] Real Electron macOS and Windows scale evidence.

### 14.2 Final Structure Metrics

| Owner | Before | Current | Result |
|---|---:|---:|---|
| `ProviderSettings.tsx` | 705 | 261 | composition boundary met |
| `provider-workbench-view-models.ts` | 399 | 336 | split before growth |
| `ProviderRouteList.tsx` | 305 documented baseline | 220 | row actions extracted |
| `model-workbench.css` | 589 | 1 | import entry only |
| five focused CSS owners | 0 | 605 | within combined 650-line budget |
| `providers.css` | 2354 | 1 | Model owner removed |

No new production TypeScript/TSX owner exceeds 400 lines in this slice. The new `Checkbox` remains generic and
domain-neutral in `@ling-stack/ui-react`; its package contract is covered by the shared primitive suite.

T13-H follow-up removed the now-unreferenced `ActionMenuItem`, its export and 87-line CSS, then removed the
`providers.css` marker and `model-workbench.css` facade. The root imports the 617-line focused CSS tree directly at
the former facade position. Web typecheck/lint and isolated-port App/Model/Dark `46/46` passed.

### 14.3 Verification Ledger

| Check | Result |
|---|---|
| Web typecheck | pass |
| Web lint / UI2 boundary guards | pass |
| Web i18n audit | pass |
| `@ling-stack/ui-react` | `51/51` pass |
| UI2 Model focused E2E | `7/7` pass |
| Settings Model embedded E2E | `3/3` pass |
| Settings direct-entry legacy E2E | `1/1` pass |
| P13/P13.1 productization E2E | `4/4` pass in final combined run |
| Existing Model regression E2E | `14/14` pass in final combined run |
| Combined Model closeout | `25/25` pass in 1.3 minutes |
| Light/Dark containment | `1440x960` Light and `1280x800` Dark pass in focused suite |
| Focused CSS forbidden-pattern scan | zero findings |
| Original-size screenshot archive | eight Web PNGs with final SHA-256 and per-image reproduction metadata |
| Desktop macOS/Windows evidence | partial / not run in this slice |

The final docs-only closeout reran this exact combined command:

```bash
corepack pnpm --filter @ling-stack/web test:e2e -- \
  ui2-model-workbench.spec.ts \
  model-workbench-productization.spec.ts \
  model-workbench.spec.ts
```

The earlier typecheck, lint, i18n, package, Settings, and CSS-scan rows remain implementation-slice evidence and
were not rerun by the documentation-only closeout. `git diff --check` was rerun after the documentation update.

### 14.4 Function And Platform Closeout

- `MODEL-SUMMARY-001`, `MODEL-LIST-001`, `MODEL-ROW-001`, `MODEL-CHECK-001`, `MODEL-EDITOR-001`,
  `MODEL-DISCOVERY-001`, `MODEL-ADVANCED-001`, `MODEL-DEFAULT-001`, `MODEL-DANGER-001`,
  `MODEL-REPAIR-001`, and `MODEL-FEEDBACK-001` are Web `verified-ready` at module level.
- `verified-ready` means the implementation, combined regression, changed-state Light/Dark checks, and Web PNG
  ledger are ready for the separate global matrix owner. This plan does not mutate the global matrix or status
  board.
- `MODEL-DESKTOP-001` remains `partial`. Real Electron macOS Retina and Windows 125%/150% evidence is still
  required; Web screenshots cannot satisfy that gate.
- The eight final PNGs were reviewed at original resolution. No visible horizontal overflow, Dialog containment
  defect, clipped action text, or Dark/Light surface leak was found. The exact hashes and triggers live in
  `evidence/features/model-workbench/metadata.md`.
