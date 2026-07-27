# Council Settings / Archive Implementation Plan

## Scope

实现 [`08-Council-Settings-Archive.md`](08-Council-Settings-Archive.md) 的 `COUNCIL-SETTINGS-001`。只迁移
Council Settings / Lifecycle / Archive / Danger；List/Create/Members/Channels 继续作为 verified dependencies。

## Audited Baseline

- `CouncilWorkspacePage.tsx` 内联 settings draft、save/status/archive busy/error 和三个 PATCH action。
- `CouncilWorkspacePanels.tsx` 内联原生 input/textarea/checkbox/button、低频 details 与无确认 Archive。
- Archive 点击直接 PATCH；没有 Dialog、Esc/focus restore 或 busy close contract。
- Save 把 refresh failure 混入 mutation failure，且没有 Reset、success Toast 或 response projection authority。
- managed Council 仅 disabled form；Danger 没有明确 no-delete / read-only product boundary。
- `councils.css` 仍拥有 95 行 Settings/Archive selector，未形成 focused owner。
- 当前 API 只有 GET/PATCH；Core archive 会自动清理 channel policy，没有 Council delete capability。

## Task Checklist

| Task | Owner | Dependency | Parallel | Acceptance | Status |
|---|---|---|---|---|---|
| CSA-01 audit + zero-decision contract | module docs | current API/Core/tests | yes | hard stops frozen | completed |
| CSA-02 pure view-model | new view-model | CSA-01 | yes | draft/dirty/managed matrices | completed |
| CSA-03 focused controller | new hook | CSA-02 | no | identity guards + scoped mutations | completed |
| CSA-04 Settings/Danger presentation | new components | CSA-02/03 | no | shared UI primitives only | completed |
| CSA-05 Page/Panels thin wiring | existing composition | CSA-03/04 | no | both production files <400 | completed |
| CSA-06 focused CSS migration | new CSS + councils.css deletion | CSA-04 | yes | one selector owner | completed |
| CSA-07 fixture + focused E2E | e2e/support + spec | CSA-03/04 | no | reachable-state matrix | completed |
| CSA-08 regression/static gates | existing specs | CSA-05..07 | no | serial workers=1 green | completed |
| CSA-09 source capture/evidence | evidence directory | all gates | no | PNG/hash/metadata inspected | completed |

## File Layout

```text
apps/web/src/features/councils/
  council-settings-archive-view-model.ts
  useCouncilSettingsArchiveController.ts
  CouncilSettingsPanel.tsx
  CouncilArchiveDialog.tsx
  CouncilWorkspacePage.tsx             # thin wiring only
  CouncilWorkspacePanels.tsx           # thin wiring only

apps/web/src/styles/
  council-settings-archive.css
  councils.css                          # delete migrated selectors only

apps/web/e2e/
  support/council-settings-archive-fixture.ts
  ui2-council-settings-archive.spec.ts
  councils.spec.ts                      # new confirmation contract only
  channel-archive.spec.ts               # only if shared archive regression requires it
```

## Controller State And Authority

```text
selected identity
  -> authority + clean draft

draft edit
  -> dirty (local only)
  -> reset -> authority
  -> save PATCH
       success -> response authority + projection + Toast + refresh repair
       failure -> retained dirty draft + inline error

lifecycle PATCH
  -> response projection + refresh repair
  -> failure retains draft and lifecycle

archive request
  -> confirm Dialog
  -> PATCH archived
       success -> archived projection + close + list fallback + refresh
       failure -> retained Dialog/selection/draft + inline error
```

Mutation refs prevent duplicate requests before React state commits. Every response is gated by `cwd::councilId`; an old Council
response may complete server-side but cannot overwrite the newly selected Council UI.

## Presentation Plan

1. Custom Council renders shared `Field/Input/Textarea/Switch`; Save and Reset derive entirely from view-model state.
2. Managed Council renders a read-only summary and Clone action, not disabled editable controls.
3. Lifecycle has one visible state/action and a persistent scoped failure.
4. Boundaries use collapsed `InspectorSection`; no raw diagnostics open by default.
5. Clone remains the existing verified callback.
6. Danger zone exposes Archive only for custom Council and managed feedback otherwise; no Delete DOM.
7. Archive Dialog uses shared `Dialog` Portal, focuses Cancel, locks dismissal while busy and restores trigger/fallback focus.

## CSS Plan

- Move every `.council-settings-*`, `.council-low-frequency-*` and Settings action selector out of `councils.css`.
- Use `.council-settings-archive-*` / `.council-danger-*` focused families and public roots only.
- Keep form columns stable at wide desktop and one column at `max-width:1320px`.
- Settings panel owns vertical scroll; document/root and detail body cannot scroll horizontally.
- No hard-coded colors、`!important`、`transition:all`、Feature keyframe、raw duration/easing or package-private
  `.ling-ui-*` selector.
- Add one direct import in `styles.css`; no nested duplicate import.

## Focused E2E Scenarios

1. Custom default -> dirty -> Reset: no PATCH, exact authority restored, one primary state.
2. Save failure retains long draft; Retry busy is Save-only, exact payload sent once, success projection and Toast visible.
3. PATCH success survives a failed list/Health repair request; response projection stays authoritative and Save does not become false failure.
4. Pause/resume exact status PATCH; failure stays lifecycle-scoped and settings draft remains.
5. builtin + template are managed read-only, Clone available, zero PATCH, no Delete.
6. Archive Cancel/Esc/close restore trigger focus and send zero PATCH.
7. Archive busy locks Dialog/Esc/double-submit; failure retains Dialog/selection/draft and allows retry.
8. Archive success removes Council, cleans every channel policy reference, preserves direct teammate membership and focuses search.
9. Boundaries/diagnostics default folded; Dialog is inside one overlay Portal.
10. 100 Council rows + long identity at 1440 keep internal scroll; 1280 zh-CN Dark/reduced motion has no root/panel overflow.
11. Delayed old-Council save/archive response cannot write into a new Council surface.

## Verification Commands

```bash
LING_PLAYWRIGHT_PORT=4212 corepack pnpm --filter @ling-stack/web exec playwright test \
  e2e/ui2-council-settings-archive.spec.ts --workers=1

LING_PLAYWRIGHT_PORT=4213 corepack pnpm --filter @ling-stack/web exec playwright test \
  e2e/councils.spec.ts \
  e2e/channel-archive.spec.ts \
  e2e/ui2-settings-workspace-tools.spec.ts \
  e2e/settings.spec.ts \
  e2e/dark-mode.spec.ts --workers=1

LING_PLAYWRIGHT_PORT=4214 corepack pnpm --filter @ling-stack/web exec playwright test \
  e2e/ui2-council-list-health.spec.ts \
  e2e/ui2-council-create-clone.spec.ts \
  e2e/ui2-council-members.spec.ts \
  e2e/ui2-council-channels.spec.ts --workers=1

corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web lint
git diff --check -- <touched paths>
```

Focused CSS scan:

```bash
rg -n '#[0-9a-fA-F]{3,8}|!important|transition:\\s*all|@keyframes|\\.ling-ui-' \
  apps/web/src/styles/council-settings-archive.css
```

## Evidence Contract

Directory: `docs/design/ui2.0升级/evidence/features/council-settings-archive/`

Planned changed-state originals:

1. `1440x960-ling-light-settings-dirty.png`
2. `1280x800-ling-dark-zh-save-failure.png`
3. `1440x960-ling-dark-archive-confirm.png`
4. `1280x800-ling-light-archive-failure.png`
5. `1440x960-ling-light-managed-boundary.png`
6. `1280x800-ling-dark-100-row-reduced-motion.png`

Metadata records served artifact/URL、branch/HEAD/dirty state、fixture、viewport/PNG、Theme/locale、steps、SHA-256、
console/pageerror、overflow、keyboard/focus/Portal、reduced motion、policy cleanup and mock/host boundary.

## Completion Gate

- `COUNCIL-SETTINGS-001` default/dirty/save/reset/lifecycle/archive/managed states are reachable and tested.
- No Council Delete, Restore, runtime or new IA exists.
- New production owners and Page/Panels are each `<400` lines.
- Focused + required regression + static gates pass on independent serial ports.
- Six original-size images are visually inspected and metadata hashes match current files.
- Runtime provenance remains explicitly blocked; global matrix updates are handed back to the main thread.

## Closeout Result

- Focused `ui2-council-settings-archive.spec.ts`: `7/7` passed.
- Legacy Council/archive/Settings/Dark and all Council focused selected regression: `66/66` passed.
- `@ling-stack/ui-react`: `51/51`; Web typecheck、check:i18n、lint and diff checks passed.
- Six original-size screenshots passed visual, console, overflow, focus and hash review; see
  [`../evidence/features/council-settings-archive/metadata.md`](../evidence/features/council-settings-archive/metadata.md).
- Production owners remain below 400 lines. `CouncilWorkspacePage.tsx` is 198 lines、`CouncilWorkspacePanels.tsx`
  230、controller 282、panel 277、view-model 95 and focused CSS 314.
- Status: `COUNCIL-SETTINGS-001` verified；Runtime、Delete/Restore and packaged Desktop are not claimed.
