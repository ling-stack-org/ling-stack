# Model Workbench UI 2.0

## 0. Document Status

- Status: Web `verified-ready`; Electron Desktop `partial`.
- UI 2.0 slice: P9 / U10 management surfaces.
- Product owners: existing Provider domain and Model Workbench feature.
- Acceptance scope: desktop Web and the shared Electron main-window renderer.
- Viewports: `1440x960` and `1280x800`; `980x680` is a containment regression only.
- Themes: `ling-light`, `ling-dark`, and one imported Theme Pack compatibility fixture.
- Business boundary: presentation and frontend state ownership only. Provider CRUD, checks, discovery,
  defaults, secrets, imports, repair routing, API, contracts, database, and runtime semantics remain unchanged.

This contract supersedes P13/P13.1 only for UI 2.0 component, visual, feedback, accessibility,
motion, and CSS ownership. Existing provider behavior remains governed by the current implementation
and the P13 product contract.

## 1. Related Contracts

- [`model-workbench-productization-p13.md`](../../model-workbench-productization-p13.md)
- [`model-workbench-productization-p13-implementation-plan.md`](../../model-workbench-productization-p13-implementation-plan.md)
- [`09-Workspace-Tools嵌入态.md`](settings/09-Workspace-Tools嵌入态.md)
- [`DataRow、Table 与 InspectorSection`](../components/09-DataRow-Table与InspectorSection.md)
- [`Dialog 与 Drawer`](../components/03-Dialog与Drawer.md)
- [`Popover、Tooltip 与 Menu`](../components/04-Popover-Tooltip-Menu.md)
- [`Toast 与 InlineFeedback`](../components/07-Toast与InlineFeedback.md)
- [`Icon 系统与功能映射`](../components/11-Icon系统与功能映射.md)
- [`Motion 与状态转场`](../foundations/08-Motion与状态转场.md)
- [`CSS 目标目录与加载顺序`](../architecture/06-CSS目标目录与加载顺序.md)

## 2. Page Goal And User Tasks

Model Workbench is a compact operational surface for configuring and repairing saved model routes.
It is not a provider catalog, a diagnostics wall, or a second model runtime.

The first viewport must let a user answer four questions without opening details:

1. How many saved model routes are usable for chat and generation?
2. What is each route used for?
3. What single state currently matters for each route?
4. What is the next useful action for that route?

Primary tasks are:

- find and filter a saved model route;
- add a known-provider or custom-provider route;
- fetch and import provider models;
- repair a missing API key or failed check;
- check one route or all eligible routes;
- select or clear the workspace default chat route;
- edit, enable, disable, or permanently delete a route;
- inspect technical and raw provider details only when needed.

## 3. Entry, Shell, And Navigation Ownership

Model Workbench is reachable in two existing surfaces:

| Surface | Owner | Header rule | Exit rule |
|---|---|---|---|
| Main app `activeView=providers` | `AppShell` + `ProviderSettings` | show one Model Workbench title | existing app navigation owns exit |
| Settings > Workspace tools > Model Workbench | `SettingsWorkspaceToolSurface` | do not repeat H1 or explanatory copy | Settings shell owns Back to app |

- Both surfaces render the same provider feature tree and domain state.
- `settingsToolMode` changes only shell chrome; it must not fork provider behavior or visual primitives.
- Failed-run repair may open existing Run Diagnostics. Settings mode uses the existing Settings internal
  transition; main-app mode uses the existing application transition.
- No new `ViewId`, Settings section, route, provider screen, or overview card is added.
- Opening or closing the editor, menu, raw details, or delete confirmation must not change the active view.

## 4. Current Implementation And Debt Baseline

| Current owner | Lines | Current responsibility | UI 2.0 debt |
|---|---:|---|---|
| `ProviderSettings.tsx` | 705 | page composition plus search/filter/editor/discovery local state | too close to 800; must be reduced before adding behavior |
| `ProviderRouteList.tsx` | 305 | empty/table/rows/actions/check feedback/custom menu | row, menu, confirmation, and feedback are coupled |
| `ProviderEditorPanel.tsx` | 353 | Dialog, common/custom fields, footer, check feedback | raw controls and feature state are mixed |
| `ProviderModelImportPanel.tsx` | 174 | fetch/search/select/import result list | card-like rows and raw controls remain |
| `ProviderAdvancedSettings.tsx` | 123 | advanced route fields | native `details`, raw fields, and toggle visuals remain |
| `ProviderWorkbenchHeader.tsx` | 136 | summary, toolbar, search/filter/actions | raw buttons and compatibility Select remain |
| `provider-workbench-view-models.ts` | 399 | summary/filter/state/action/model metadata derivation | correct decision owner; must stay pure |
| `use-providers-domain.ts` | 552 | provider API state and mutations | authoritative domain owner; do not duplicate in feature |
| `model-workbench.css` | 617 | P13 focused overrides | over 500 recommendation; split by feature responsibility |
| `providers.css` | 2354 | legacy provider layout plus primitive visuals | architecture debt; this slice must remove Model owners from it |

Current P13 behavior already provides the correct product baseline: one neutral summary, four columns,
one primary row state, model-first identity, visible routine Edit/Check actions, progressive editor, and
folded raw check details. UI 2.0 must preserve those outcomes while replacing legacy controls, menu,
feedback, CSS, and local overlay behavior with shared contracts.

## 5. Function Inventory

| Function ID | Surface | Target primitive owner | Completion state |
|---|---|---|---|
| `MODEL-SUMMARY-001` | readiness summary | feature view-model + neutral text/StatusIndicator | Web `verified-ready` |
| `MODEL-LIST-001` | search, filter, table, list states | Input, Select, Table, EmptyState, Skeleton | Web `verified-ready` |
| `MODEL-ROW-001` | identity, usage, status, actions | Table row, Badge, StatusIndicator, Button, IconButton | Web `verified-ready` |
| `MODEL-CHECK-001` | row and batch checks | Button, IconButton, Spinner, InlineFeedback, Toast | Web `verified-ready` |
| `MODEL-EDITOR-001` | add/edit model route | Dialog, Field, Input, Select, Button | Web `verified-ready` |
| `MODEL-DISCOVERY-001` | fetch/search/select/import provider models | Button, Input, DataRow, shared Checkbox, EmptyState | Web `verified-ready` |
| `MODEL-ADVANCED-001` | advanced route controls and technical details | InspectorSection, Field, Select, Switch | Web `verified-ready` |
| `MODEL-DEFAULT-001` | set/clear workspace default | Button, Menu, StatusIndicator | Web `verified-ready` |
| `MODEL-DANGER-001` | enable, disable, permanent delete | Button, Menu, Dialog, InlineFeedback | Web `verified-ready` |
| `MODEL-REPAIR-001` | next action and failed-run repair | InlineFeedback, Button, InspectorSection | Web `verified-ready` |
| `MODEL-FEEDBACK-001` | save/import/batch/page feedback lifecycle | Toast, InlineFeedback, Field error | Web `verified-ready` |
| `MODEL-DESKTOP-001` | shared Electron main-window surface | shared feature + client surface tokens | `partial` |

`verified-ready` is a module-level Web closeout state, not a global matrix mutation. It is backed by the shared
primitive migration, the combined `25/25` Model regression, changed-state Light/Dark browser checks, original-size
PNG evidence, and CSS-owner removal described below. `MODEL-DESKTOP-001` cannot inherit that state from Web and
remains `partial` until real macOS and Windows client evidence exists.

### 5.1 Reachable-State Matrix

`required` means the focused spec and real browser must reach the state. `N/A` is intentional and must not be
reinterpreted as missing coverage.

| Function ID | default/hover/focus | disabled/loading | empty/no-result | warning/error/stale | overlay/details | long/overflow/theme/locale |
|---|---|---|---|---|---|---|
| `MODEL-SUMMARY-001` | required | refreshing required | true empty required | attention/stale required | N/A | required |
| `MODEL-LIST-001` | required | first load/refresh required | both required | load/refresh error required | N/A | required |
| `MODEL-ROW-001` | required | row mutation required | N/A | blocker/error required | status Tooltip required | required |
| `MODEL-CHECK-001` | required | row/batch busy required | no candidates required | partial/failure required | raw details required | required |
| `MODEL-EDITOR-001` | required | save/import busy required | no templates required | validation/save warning/error required | Dialog required | required |
| `MODEL-DISCOVERY-001` | required | fetch/refresh required | returned empty/search empty required | fallback/error required | metadata details required | required |
| `MODEL-ADVANCED-001` | required | fixed/read-only required | N/A | invalid field required | collapsed/expanded/raw required | required |
| `MODEL-DEFAULT-001` | required | mutation busy required | no eligible default N/A | failure required | More required | required |
| `MODEL-DANGER-001` | required | mutation busy required | N/A | blocked/failure required | Menu/confirm Dialog required | required |
| `MODEL-REPAIR-001` | required | check/rerun busy required | no repair N/A | failed/stale evidence required | details required | required |
| `MODEL-FEEDBACK-001` | focus/hover pause required | loading update required | N/A | all tones/dedupe required | Toast/Inline required | required |
| `MODEL-DESKTOP-001` | required | same as Web | same as Web | same as Web | all overlay types required | macOS/Windows scale required |

## 6. Target Page Structure

```text
ProviderSettings [composition only]
  ProviderWorkbenchSurface
    ProviderWorkbenchHeader
      ReadinessSummary
      Toolbar
        Search Input
        Status Select
        Add model Button
        Check all Button
        Refresh IconButton
    Page-level InlineFeedback or retained-data stale notice
    Optional ProviderNextAction / ProviderRunRepairPanel
    ProviderRouteTable
      TableHeader: Model / Usage / Status / Actions
      ProviderRouteRow[]
        identity / usage / one status / derived actions
        optional row-scoped InlineFeedback
    compact footer count
  ProviderEditorDialog
    Header
    Body [single scroll owner]
      supplier and common fields
      optional custom fields
      model discovery
      advanced settings
      field/editor/check feedback
    Footer [Cancel / optional Save current / one primary]
  ProviderDeleteDialog
```

Page geometry:

- The feature root uses `display:grid`, `min-width:0`, `min-height:0`, `height:100%`, and `overflow:hidden`.
- Header and page feedback do not scroll. The table shell is the page's only vertical scroll owner.
- The header toolbar stays one row at both acceptance viewports; search is the flexible track.
- The list table is `width:100%`, fixed-layout, and does not require document/body horizontal scrolling.
- The Actions column is fixed at `184px`, with its header and action group right-aligned. Model owns the
  remaining width; Usage and Status retain their compact proportional tracks.
- Check, Edit, and More keep at least a `32px` hit area. Clear default, Disable, and Delete remain in More.
- Actions has no decorative left divider; spacing, not a heavy rule, separates it from Status.
- The editor is one shared large Dialog, maximum `720px` wide and `calc(100vh - 32px)` high.
- Dialog header/footer remain fixed; only Dialog body scrolls.

## 7. Header, Summary, Search, And Filter Contract

### 7.1 Readiness Summary

Display one neutral inline sentence in this order:

```text
{total} models · {chatReady} chat ready · {generationReady} generation ready
```

- Omit zero-value `needs API key` and `disabled` clauses.
- Append non-zero attention clauses after readiness counts.
- Ready counts remain neutral; only an actual blocker uses semantic tone.
- Do not render four statistic cards, colored count pills, repeated descriptions, or provider diagnostics.
- During retained refresh, counts remain visible and a compact `Refreshing` status follows the sentence.
- When stale data is retained after refresh failure, append one `May be out of date` StatusIndicator and
  expose Retry in the associated InlineFeedback; do not clear the list.

### 7.2 Toolbar Order

Left to right inside the feature toolbar:

1. Search Input.
2. Status Select.
3. `Add model` primary Button.
4. `Check all` secondary Button.
5. Refresh ghost IconButton.

In Settings embedded mode the same order is used without a duplicate page title. In main-app mode the
page title is above the same summary/toolbar grammar; the title must not introduce a second action row.

### 7.3 Search

- Keep the current query semantics: case-insensitive match over display name, provider id, model id,
  API protocol, and Base URL.
- Search never reveals the hidden raw field merely because it matched.
- Input label: `Search model presets` / `搜索模型预设`.
- Placeholder: `Search models or providers` / `搜索模型或供应商`.
- `Escape` while the search field is focused clears a non-empty query first; a second Escape is left to
  the containing shell or overlay.
- Clearing search keeps the current status filter.
- Search focus must not change external height, border width, toolbar height, or scroll position.

### 7.4 Status Filter

The Select options and predicates are fixed:

| Value | Visible label | Predicate |
|---|---|---|
| `all` | All presets | all routes |
| `ready` | Ready | current workbench-ready predicate |
| `needsAttention` | Needs attention | current workbench needs-config predicate |
| `missingKey` | Missing API key | secret required and not configured |
| `disabled` | Disabled | `enabled=false` |

- Search and filter compose with logical AND.
- Changing filter does not clear search.
- A no-result state names the active query/filter and offers `Clear filters`, not `Add model`.
- Filter order and predicates stay in the pure view-model; locale files only contain labels.

## 8. Table And Row Identity Contract

### 8.1 Columns

| Column | Width at 1440 | Width at 1280 | Content |
|---|---:|---:|---|
| Model | 35% | 35% | source marker, model id, optional useful known-provider subtitle |
| Usage | 18% | 18% | neutral Chat/Image/Video labels |
| Status | 19% | 19% | exactly one primary state and optional accessible hint |
| Actions | 28% | 28% | one text action, routine icons, More |

- Header is sticky within the table scroll owner when the list exceeds available height.
- Row target height is `52px`; rows with failure feedback may add a separate bounded feedback row.
- Table cells use `min-width:0`; identity and long status copy truncate with accessible title/Tooltip.
- Actions never wrap or become vertical. The actions track is right-aligned and does not shrink icon hit areas.

### 8.2 Identity

- Primary identity is the trimmed model id. If model id is empty, use the existing display name fallback.
- Custom access uses the compact source initial `自`/source initial and Tooltip `Custom access`.
- Never render `Custom · model` or a large visible `Custom` subtitle for custom routes.
- A known provider may show one compact secondary source label only when it differs from the model id.
- Provider id, endpoint, protocol, transport, secret ref, capability source, and check timestamp are not row copy.
- Source marker is identity, not an action; it is not focusable unless it has interactive content.

### 8.3 Usage

- Usage labels are neutral `Chat`, `Image`, and `Video`, in that order.
- Show only labels supported by current capability derivation.
- If no recognized usage exists, show one neutral `General` label.
- Do not show `Generation model`, adapter, provider transport, or capability strings in the default row.
- Usage labels use Badge `neutral`; they never use success green.

## 9. Primary Status Matrix

Each route has exactly one primary state. Precedence is immutable:

```text
disabled > missing_api_key > check_failed > needs_check > current_default > ready
```

| State | Predicate summary | Label | Tone | Status hint | Labeled primary action |
|---|---|---|---|---|---|
| `disabled` | `enabled=false` | Disabled | neutral | why unavailable, when known | Enable |
| `missing_api_key` | secret required and unconfigured | Needs API key | warning | current preflight blocker | Add API key |
| `check_failed` | latest check exists and failed | Needs attention | danger | product guidance first | Check |
| `needs_check` | enabled but not preflight/generation ready | Needs check | warning | current preflight blocker | Check |
| `current_default` | ready and selected workspace default | Current default | neutral | none | none |
| `ready` chat | ready, chat-capable, not default | Ready | success indicator only | none | Set default |
| `ready` generation-only | generation ready | Ready | success indicator only | none | none |

Rules:

- State label, tone, hint, and primary action are emitted by `provider-workbench-view-models.ts`.
- JSX and locale files must not reproduce precedence or capability decisions.
- Green is limited to one small ready indicator; the row, usage badges, and buttons stay neutral.
- A status hint is reachable by keyboard and shared Tooltip/Popover. It may summarize a blocker, but raw
  provider messages remain in Details.
- A selected default that later becomes disabled/missing/failed shows the higher-priority blocking state;
  `Clear default` remains available in More.

## 10. Row Action Matrix

The row action order is fixed: labeled primary action, Check IconButton, Edit IconButton, More IconButton.
Omitted actions do not leave visible placeholders.

| Route state | Labeled action | Check icon | Edit icon | More items |
|---|---|---:|---:|---|
| missing API key | Add API key | no | no; Add API key opens editor | Clear default if selected, Disable, Delete |
| check failed | Check | no duplicate | yes | Clear default if selected, Disable, Delete |
| needs check | Check | no duplicate | yes | Clear default if selected, Disable, Delete |
| ready chat, not default | Set default | yes | yes | Disable, Delete |
| current default | none | yes | yes | Clear default, Disable, Delete |
| ready generation-only | none | yes | yes | Disable, Delete |
| disabled | Enable | no | yes | Clear default if selected, Delete |

Action rules:

- Check uses `CheckCircle2` until the shared icon catalog gains a dedicated connection-check symbol;
  loading uses shared Spinner without changing button geometry.
- Edit uses `Pencil`; More uses `MoreHorizontal`; permanent Delete uses `Trash2`.
- IconButton hit area is at least `32x32px`, with shared Tooltip, `aria-label`, and localized title.
- Row actions are disabled only for a real conflicting operation. A row check makes that row's Check busy;
  batch check may disable all check/enable/disable mutations because the current domain executes them as one batch.
- `Add API key` opens Edit focused on the API key Field and returns focus to the same row action on close.
- `Set default`, `Enable`, and `Disable` preserve existing workspace scope and domain callbacks.
- More contains no Edit, Check, Set default, Add API key, or Enable duplicates.

## 11. More Menu Contract

- Replace the current mouse-enter/fixed-position menu with shared Radix-backed Menu.
- Trigger opens on click, `Enter`, or `Space`; hover alone must not open it.
- Arrow Up/Down moves between enabled items; Home/End moves to first/last; Enter/Space selects;
  Escape closes and restores trigger focus; Tab closes and follows normal focus order.
- Menu uses Portal collision handling and remains inside viewport at list top/bottom and both desktop sizes.
- Item order is `Clear default`, `Disable`, separator, `Delete`.
- Omit inapplicable items rather than rendering unexplained disabled commands.
- Delete is the only danger item and is visually isolated; the full menu is not red.
- Selecting Delete closes Menu before opening the confirmation Dialog. Two overlays must not overlap.

## 12. Check And Repair Contract

### 12.1 Row Check

- Busy ownership is the initiating row and action.
- A successful check updates the authoritative route state and shows a scoped success Toast for `3000ms`;
  it does not insert a permanent green table row.
- A failed check updates the primary row state and renders persistent row InlineFeedback directly below that row.
- Failure feedback includes product result, one repair action when available, and collapsed `Check details`.
- Raw `code`, endpoint response, provider message, and timestamp live only inside the collapsed details.
- Failure clears when the route is edited, rechecked successfully, removed, or its authoritative state changes.

### 12.2 Batch Check

- `Check all` is disabled when no current batch-check candidate exists.
- Busy state belongs to Check all and eligible row check indicators; Refresh and conflicting mutations are disabled.
- All-success result is one scoped success Toast.
- Any failure produces one persistent page InlineFeedback summary plus failed row statuses; it does not create
  one expanded feedback block for every successful route.
- Retrying batch replaces the existing `provider:batch-check` feedback scope.
- Sequential/concurrent check execution remains the current domain decision and is not changed here.

### 12.3 Next Action And Failed-Run Repair

- Existing next-action and failed-run repair surfaces remain summary-first and appear above the table.
- They use InlineFeedback/InspectorSection, not colored cards.
- Default copy names the affected model, outcome, and next action.
- Run id, provider id, raw check, and diagnostics are collapsed.
- `Open run` uses the existing navigation adapter; `Rerun` and `Check` preserve existing domain behavior.

## 13. Add And Edit Dialog Contract

### 13.1 Overlay Behavior

- Use shared `Dialog size="lg"`; do not implement a private backdrop, focus trap, or body scroll lock.
- Dialog title is `New preset`, intent-specific `New chat/image/video model`, or `Edit preset` as today.
- Escape, outside click, close IconButton, and Cancel close when idle and restore exact trigger focus.
- During save/check/import mutation, `busy=true`: Escape, outside click, and close are blocked; Cancel is disabled.
- Opening the editor clears obsolete row/batch feedback for that route but does not clear unrelated page errors.
- Switching supplier resets model discovery exactly as the current behavior does.
- Closing without saving discards only local editor state; it does not mutate the saved route.

### 13.2 Known Provider Default Fields

Visible, in order:

1. Model supplier Select.
2. Model Input.
3. API key Field.
4. Available models discovery section.
5. Collapsed Advanced settings.

Provider name, Base URL, API protocol, secret headers, transport, context, max tokens, capabilities,
enabled, auth header, and reasoning are not in the default layer.

### 13.3 Custom Provider Default Fields

Visible, in order:

1. Model supplier Select with Custom access selected.
2. Provider name Input.
3. Model Input.
4. Base URL Input.
5. API key Field.
6. API protocol Select.
7. Available models discovery section.
8. Collapsed Advanced settings.

Base URL and protocol remain visible because a custom route cannot be configured truthfully without them.

### 13.4 Field Rules

- Every control uses shared Field/Input/Select/Textarea/Switch and a stable translated label.
- Placeholder never replaces label. Description appears only for a format, safety boundary, or irreversible consequence.
- Field errors are adjacent to the field and connected with `aria-describedby`.
- At `1280x800`, two-column field rows may collapse to one column before text or controls shrink below contract.
- Long Base URL, model id, and secret header reference wrap or scroll inside the control; they never widen Dialog.
- Creating a route always saves `enabled=true`, preserving current behavior. Editing may expose Enabled in Advanced.

## 14. API Key Contract

- API key input is password by default; Show/Hide uses `Eye`/`EyeOff` IconButton.
- Clear input uses `X` IconButton and preserves the existing `clearApiKey` semantics.
- Editing a route with a stored Ling-local secret may load it through the existing API; external `env:` or
  `keychain:` values are never materialized into the field by the UI.
- An empty field while editing does not imply deletion unless the existing form state explicitly sets `clearApiKey`.
- The default layer may show neutral `Saved credential` state, but never raw secret refs or secret values.
- Missing key, secret store unavailable, access denied, or validation failure remains persistent Field/InlineFeedback.
- Show/Hide/Clear actions remain usable by keyboard and keep a minimum `32px` hit area.
- No secret value may appear in Toast, Tooltip, DOM title, screenshot fixture, log assertion, or raw details.

## 15. Model Fetch And Import Contract

### 15.1 Fetch States

| State | UI |
|---|---|
| initial | compact section header and `Fetch models` secondary Button |
| loading | same button busy; existing results retained and marked refreshing |
| success | searchable compact result list and selected count |
| empty | compact EmptyState: no models returned; Retry available |
| error | persistent InlineFeedback with Retry; raw response folded |
| fallback candidates | warning InlineFeedback; list identifies candidates as built-in fallback in Details |
| no search match | compact no-result EmptyState; clear model search action |

### 15.2 Result Row

- Use compact DataRow/selection row and the shared Checkbox primitive, not decorative cards or Switch.
- Identity is display name, with model id as secondary only when different.
- Usage is neutral capability summary; owner, capability source, and thinking support are in shared Tooltip/Details.
- Checkbox cell is stable `24px`; full row can toggle selection except nested controls.
- Result list has a maximum body height and its own scroll inside the Dialog body section; it does not create a
  second full-Dialog scrollbar.
- No per-row animation or stagger is used when results arrive.

### 15.3 Create Versus Edit Semantics

- Create mode supports multi-select import. With no selected result, `Add model` saves the current draft route.
- With selected results, primary action is `Import selected models ({count})` and imports current selections.
- `Select visible` selects only rows currently matching model search; `Clear selection` clears all selections.
- Edit mode row activation selects that model into the current route.
- Edit mode may also select additional import checkboxes. When imports exist, footer shows `Save current preset`
  secondary and `Import selected models ({count})` primary, preserving current behavior.
- Import success closes Dialog and uses a scoped success Toast. Partial import warnings persist as page/route
  InlineFeedback until acknowledged or resolved.

## 16. Advanced Settings And Raw Details

Use shared InspectorSection/Collapsible titled `Advanced settings`, collapsed by default.

| Field | Known provider | Custom provider | Conditional rule |
|---|---:|---:|---|
| Provider name | advanced | default layer | editable per current template rule |
| Base URL | advanced | default layer | editable per current template rule |
| API protocol | advanced | default layer | disabled when fixed template forbids change |
| Transport | advanced | advanced | only for `openai-codex-responses` |
| Secret headers | advanced | advanced | refs only, never secret values |
| Context | advanced | advanced | numeric/Auto validation |
| Max tokens | advanced | advanced | numeric/Auto validation |
| Capabilities | advanced | advanced | preserve existing capability string behavior |
| Enabled | edit only | edit only | Switch; create is always enabled |
| Auth header | advanced | advanced | Switch |
| Reasoning | advanced | advanced | Switch |
| Runtime adapter | read-only | N/A | media-job only |

- Secret headers description is the one allowed persistent technical helper because it states a safety boundary:
  references only, one per line, no secret values.
- All other routine `optional`, `manual override`, or fetch explanations are removed.
- Advanced disclosure state is local to the open Dialog and resets on close.
- `Enter`/`Space` toggles the disclosure; focus stays on the summary; reduced motion removes height animation.
- Raw provider response is a separate nested `Check details` InspectorSection and remains collapsed.

## 17. Save, Validation, And Error Precedence

The current save pipeline remains authoritative:

```text
validate local draft
  -> check provider draft
  -> stop on blocking check codes
  -> create/update saved route
  -> check saved route when applicable
  -> refresh provider list
  -> close on accepted save/import
```

Feedback precedence inside the editor:

1. Field validation error.
2. Blocking draft/save InlineFeedback.
3. Saved-with-warning InlineFeedback.
4. Check result summary.
5. Raw provider response in collapsed details.

- A blocking error keeps Dialog open and restores the failed primary action to enabled.
- `bad_request`, disabled draft, missing/unavailable secret, API/model mismatch, and unsupported capability
  retain current blocking semantics.
- Authentication/model/provider check failures that current behavior permits after save remain a warning,
  not a fabricated success.
- Success uses one scoped Toast and no persistent success banner.
- Error copy is product-first: outcome, likely cause, next action. Raw codes/messages never lead the feedback.
- Switching supplier or editing the affected field clears only feedback invalidated by that change.

## 18. Default, Enable, Disable, And Delete

### 18.1 Default

- `Set default` applies only through the existing workspace-scoped callback.
- Current default is a status, not an additional green badge.
- `Clear default` stays in More and uses the existing callback.
- Setting or clearing default updates row order/state without resetting search, filter, table scroll, or focus.
- Failure is row InlineFeedback; success is reflected by authoritative status and may be silent.

### 18.2 Enable And Disable

- Disabled route uses `Enable` as its visible labeled primary action.
- Enabled route uses `Disable` in More.
- Disabling continues to clear current usage through existing domain behavior.
- Mutation busy is scoped to the row; failure restores the previous authoritative row and shows InlineFeedback.
- Enable/Disable never appears twice in the row and menu.

### 18.3 Permanent Delete

- Delete always opens shared confirmation Dialog; the current immediate-delete menu behavior is not an
  acceptable UI 2.0 interaction.
- Title includes the model id. Body states that the saved route and its Ling-local saved secret are removed.
- Body also states that external `env:`/keychain values and historical run records are not deleted by this action.
- If daemon reference inspection blocks deletion, keep the row and Dialog or anchored feedback visible, list the
  productized blockers, and offer the existing route to resolve them; raw blocker ids stay in Details.
- Confirm Button is danger and becomes busy. Escape/outside/close are blocked only while deletion is in flight.
- Cancel/close restores focus to the same More trigger. Success removes the row and announces one Toast.
- No new API, force-delete path, cascading behavior, or reference policy is introduced.

## 19. Loading, Empty, No-Result, Error, And Stale States

| State | Existing data | Required rendering | Actions |
|---|---:|---|---|
| first load | no | table-shaped Skeleton, stable header | Refresh disabled while loading |
| refresh | yes | retain rows, summary says Refreshing | no layout reset |
| first-load error | no | persistent page InlineFeedback + compact EmptyState | Retry |
| refresh error / stale | yes | retain rows, stale indicator + InlineFeedback | Retry |
| true empty | no routes | one sentence + Add chat / Add image actions | no long help copy |
| filter/search empty | routes exist | no-result EmptyState naming active constraints | Clear filters |
| mutation error | yes | row/editor anchored InlineFeedback | retry/edit as applicable |

- State precedence is error with no data, true empty, content with stale/error notice, then normal content.
- Refresh never clears existing rows before the request resolves.
- Skeleton dimensions match the four-column table and do not introduce layout shift.
- Stale is frontend presentation state derived from a failed refresh with retained data; it is not persisted or
  added to API/contracts/database.
- Page-level error must not push the table below the viewport; it is compact and wraps inside the content width.

## 20. Feedback Ownership

| Event | Owner | Primitive | Lifetime / clear rule | Scope |
|---|---|---|---|---|
| save/import success | global feedback adapter | Toast success | 3000ms | `provider:<id-or-import>:save` |
| save/import partial warning | page or affected route | InlineFeedback warning | until resolved/dismissed | provider/import scope |
| row check success | global feedback adapter | Toast success | 3000ms | `provider:<id>:check` |
| row check failure | affected row | InlineFeedback error | recheck/edit/state change | `provider:<id>:check` |
| batch all success | global feedback adapter | Toast success | 3000ms | `provider:batch-check` |
| batch partial failure | page + failed row states | InlineFeedback error | retry/resolution | `provider:batch-check` |
| field validation | Field | Field error | field change/revalidation | field id |
| load/refresh failure | page/list | InlineFeedback error | retry/success | `provider:list` |
| delete blocked/failed | delete Dialog then row | InlineFeedback error | cancel/retry/resolution | `provider:<id>:delete` |

- Feature code must not create timers, Toast viewport, browser `alert`, or page success banners.
- A single operation has one success owner. Do not show both Toast and persistent success text.
- Loading feedback stays on the initiating control; it is not a Toast.

## 21. Keyboard, Focus, And ARIA

- Page region has one localized accessible name; Settings wrapper does not create a duplicate region.
- Search and filter have explicit labels. Table has a localized caption available to assistive technology.
- Column headers use semantic `th`; row actions are real buttons; Menu uses `menuitem` semantics.
- Tab order is Search, Filter, Add, Check all, Refresh, then row actions in visual order.
- Icon-only actions use localized `aria-label` and shared Tooltip; Tooltip is not the only source of meaning.
- Row status is announced as text; color and source initial never carry unique meaning.
- Dialog traps focus, focuses the first invalid field after failed submit, and restores exact trigger focus on close.
- Busy controls expose `aria-busy`; disabled controls retain an accessible reason through nearby text or Tooltip.
- `Escape` hierarchy: clear active Search query, close Menu, close nested details only when explicitly focused,
  close Dialog when idle, then leave handling to the shell.
- No custom global keyboard listener is added for Menu/Dialog behavior.

## 22. Motion And Interaction

- Button/IconButton hover/press uses shared `120ms` color/background/border transition and no scale.
- Menu uses shared `120ms` enter/exit and reversible presence.
- Dialog uses shared `180ms` enter and `120ms` exit; no private provider sheet keyframe remains.
- Advanced and raw details use shared `180ms` disclosure motion.
- Rows do not animate reorder/filter changes and do not stagger on load.
- Refresh retains geometry; Spinner replaces the icon without changing button width.
- Rapid Menu/Dialog/disclosure toggles honor the latest input and restore focus once.
- Under `prefers-reduced-motion: reduce`, translation/scale/disclosure height animation is removed; loading
  remains understandable with text or a reduced shared Spinner.

## 23. Responsive, Overflow, And Large Content

- Desktop only; no mobile navigation or card conversion is introduced.
- At `1440x960` and `1280x800`, toolbar stays one row and table stays four columns.
- At `980x680`, the feature remains contained: toolbar may use two rows, but actions do not become vertical and
  the editor remains inside viewport. This does not define a mobile layout.
- Model/provider labels truncate with Tooltip; Base URL, provider error, and raw response wrap with
  `overflow-wrap:anywhere` inside their owner.
- Table shell may scroll vertically but `scrollWidth <= clientWidth + 1`.
- Dialog body may scroll vertically; document/body and Settings content must not gain a second visible scrollbar.
- Menu and Tooltip use collision padding at least `8px` and never render outside the viewport.
- Chinese and English labels do not reduce any icon action below `32px` or force text into vertical writing.

## 24. Theme, Color, And Desktop Surface

### 24.1 Theme

- Feature CSS uses semantic tokens only and has zero new color literals.
- Normal and ready states use neutral surfaces. Green is one small ready indicator; amber is repairable;
  red is a real failure or destructive action.
- No `data-theme`, `data-ui-theme`, Theme Pack id, or Presentation Profile selector is allowed in feature CSS.
- `ling-light`, `ling-dark`, and imported Theme Pack fixture must preserve geometry and status hierarchy.
- Theme switching while Dialog/Menu/details are open does not close them, reset scroll, or lose draft data.

### 24.2 Shared Electron Desktop

- Electron main BrowserWindow renders the same ProviderSettings feature and `@ling-stack/ui-react` primitives.
- Feature modules do not import Electron, query platform, or create macOS/Windows CSS forks.
- `[data-client="desktop"]` may alter approved window/material surface tokens only; table, controls, Dialog,
  feedback, and status geometry remain identical to Web.
- macOS traffic lights and Windows title bar must not overlap Model Workbench title, toolbar, Menu, or Dialog.
- Unsupported blur/transparency uses the verified opaque surface fallback.
- Windows 125%/150% and macOS Retina scaling must preserve `32px` CSS hit areas, text clipping rules, and Dialog bounds.
- Web screenshots do not close full Desktop verification. Desktop evidence must identify renderer URL/build,
  platform, display scale, and client area.

## 25. i18n And Product Copy

- All visible labels, Tooltip, ARIA, empty/error copy, raw-detail summaries, and confirmation copy have matched
  `zh-CN` and `en-US` entries.
- Product names, provider names, model ids, API protocol names, and raw provider content may remain original;
  surrounding UI must not mix languages.
- Preferred Chinese terms: `模型工作台`, `模型`, `用途`, `状态`, `操作`, `检查`, `设为默认`,
  `高级设置`, `获取模型`, `永久删除`.
- Default error copy never leads with HTTP status, provider enum, transport, adapter, or raw JSON.
- Helper text is limited to constraints and consequences; it must not repeat field labels or explain the page.
- Locale files contain no state precedence, capability, field visibility, or action availability logic.

## 26. Target Component And Module Boundaries

```text
packages/ui-react/
  controls/Checkbox.tsx                     shared multi-select checkbox; P9 foundation addition

features/providers/
  ProviderSettings.tsx                       composition only, target <= 400
  ProviderWorkbenchHeader.tsx                summary/toolbar presentation, target <= 220
  ProviderRouteTable.tsx                     table/list states, target <= 300
  ProviderRouteRow.tsx                       row slots only, target <= 260
  ProviderRouteActions.tsx                   action/menu adapter, target <= 220
  ProviderDeleteDialog.tsx                   confirmation presentation, target <= 180
  ProviderEditorDialog.tsx                   Dialog composition, target <= 400
  ProviderEditorCoreFields.tsx               known/custom common fields, target <= 300
  ProviderModelImportPanel.tsx               discovery result presentation, target <= 300
  ProviderAdvancedSettings.tsx               advanced fields, target <= 260
  ProviderCheckFeedback.tsx                  row/editor/raw feedback, target <= 220
  useProviderWorkbenchController.ts           search/filter/editor/discovery UI state, target <= 400
  provider-workbench-view-models.ts           pure derivation, target <= 400; split focused helpers before growth
  provider-workbench-types.ts                 display-only types, target <= 220

domains/providers/use-providers-domain.ts     existing API/mutation owner; no UI state duplication
shared/ui                                     Web i18n/provider adapters only
@ling-stack/ui-react                          primitive behavior and visual owner
```

Rules:

- Names may retain an existing filename when responsibility matches; line and ownership boundaries are mandatory.
- `ProviderSettings.tsx` may receive existing domain props/callbacks only. It cannot add API calls or duplicate
  provider mutation logic.
- `useProviderWorkbenchController` owns ephemeral UI state and request-race guards for discovery; it cannot
  persist provider truth.
- `provider-workbench-view-models.ts` remains side-effect free and independently testable.
- Feature components import shared primitives only from `apps/web/src/shared/ui`; no direct Radix import.
- P9 adds `Checkbox` to `@ling-stack/ui-react` before migrating discovery rows. It is a generic control with
  `checked`, `indeterminate`, `disabled`, `loading`, `label`, and `onCheckedChange`; its visual box is `16px`,
  its containing hit area is at least `32px`, and the stable table cell is `24px`. It is not a Switch and contains
  no provider knowledge. Package tests and the Web adapter land in the same slice.
- `AppShell.tsx` is already over 3000 lines. This slice permits only prop signature wiring; no new business logic.
- No production source file may exceed 800 lines. New owners target 400 or less; an existing owner at the limit
  must split focused helpers before adding more behavior.

## 27. CSS Ownership And Legacy Removal

Target files:

```text
apps/web/src/styles/features/model-workbench/
  index.css              import manifest only
  surface-toolbar.css    page, summary, toolbar, scroll boundary
  route-table.css        table tracks and domain slot geometry
  editor.css             editor field/result/advanced domain layout
  feedback.css           domain feedback placement only
  responsive.css         1320/980 containment only
```

Budgets:

- each production CSS file recommended `<=300` lines, hard maximum `500` for this module;
- combined new Model Workbench focused CSS target `<=650` lines after legacy removal;
- new color literals `0`, `!important` `0`, `transition:all` `0`, private keyframes `0`;
- selectors deeper than three class levels `0`;
- feature selectors targeting `.ling-ui-*` internals `0`;
- feature Theme Pack/client/profile id selectors `0`.

Migration rules:

1. Move only feature geometry from `model-workbench.css` and `providers.css`.
2. Replace Button/Input/Select/Dialog/Menu/Tooltip/Status/Feedback/Empty visuals with package primitives.
3. Delete the corresponding legacy selectors in the same slice; do not copy and leave both owners active.
4. Delete provider-specific backdrop/body-lock/keyframes after shared Dialog migration.
5. Delete hover-open `.provider-row-menu*`, `.hover-action-menu*`, and Model-owned `action-menus.css` rules
   after shared Menu migration.
6. Preserve temporary E2E compatibility selectors only when a test still has no semantic replacement; register
   them in the PR and remove before the Function ID is marked verified.
7. `providers.css` is only allowed to decrease. UI 2.0 Model Workbench completion requires all live Model
   Workbench selectors to leave it; the file may remain for unrelated legacy owners until U13.

## 28. Test Contract

### 28.1 Pure And Component Tests

- status precedence and exact action matrix for every row state;
- search/filter composition, sorting, summary counts, source/model labels, usage labels;
- known/custom field visibility and advanced conditional fields;
- create/edit discovery selection semantics;
- feedback ownership and clear rules;
- no Feature direct Radix imports and no private primitive visual selectors.

### 28.2 Focused Browser Spec

Create or rewrite `ui2-model-workbench.spec.ts` as the UI 2.0 owner. It must cover:

1. loaded summary, toolbar order, four columns, model-first identity, known/custom source labels;
2. search, each filter, combined query/filter, clear, no-result, long model/provider copy;
3. all seven status/action rows, selected blocker precedence, More item availability;
4. row check loading/success/failure/raw details/clear behavior;
5. batch empty/loading/all-success/partial failure/retry;
6. known add, custom add, edit, API key show/hide/clear, disabled fixed protocol;
7. discovery loading/success/search/no-result/empty/error/fallback/multi-select/edit selection;
8. advanced collapsed/expanded and every conditional field;
9. save blocking failure, accepted warning, success, import success/partial warning;
10. set/clear default, enable/disable failure recovery, delete cancel/success/blocked/failure;
11. first loading, true empty, refresh retained, stale retained, first-load error;
12. Menu/Dialog/details keyboard, exact focus return, busy dismissal block, reduced motion;
13. `ling-light`, `ling-dark`, imported theme fixture, zh-CN/en-US;
14. `1440x960`, `1280x800`, `980x680` containment, no body/table/Dialog overflow;
15. theme switch with editor/menu/details open, console errors, and accessibility warnings.

### 28.3 Regression Suites

```text
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web test:e2e -- \
  ui2-model-workbench.spec.ts \
  model-workbench-productization.spec.ts \
  model-workbench.spec.ts \
  ui2-settings-workspace-tools.spec.ts \
  settings.spec.ts \
  dark-mode.spec.ts
```

Daemon/API provider tests run as regression only; this slice must not modify their contracts.

## 29. Original-Size Screenshot Evidence

Evidence root:

```text
docs/design/ui2.0升级/evidence/features/model-workbench/
  metadata.md
  1440x960-ling-light-list-ready.png
  1280x800-ling-dark-list-ready.png
  1440x960-ling-light-search-no-result.png
  1440x960-ling-light-delete-confirm.png
  1440x960-ling-light-retained-refresh-error.png
  1440x960-ling-light-delete-blocked.png
  1280x800-ling-dark-check-failure-details.png
  1280x800-ling-dark-editor-advanced.png
  desktop-macos-1440x960-ling-light-loaded.png
  desktop-windows-1280x800-ling-dark-editor.png
```

Evidence rules:

- PNG files are original viewport pixels, not resized, cropped, compressed into contact sheets, or embedded only
  in Markdown previews.
- Each screenshot is generated from the real Vite page or real Electron renderer, not a static HTML mock.
- `metadata.md` records branch, commit, dirty-worktree note, URL/build, fixture id, locale, Theme Pack, viewport,
  device scale factor, platform/client, Function IDs, interactions, console result, overflow measurements,
  screenshot SHA-256, and known limitations.
- The Web archive includes changed states for Dialog, advanced/discovery selection, raw check details, check
  failure, delete confirmation/blocking, no-result, and retained stale data. The click/keyboard Menu is asserted
  in the same passing E2E but is intentionally not frozen as a separate transient screenshot.
- Light/Dark images may use different states but both must include list and editor coverage.
- Web evidence cannot stand in for Desktop platform evidence. If Windows evidence is unavailable, mark
  `MODEL-DESKTOP-001` partial rather than claiming cross-platform verified.

## 30. Zero-Decision Acceptance Checklist

- [x] The first viewport shows one neutral summary, search/filter, actions, and a four-column table.
- [x] Every route renders exactly one primary state using the documented precedence.
- [x] Every route state matches the exact row action and More matrix.
- [x] Custom routes display model id as primary identity without a large Custom repetition.
- [x] Technical route fields and raw provider responses are absent from the default row.
- [x] More is click/keyboard controlled shared Menu and never hover-only.
- [x] Known/custom editor field visibility matches sections 13 and 16 exactly.
- [x] API key values and refs never leak to labels, tooltips, feedback, screenshots, or logs.
- [x] Discovery create/edit selection semantics match section 15 exactly.
- [x] Success is Toast; blockers and failed operations remain InlineFeedback/Field errors.
- [x] Delete has a shared confirmation Dialog and preserves current daemon reference blocking.
- [x] Initial loading, retained refresh, stale, true empty, no-result, and first-load error are distinct.
- [x] Search/filter/editor/menu/table scroll and focus survive mutations and theme changes.
- [x] Shared primitives own control, overlay, feedback, menu, status, and motion visuals.
- [x] `ProviderSettings.tsx` is `<=400` lines and no new owner exceeds its documented budget.
- [x] Live Model Workbench selectors are removed from `providers.css`; legacy owner counts only decrease.
- [x] Focused and regression tests pass with no unexpected console/page-error or overflow failures. This closeout
  did not run an automated axe scan.
- [x] Original-size Web Light/Dark evidence is archived with metadata and hashes.
- [ ] Real Electron macOS and Windows scale evidence is archived; `MODEL-DESKTOP-001` remains `partial`.

## 31. Non-Goals And Hard Stops

- No daemon/API/client contract/database/provider runtime/state-machine changes.
- No new provider type, capability, secret backend, model catalog, check code, or delete policy.
- No changes to default-provider scope, import semantics, save/check ordering, or failed-run routing.
- No card gallery, marketing provider catalog, onboarding wizard, or mobile redesign.
- No direct Radix import in Feature/App/Domain modules and no Tailwind introduction.
- No new business logic in `AppShell.tsx`; only thin callback/Promise wiring is allowed.
- No major behavior appended to `ProviderSettings.tsx` before extraction.
- No new Model selectors in `providers.css`, `components.css`, `settings.css`, or `strict-console.css`.
- No raw provider data removed from reachable Details merely to simplify the default layer.
- No Theme Pack-specific Feature CSS, remote icon font, PNG action icon, Logo change, or platform UI fork.
- Stop and report if a required state needs a new backend field/endpoint, changes secret deletion semantics,
  changes provider-reference blocking, or cannot preserve current create/edit/import behavior.

## 32. 2026-07-22 Implementation Closeout

### 32.1 Implemented Boundary

- `ProviderSettings.tsx` is now a 261-line composition owner; editor, route actions, delete confirmation,
  feedback, discovery derivation, and UI controllers have focused owners.
- `provider-workbench-view-models.ts` was split before growth and is 336 lines. Every new production owner in
  this slice is below 400 lines.
- The surface uses shared Button, IconButton, Input, Select, Field, Dialog, Menu, Tooltip, Table, DataRow,
  Badge, StatusIndicator, InlineFeedback, EmptyState, Skeleton, InspectorSection, Switch, and Checkbox.
- `providers.css` first decreased from 2354 lines to a one-line migration marker. T13-H then removed that marker and
  the one-line `model-workbench.css` facade; `styles.css` now loads the focused index directly at the same cascade
  position. Six focused Model Workbench CSS files total 617 lines.
- Focused CSS scans have zero hard-coded colors, `!important`, `transition: all`, private keyframes/animations,
  package-private `.ling-ui-*` selectors, or Theme Pack/profile selectors.
- P13/P13.1 model-first identity, primary-state precedence, row action matrix, progressive editor, discovery,
  provider checks, default selection, enable/disable, and existing delete/reference semantics are preserved.
- No provider API, contract, Core, daemon, database, migration, route, or runtime state-machine behavior changed.
- T13-H also removed the unreferenced `ActionMenuItem` component/export and 87-line compatibility stylesheet;
  typecheck/lint and isolated-port App/Model/Dark regression `46/46` passed.

### 32.2 Verification Result

- The final combined command ran `ui2-model-workbench.spec.ts`, `model-workbench-productization.spec.ts`, and
  `model-workbench.spec.ts` together: `25/25` passed in 1.3 minutes.
- Suite split: UI2 focused `7/7`, P13/P13.1 productization `4/4`, and existing Model regression `14/14`.
- The formerly stale assertions now target public UI2 behavior: accessible IconButton semantics,
  click/keyboard Portal Menu behavior, shared Tooltip, semantic theme tokens, and `aria-busy` rather than private
  text-content, hover DOM ownership, pseudo-element, fixed RGB, or `.spin` implementation details.
- The focused captures assert no unexpected console/page error and document overflow `<=1px`; list captures also
  assert feature/table containment, and the editor capture asserts no overflowing Dialog descendant.
- Earlier Web typecheck, lint, i18n, `@ling-stack/ui-react 51/51`, Settings Model `3/3`, Settings entry `1/1`, and
  focused CSS scan results remain recorded evidence from the implementation slice. This docs-only closeout reran
  the combined Model command and `git diff --check`; it does not present the earlier commands as newly rerun.

### 32.3 Evidence Status

- Real Vite source pages at `http://127.0.0.1:4174` were exercised through Settings at `1440x960` Light and
  `1280x800` Dark. Focused assertions passed for toolbar/table/Dialog containment, document overflow, hit areas,
  focus restoration, Menu behavior, stale retained rows, blocked delete, and browser console errors.
- Eight original-size PNGs are archived under `evidence/features/model-workbench/` with post-run SHA-256,
  viewport, theme, state, trigger, and pre-capture assertion metadata. Original-resolution review found no visible
  horizontal overflow, Dialog containment defect, clipped action label, or Dark/Light surface leak.
- The 11 Web Function IDs are therefore `verified-ready` at module level. Their global matrix promotion remains
  outside this document-only closeout and was not performed here.
- `MODEL-DESKTOP-001` remains `partial`: no real Electron macOS Retina or Windows 125%/150% evidence exists.
  Web PNGs prove neither native window chrome nor platform scaling and are not counted as Desktop evidence.
- Imported Theme Pack compatibility is not represented by this eight-image archive and remains a broader
  theme/global integration gate; it is not silently claimed by the Light/Dark Model screenshots.
