# P7A.5 External Work Implementation Plan

Status: `verified` on 2026-07-20. Slice owner: P7A.5. Evidence:
[External Work metadata](../../evidence/settings/external-work/metadata.md).

## Scope

只迁移当前 Settings > External Work 真实可达能力：

- `SETTINGS-EXTERNAL-STATUS-001`：所选频道的 readiness、refresh 和主状态。
- `SETTINGS-EXTERNAL-WORKFLOW-001`：GitHub/Linear WORKFLOW.md 创建、修复和状态详情。
- `SETTINGS-EXTERNAL-TOKEN-001`：凭据状态、安全存储摘要和修复入口。
- `SETTINGS-EXTERNAL-SECRET-001`：Token 创建、更新和 Keychain Token 永久删除确认。
- `SETTINGS-EXTERNAL-OPERATIONS-001`：Poll、Reconcile、GitHub background start/stop。
- `SETTINGS-EXTERNAL-RECORD-001`：External work、CI triage、actions 的计数摘要。
- `SETTINGS-EXTERNAL-ERROR-001`：status、workflow、credential、operation 的对象级失败反馈。

以下能力不进入 P7A.5：

- `SETTINGS-EXTERNAL-WORKFLOW-DELETE-001`：当前 daemon/API 没有删除 WORKFLOW.md endpoint，保持
  `inventory` 和 absent。
- Settings 内完整 external-work/CI record list：当前真实列表归 Channel Activity tools；本切片只显示
  status response 中的计数摘要，不复制 workspace list 或 fixture。
- 新 provider、GitHub/Linear OAuth、Secret backend、workflow schema、background scheduler 或路由。

不修改 daemon API、contracts、数据库、Keychain 语义、Settings IA、Channel Activity、Logo 或主导航。

## Current Reachability Audit

- `ExternalWorkSettingsPanel.tsx` 当前 396 行，混合页面 composition、表单 state、状态派生、危险操作和
  记录摘要；继续追加会让 section 难以审查，应先拆 view-model 和 focused sections。
- 页面仍使用 `.panel`、重复 H2、legacy button class、`SelectControl`、卡片式 `.settings-action-box`、
  inline chip counts 和 raw `SettingsMetaLine` 默认层。
- Status API 真实提供：channel、workflow、secret、records、background、lastErrors；没有 workflow delete。
- Secret mutation 只允许 Settings 删除 `keychain:` ref。环境变量 ref 可以被新的 Keychain Token 替换，
  但不能从 Settings 删除。
- `useExternalWorkDomain` 已有 action-scoped busy state，但 load failure 被吞掉，mutation error 只流入通用
  AppShell error string；P7A.5 需要把 DomainError 传回 section owner，不新增第二套请求状态。
- `onOpenExternalWorkRecords/onOpenExternalWorkTriage` 当前未被 panel 使用，AppShell wrapper 也只返回频道，
  没有打开具体 Activity sub-surface。P7A.5 不把它包装成虚假的“已打开记录”能力；Settings 使用准确的
  summary label，深层列表继续从 Channel Activity 进入。
- Current tests cover happy setup, poll/reconcile/start/stop, token configure/delete, missing/invalid workflow and
  Linear unsupported background, but do not cover load/mutation failure, confirmation, scoped loading, empty channel,
  reduced motion or screenshot evidence.

## Product Decisions

### One Primary State Per Object

| Object | State priority | Primary action |
|---|---|---|
| Overall | no channel > loading > status error > workflow blocker > credential blocker > ready | Select channel outside Settings / Refresh / Repair workflow / Save token / Poll once |
| Workflow | missing > invalid > valid | Create / Repair / none |
| Credential | unavailable > invalid > missing > configured > not required | Save or update token / none |
| Background | failed > running > stopped > unsupported > not configured | Stop / Start / none |

- Raw `workflow.error`、secret ref/message、path、event names、scheduler ID and timestamps stay in collapsed
  Inspector sections.
- Default copy says what the user can do next; it does not print `unknown`, `not_configured`, raw path or secret ref.
- Success is represented by authoritative status and stays silent. Failures persist near their owner.

### Credential Safety

- Token Input always uses `type=password`, `autocomplete=off`, never receives the stored value and is cleared on submit.
- Missing/invalid/unavailable credential opens the editor by default; configured credential stays summary-first with
  an explicit Update action.
- Only `keychain:` credentials expose Delete. Delete opens shared Radix Dialog and explains that polling/background
  work may stop until a new token is saved.
- The Dialog remains busy and non-dismissible during delete. It closes only when the domain action reports success;
  failure remains in the Dialog/credential section and the stored state is not misreported.
- Environment-backed refs do not show a disabled Delete button or technical explanation wall.

### Records And Triage

- Settings shows three compact data-first summaries: Work items、CI triage、Actions.
- Each summary includes total plus the one actionable count (ready/failed or blocked/waiting for approval).
- Toggle labels say `Show summary / Hide summary`, not `View records`, because no record list is rendered here.
- The full record/triage list remains a Channel Activity capability and is not duplicated in Settings.

## Target Structure

```text
External Work
  Status header                                      Refresh icon
    selected channel / target                        StatusIndicator
    status failure                                   InlineFeedback

  Workflow
    DataRow: source + target                         Ready / Needs attention
    create/repair form                               Select + Field + Button
    Details (collapsed)                              path/events/raw validation

  Credential
    DataRow: provider credential                     Ready / Required / Unavailable
    create/update form                               password Field + Save
    advanced storage detail (collapsed)              ref/status/raw message
    Remove token                                     confirmation Dialog

  Operations
    Poll once / Reconcile / Start or Stop
    background state                                 StatusIndicator
    last errors (persistent)                         InlineFeedback + Details

  Activity summary
    Work items / CI triage / Actions                 compact data rows
```

- SettingsShell owns page identity; the section has no `.panel`, duplicate External Work H2 or nested card wall.
- Refresh is icon-only with Tooltip/ARIA and local loading.
- `selectedChannel` absent uses shared compact EmptyState. Initial load uses Skeleton, not fake `not loaded` status.
- Every list/form/Inspector has an explicit width/overflow owner at 1440x960 and 1280x800.

## Module Boundaries

- `ExternalWorkSettingsPanel.tsx`：127-line shell composition and loading/error boundary.
- `ExternalWorkReadySurface.tsx`：107-line ready-state composition; no API or local mutation state.
- `external-work-settings-view-models.ts`：pure primary state/tone/action/detail derivation; no React/i18n/API.
- `ExternalWorkWorkflowSection.tsx`：workflow DataRow、form and collapsed technical details.
- `ExternalWorkCredentialSection.tsx`：credential DataRow、password editor and Delete Dialog.
- `ExternalWorkOperationsSection.tsx`：poll/reconcile/background controls and action errors.
- `ExternalWorkActivitySummary.tsx`：three truthful count summaries, no fetch or fake list.
- `use-external-work-domain.ts`：existing request owner; add scoped DomainError and boolean mutation outcomes only.
- `SettingsPage.tsx` / `AppShell.tsx`：typed prop wiring only; no new UI state, request or persistence logic.
- `settings-external-work.css`：section/domain layout and 1280 containment only.
- `ui2-settings-external-work.spec.ts`：reachable state, failure, confirmation, keyboard, screenshot and overflow owner.

All new/expanded production files remain below 400 lines. `AppShell.tsx` stays composition-only.

## API And State Contract

- API requests and response types remain unchanged.
- Domain mutation functions return `Promise<boolean>` to tell the view whether a caught request succeeded; this is a
  Web controller result, not a daemon contract change.
- Domain error scope is one of `status / workflow / credential / poll / reconcile / background / triage` and carries
  the existing product-safe message. A successful action clears only the External Work error.
- Refresh failure keeps selected channel context and shows persistent status feedback; it does not render a fake
  unconfigured form unless the authoritative status says workflow missing/invalid.
- Only the initiating button spins. Other mutually exclusive operation buttons are disabled without duplicate spinners.
- Latest authoritative status remains the source of truth after every mutation.

## State Matrix

| State | Required result |
|---|---|
| no selected channel | compact EmptyState; Refresh and all forms absent |
| initial loading | section Skeleton; navigation and other Settings remain usable |
| refresh failure | persistent status InlineFeedback + Retry; no fake missing workflow |
| ready GitHub | one ready workflow state, credential status, Poll/Reconcile/Start and compact summaries |
| running GitHub | Stop replaces Start; scheduler/timestamps stay in Details |
| failed background | danger state + persistent last error + eligible retry action |
| Linear | Poll/Reconcile available; background shows Unsupported and no Start/Stop |
| workflow missing | create form; token editor disabled/absent until workflow is valid |
| workflow invalid | repair form + product message; raw parser detail collapsed |
| repository invalid | Field error; submit disabled; no request |
| credential missing/invalid | editor visible, Save enabled only with nonblank token |
| credential configured | editor collapsed; Update action; Keychain ref may expose Delete |
| credential unavailable | persistent warning/danger and no false ready state |
| token save success | input cleared, authoritative configured state, no page success banner |
| token save failure | editor remains understandable, persistent scoped error, no success state |
| delete cancel/Esc | no request; focus returns to Delete trigger |
| delete busy/success/failure | Dialog scoped busy; success closes after refresh; failure remains actionable |
| poll/reconcile/start/stop | only initiating action spins; final status/counts refresh |
| summary toggle | same node/geometry; count rows only, no fake record list |
| long/localized | path/error/name cannot cause document overflow at both target viewports |
| reduced motion | shared control/Dialog/Inspector transition duration is zero; state still changes |

## Feedback Contract

- Initial/read/workflow/credential/operation failures use persistent scoped InlineFeedback.
- Successful refresh、workflow repair、secret save/delete and operations are silent when status visibly changes.
- No Feature timer, local Toast viewport, browser alert or duplicate AppShell banner.
- Raw provider/parser/backend detail stays in collapsed Inspector; primary feedback is short and actionable.
- Delete confirmation is not a Toast and cannot disappear on a timer.

## CSS Migration

1. Add `settings-external-work.css` and import it after SettingsShell/Interface focused files.
2. Stop using `.panel/.panel-title/.secondary-button/.ghost-button/.settings-action-box/
   .settings-inline-counts/.settings-compact-details` in External Work.
3. Delete `.external-work-counts/.external-work-secret-box/.external-work-workflow-box/
   .external-work-secret-form/.external-work-workflow-form/.external-work-ui-field` aliases from `settings.css`
   after references reach zero.
4. Delete `.settings-external-work-inspector` from `settings-interactions.css` after references reach zero.
5. Do not delete generic Settings selectors still owned by Startup/Skill/MCP; no broad cleanup in this slice.
6. New focused CSS has zero color literals、`!important`、Theme/Profile ID selectors、`transition: all`、private
   keyframes and package-private `.ling-ui-*` selectors.

## Implementation Order

1. Split coverage Function IDs and record absent workflow-delete/deep-list boundaries.
2. Add focused view-model and section components; keep API calls outside them.
3. Add scoped domain error and boolean mutation outcomes.
4. Recompose ExternalWorkSettingsPanel with shared primitives and Delete Dialog.
5. Add focused CSS, then remove only unreferenced External Work legacy selectors.
6. Update existing E2E public selectors and add focused reachable-state coverage.
7. Run static/package/focused/selected regression and capture real Vite evidence.
8. Write metadata and update coverage/E2E/CSS/selector/motion/feedback/status/master documents.

## Tests

```bash
git diff --check
corepack pnpm --filter @ling-stack/ui-react test
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test:e2e -- \
  ui2-settings-external-work.spec.ts settings.spec.ts ui2-settings-shell.spec.ts \
  ui2-form-controls.spec.ts ui2-dialog-controls.spec.ts ui2-feedback-data-display.spec.ts \
  dark-mode.spec.ts channel.spec.ts
```

Evidence must include:

- `1440x960 ling-light` ready GitHub default state.
- `1280x800 ling-dark` workflow missing/repair state.
- `1280x800 ling-dark` Keychain delete confirmation.
- `1280x800 ling-light` mutation failure or status-load failure.
- `1280x800 ling-dark` Linear/unsupported background or long localized detail.

Every image records fixture、locale、viewport、Theme Pack ID、console、overflow and SHA-256.

## Exit Gate

- No duplicate page H2、legacy panel/card wall、raw status strings or default-layer secret ref.
- All reachable actions use shared primitives and retain exact daemon behavior.
- Token delete has cancel/Esc/focus/busy/failure coverage and no request before confirmation.
- Workflow delete and full record list remain absent because there is no truthful Settings capability.
- External Work errors have a visible section owner and no duplicate global banner.
- `settings.css` and `settings-interactions.css` only decrease for migrated owners.
- Static、focused、selected E2E、original-resolution screenshots、console、overflow and metadata pass before
  reachable IDs become `verified`.

## Hard Stops

- Do not add workflow deletion, OAuth, provider setup, scheduler configuration or deep record fixtures.
- Do not expose token values, raw Keychain internals or secret refs in the default layer.
- Do not move API/state into presentation components or AppShell.
- Do not rewrite Channel Activity, external-work contracts, Keychain storage or background semantics.
- Do not claim native Desktop secret persistence from browser E2E.
