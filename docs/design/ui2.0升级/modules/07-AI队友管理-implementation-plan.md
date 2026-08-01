# P8.1 AI Teammate Management Implementation Plan

> 2026-07-30 model binding implementation is owned by
> [`conversation-model-binding-and-creation-validation-implementation-plan.md`](../../conversation-model-binding-and-creation-validation-implementation-plan.md).
> It supersedes optional provider ids for public teammate creation while preserving the
> historical UI2 evidence below.

> 2026-07-30 update: `Tasks` and `Activity` were removed from private-chat Settings. Their former page components,
> page-only controllers, styles and focused specs are retired. Private-message task creation and private Dock activity
> remain supported through their existing owners. Sections 20 and 22 below are historical completion records and no
> longer define reachable Settings tabs.

## 0. 2026-07-30 Private Settings Shell Parity

- Recompose private teammate Settings to the verified Channel Settings shell grammar: 58px back/title/subtitle Header,
  horizontal navigation, and one internally scrolling content owner.
- Keep `TeammateSettingsHeader` and `TeammateSettingsNavigation` as focused display owners. `TeammateWorkspace` only
  selects the active section and mounts the content; it must not absorb tab business logic while already over 1,800 lines.
- Reuse the channel Header and tab geometry/tokens. Teammate navigation may retain its existing button semantics for
  compatibility, but visual order, height, focus treatment, overflow, and content boundaries must match Channel Settings.
- Remove `TeammateSettingsSummaryPanel` from production. Its provider/model/channel/skill/memory/MCP values are repeated
  in their owning sections and must not reserve a third column.
- Preserve Profile/Model Reset and Save behavior, protected teammate visibility, all APIs, persistence, permissions,
  model binding, channel membership, memory, skills, MCP, and danger semantics.
- Update focused browser coverage to assert horizontal navigation, absent summary sidebar, 58px Header, one content
  scroll owner, 1440x960 Light and 1280x800 Dark containment, back navigation, and no console/page errors.
- Section 12 below remains historical implementation evidence. Its three-column grid and summary composition are
  superseded by this section; its field behavior and feedback contracts remain valid.

### 0.1 2026-07-31 Core Navigation And Ownership

- Preserve daemon routes, contracts, SQLite schema, policy precedence, memory lifecycle, Skill Registry ownership and
  runtime behavior. The existing teammate update contract already owns `allowedTools` and `approvalProfile`; the new
  surface must not create a second permission API.
- Replace `permissions + mcp` navigation with one `tools_permissions` section for editable teammates. A focused
  permissions controller owns draft/save/conflict/error state; a composed surface owns capability controls, effective
  Workspace limits and the existing MCP authorization section when servers exist. The teammate permission surface does
  not render raw tool ids, required actions or the full allow/ask/deny decision list.
- Workspace defaults remain read-only on this surface. Enabling teammate capability cannot override Workspace deny;
  only an actual deny/error renders a scoped repair link. Ordinary healthy state has no Settings jump.
- Remove `memory` and `danger` from reachable navigation. Keep memory loading/runtime data for private-chat projections;
  compose `TeammateDangerTab` under Profile for ordinary teammates without changing disable/delete controllers.
- Rework `TeammateSkillsTab` to a three-column list with immediate Switch mutation. Remove import, advanced ID binding,
  row details icon and Registry archive from this surface; retain unlink in the Drawer and expose one empty-state route
  to Settings > Skill Library.
- Skill filters become `all / using / unused / attention`. Search corpus is limited to display name, summary and mapped
  user-facing tool labels. Source diagnostics remain in the Drawer and may mark the row `Needs attention` without
  exposing source metadata in the list.
- Update Settings navigation, focused view-model/controller/component tests and existing teammate regressions. Verify
  1440x960 Light, 1280x800 Dark, internal scrolling, Switch keyboard behavior, no horizontal overflow and no console or
  page errors.
- Keep the Skill list at natural height for short content. Its viewport max-height must subtract the private Settings
  Header, tabs, content padding, toolbar and list header; long content scrolls only inside the list and must not make the
  outer Settings content owner scroll.
- Keep new production owners below 400 lines. `TeammateWorkspace.tsx` may only lose navigation/render composition and
  wire focused controllers; it must not absorb permission or Skill business logic.
- Keep private-header shortcuts focused: `TeammateChatHeader` renders only typed menu callbacks, a dedicated rename
  controller owns draft/busy/error/stale identity state, and a dedicated Dialog owns presentation. Rename reuses the
  existing teammate PATCH with only `displayName`; Context calls the existing explicit dock-page opener rather than the
  toolbar toggle.

### 0.2 2026-07-31 Local Web Verification

Status: **completed and verified locally**.

- The reachable navigation is `Profile / Model / Channels / Skills / Tools and permissions`; protected Ling Agent keeps
  only Profile, Model and Channels. Memory and lifecycle mutations retain their runtime owners but no longer own tabs.
- Current-teammate capability switches and approval mode save through the existing teammate update contract. Workspace
  deny remains authoritative and is the only state that exposes the scoped repair route. MCP authorization is embedded
  only when at least one server exists. The redundant permission `Technical information` disclosure is absent.
- Skills now use the three-column binding surface and row-owned Drawer. Import, manual Skill ID binding, Registry archive,
  source metadata and technical search values are absent from the default list.
- Web typecheck, lint, i18n and 13 Web unit tests pass. The complete `ui2-teammate-management-*.spec.ts` matrix passes
  `48/48`; selected Teammates integration passes `2/2`; MCP input/status regression passes `7/7`.
- Original-size visual review passed for Light `1440x960` and Dark `1280x800`, including permission labels, Workspace
  denial, Skill Drawer, attention state and overlay scrolling. Evidence uses the new `editable-tools-permissions`,
  `workspace-deny-zh-CN`, `binding-list-and-detail`, `attention-detail` and `overlay-scroll-zh-CN` screenshots.
- No daemon route, contract, SQLite schema, Workspace policy precedence, Skill Registry ownership, memory lifecycle or
  teammate deletion semantics changed in this slice.
- Permissions, Skills and Danger evidence metadata retain their historical records and append the 2026-07-31
  replacement screenshots, current product boundaries and hashes.
- Follow-up removal of the redundant permission `Technical information` disclosure passed focused Permissions `4/4`,
  Web typecheck, lint, i18n and `git diff --check`; the wider `48/48` matrix remains the preceding integration baseline.

### 0.3 2026-07-31 External Tools Productization

Status: **completed and verified locally**.

- Preserve the existing MCP Server, Tool, teammate-binding, Run resolver and approval semantics. User-facing copy calls
  this capability `External tools`; MCP remains an internal/API term and a global Settings owner.
- Replace the embedded technical tree with a compact service list. Each row shows display name, productized readiness,
  authorized capability count and one `Manage` action. The section remains absent when no Server exists.
- Open one shared right Drawer for a service. The Drawer owns user-visible capability search/filter and shared Checkbox
  selection; raw names, ids, transport, secret fields, future-tool automatic authorization and bulk-select controls stay
  absent.
- Add `useTeammateExternalToolsController` for authoritative/draft bindings, dirty/reset/save, identity guards, Drawer
  state and selection mutation. Add pure `teammate-external-tools-view-models.ts` for rows and filtering. Remove MCP
  draft/search/expanded state and mutation helpers from `TeammateWorkspace.tsx` instead of adding more behavior there.
- The existing Settings Header composes permission and external-tool dirty/busy state into one Reset/Save owner. The
  external-tools section has no local Save button; a failed save remains scoped to that section and preserves the draft.
- Update MCP-focused durable tests to assert the new presentation while retaining Run authorization, selected-tool
  payload, disabled Server, identity-race, busy/error, keyboard, Drawer/Escape, Light/Dark and overflow coverage.
- Verify Web typecheck, lint, i18n, focused MCP/teammate tests, `git diff --check`, and original-size `1440x960` Light plus
  `1280x800` Dark screenshots. Do not modify API, contracts, SQLite schema, secret storage or runtime authority.
- Implemented with a compact service list, shared Drawer/Checkbox controls, one Header save owner and a focused
  controller/view-model split. Dynamic service descriptions containing connection-layer terminology are omitted from
  both rendering and search without rewriting source data. The capability list stays natural-height until overflow.
- Focused external-tool and MCP integration tests pass `7/7`; the legacy-writer regression passes `8/8`. Web typecheck,
  lint, i18n and `git diff --check` pass. Current Light/Dark screenshots and hashes are recorded in the Permissions
  evidence package. No route, contract, SQLite, secret, Run resolver or approval-precedence behavior changed.

### 0.3 2026-07-31 Profile Layout Simplification

- Reorder the ordinary profile into identity, description, status/sidebar display, folded advanced content and the
  existing management section. Remove the duplicate status dot and the detached remove-avatar icon.
- Replace the independent pinned/hidden Switches with one derived `Sidebar display` Select while preserving the existing
  `pinned` and `hidden` request fields. Existing contradictory data resolves visually to Hidden until the user chooses a
  different value; no background mutation occurs.
- Keep the avatar crop/upload/delete controller and shared crop Dialog. Use one avatar Menu trigger with Change and
  Restore-default actions, preserving focus restoration and action-scoped busy/error behavior.
- Extract `TeammatePersonaImportDialog.tsx` as the sole persona-import presentation owner. It supports a Markdown/text
  file name plus content or direct paste, never a visible editable source path, and reuses the existing preview/apply
  APIs without adding routes or storage.
- Changing persona input invalidates the current preview. `applyPersonaDraft()` returns a local success result so the
  Dialog closes only after a successful existing update; failure retains the input and preview.
- Keep `TeammateProfileTab.tsx`, the new Dialog and focused CSS below 400 lines. Do not add profile behavior to the
  1,800-line `TeammateWorkspace.tsx` beyond typed composition wiring.
- Update focused Profile E2E for hierarchy, sidebar-display mapping, avatar Menu, file/paste persona input, preview
  invalidation, success/failure, Esc/focus, Light `1440x960`, Dark `1280x800`, console and overflow. Run Web typecheck,
  lint, i18n and `git diff --check`, then recapture current Profile evidence and hashes.

## 1. Slice Contract

P8.1 按以下顺序实施：

```text
List/Search -> Create -> Profile -> Model -> Skills/MCP -> Memory
-> Channels/Tasks/Permissions/Activity/Danger
```

`List/Search` 已关闭 `TEAMMATE-LIST-001`，`Default roles / Create` 已关闭
`TEAMMATE-CREATE-001`，`Profile / Avatar` 已关闭 `TEAMMATE-PROFILE-001`。当前下一段是
`Skills/MCP`；Model 已关闭 `TEAMMATE-MODEL-001`。后续阶段仍使用本文件记录，但没有通过 focused tests
和实页证据前不得提前标记完成。

不改变 daemon API、contracts、数据库、队友创建/删除语义、Settings IA、`ViewId`、路由、私聊会话或
频道成员关系。

## 2. Authoritative Baseline

| Owner | Baseline |
|---|---:|
| `AiTeammatesPage.tsx` | 648 lines |
| `TeammateWorkspace.tsx` | 2,489 lines, orchestration debt |
| `teammates.css` | 4,735 lines, list selector has multiple competing generations |
| `teammates.spec.ts` | creation/private chat/business regression owner |
| `ui2-settings-workspace-tools.spec.ts` | Settings embedded boundary regression owner |

Current facts:

- list excludes disabled teammates but has no real search/filter control;
- rows hand-roll status, action buttons and a document-listener menu;
- the same row is restyled by `teammates.css`, `components.css` and `strict-console.css`;
- `aiTeammatesLoading` and `refreshAiTeammates` already exist in the domain but are not passed to the list page;
- domain load errors are available through `teammatesDomain.error` and can be projected without a new API;
- custom creation, avatar upload, provider preflight, progress steps and successful private-workspace opening already have
  business regression coverage and are not rebuilt in this slice.

## 3. Module Boundaries

```text
AiTeammatesPage.tsx
  composition, create/detail overlay state
  -> TeammateManagementList.tsx
       shared Input/Select/DataRow/StatusIndicator/Button/IconButton/Menu/EmptyState/Skeleton
       -> useTeammateManagementListController.ts
            query + filter + derived rows
            -> teammate-management-list-view-models.ts
                 pure row/status/count/search projections

AppShell.tsx
  existing domain wiring only: loading, refresh, scoped load error

teammate-management-list.css
  list/shell geometry and custom content slots only
```

Rules:

- new production owners remain below 400 lines;
- `TeammateWorkspace.tsx` receives no list-management behavior;
- `AiTeammatesPage.tsx` must shrink and retain create/template composition only;
- Feature imports shared UI through `apps/web/src/shared/ui`, never Radix or package internals;
- view-models return stable ids/translation keys, not translated strings or JSX;
- `teammates.css` must decrease; migrated list selectors are deleted in the same patch;
- focused CSS has no color literal, `!important`, Theme/Profile ID selector, `transition: all` or `.ling-ui-*` selector.

## 4. List And Search Implementation

### A. Focused test first

Create `ui2-teammate-management-list.spec.ts` before production edits. Lock:

1. initial loading, background refresh and retained rows on refresh failure;
2. search by name/model/channel and status filter for ready/needs-model/hidden;
3. empty versus no-result semantics and clear-filter action;
4. one status per row, open/configure primary action and Radix Menu keyboard/focus behavior;
5. long labels, 1440x960 Light, 1280x800 Dark, reduced motion, no overflow and no console errors.

Existing `teammates.spec.ts` remains the owner for create/delete/private-chat business behavior. Compatibility ARIA and
stable row classes remain only where those tests still express product behavior.

### B. Pure projections

`teammate-management-list-view-models.ts` derives:

- active rows and counts;
- provider readiness and primary status;
- role/model/channel/time search corpus;
- filter matching and no-result reason;
- row primary action id;
- model/channel/time summary values.

Priority is `needs-model > hidden > ready`. Hidden remains a row attribute and filter, while `needs-model` remains the
single visible status when both apply.

### C. Controller

`useTeammateManagementListController.ts` owns only local query/filter state and memoized projections. It exposes clear
filters and never calls API, mutates teammates or stores preferences.

### D. Shared list surface

`TeammateManagementList.tsx` renders:

- compact heading/count and Refresh icon;
- Search Input and status Select;
- load error InlineFeedback;
- initial Skeleton, loaded DataRows, empty state or no-result state;
- Open/Configure Button and shared More Menu with Pin/Hide/Delete.

The Radix Menu replaces `openTeammateMenuId`, `document.pointerdown`, `document.keydown` and local popover CSS.

### E. Wiring

Both standalone and Settings-embedded `AiTeammatesPage` receive:

- `isLoading={aiTeammatesLoading}`;
- `onRefresh={() => refreshAiTeammates(form.cwd.trim())}`;
- `loadErrorMessage` only when `teammatesDomain.error.scope === "load"`.

No domain request, retry policy or error ownership changes.

### F. Focused CSS and deletion

- Add `apps/web/src/styles/teammate-management-list.css` after temporary legacy owners.
- Move page-list shell, toolbar, summary cells, row custom slots, hidden opacity and responsive grid into that file.
- Delete migrated `.teammate-draft-*`, `.teammate-row-*`, `.teammate-model-pill`, `.teammate-channel-pill`,
  `.teammate-updated-time` selectors from `teammates.css`.
- Remove list-specific compatibility selectors from `components.css` / `strict-console.css` when no remaining consumer
  requires them; do not broaden this into unrelated teammate/create cleanup.
- Record exact line-count delta in CSS and selector matrices at closeout.

## 5. Later P8.1 Phases

| Phase | Existing owner | Required migration | Stop boundary |
|---|---|---|---|
| Create | `TeammateCreateDrawer` | shared form/progress/dialog primitives, preserve real preflight/progress | no new create API or fake success |
| Profile | `TeammateWorkspace` tabs | identity/avatar/description/status, shared crop/dialog | preserve editable-field policy |
| Model | `TeammateModelTab` | ready model selection, missing-key repair, scoped check | no provider behavior change |
| Skills/MCP | Skills and MCP tabs | search/bind/check/details and shared rows | no permission expansion |
| Memory | `TeammateMemoryTab` | discoverable list/review/editor/delete | no memory retention change |
| Channels/Tasks | existing tabs | membership/task state and terminal entry | no membership/task state-machine change |
| Permissions/Activity | existing tabs | effective policy and auditable activity | no raw secret or hidden authority |
| Danger | `TeammateDangerTab` | archive/hard-delete confirmation and blockers | no delete cascade change |

Each later phase starts with a separate state audit and focused E2E; already verified private Header/Feed/Composer/Dock
surfaces remain regression-only.

## 6. Verification

```bash
git diff --check
corepack pnpm --filter @ling-stack/ui-react test
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web test:e2e -- ui2-teammate-management-list.spec.ts
corepack pnpm --filter @ling-stack/web test:e2e -- teammates.spec.ts ui2-settings-workspace-tools.spec.ts dark-mode.spec.ts
```

Evidence directory:

```text
docs/design/ui2.0升级/evidence/features/ai-teammate-management-list/
```

Minimum changed-state screenshots:

- `1440x960-ling-light-loaded-search.png`
- `1440x960-ling-light-refresh-failure.png`
- `1280x800-ling-dark-hidden-filter.png`
- `1280x800-ling-dark-empty.png`

`metadata.md` records branch/HEAD/dirty state, Vite URL, fixture, viewport, Theme Pack, locale, search/filter state,
console, overflow, keyboard, reduced motion and SHA-256.

## 7. Exit Gate

- Search/filter/loading/empty/no-result/error/hidden/needs-model/long/menu states are all real and tested.
- Background refresh preserves authoritative rows and scopes busy state to Refresh.
- One visible primary status per row; raw ids and technical diagnostics remain out of the default layer.
- No handwritten document menu listener or custom menu popover remains in the list.
- New owners remain below 400 lines; `AiTeammatesPage.tsx` shrinks; 2,489-line `TeammateWorkspace.tsx` is untouched.
- `teammates.css` decreases and focused CSS is the single migrated owner.
- Static checks, focused/selected regressions and real Vite evidence pass before `TEAMMATE-LIST-001` becomes `verified`.

## 8. Hard Stops

Stop and ask before changing API/contracts/database, delete/archive semantics, protected teammate policy, model readiness
rules, Settings IA, route/ViewId, create progress semantics, private-chat behavior or Desktop persistence. Remote/local
overlap must preserve both sides; no reset/clean/stash/switch/rebase/merge/commit/push is part of this slice.

## 9. List/Search Completion Record

- Status: `TEAMMATE-LIST-001` verified on 2026-07-20; later P8.1 phases remain inventory.
- Structure: `AiTeammatesPage.tsx` `648 -> 484`; new list component/controller/view-model are `316/51/129`
  lines; 2,489-line `TeammateWorkspace.tsx` was not expanded.
- CSS: `teammates.css` `4,735 -> 4,344`; 283-line focused owner contains zero color literals、`!important`、
  Theme/Profile selector、`transition: all` or package-private selector; migrated legacy row selectors outside it are 0.
- Behavior: real loading/refresh/error, search/filter, empty/no-result, visible single status, long content, bounded
  scroll and Radix Menu focus/Esc are closed without API or state-machine changes.
- Verification: package `50/50`, focused `4/4`, selected business/embedded/Dark `30/30`, typecheck、i18n、lint and
  diff check passed.
- Evidence: four original-size screenshots and hashes are in
  [`evidence/features/ai-teammate-management-list/metadata.md`](../evidence/features/ai-teammate-management-list/metadata.md).
- Residual at the P8.1a checkpoint: adjacent Default roles/create and all detail Tabs were still open. P8.1b has
  since closed the create surface; Profile/Avatar and the remaining detail Tabs continue as independent later phases.

## 10. Default Roles / Create Contract

### 10.1 Preserved Business Flow

本切片只迁移展示层，以下行为是回归基准，禁止重写：

- 模板创建与 `Start from blank` 自定义创建使用同一个真实 `onCreate`；
- 自定义头像仍接受 PNG/JPEG/WebP/GIF，并在创建成功前只使用 object URL 预览；
- 只能选择模型工作台中通过 chat capability 与 preflight 的 provider；
- 创建前执行现有 provider model check，失败不得创建队友记录；
- workspace、model、record、avatar、channels、memory、refresh 七步进度保持真实事件驱动；
- 失败停留在 Dialog，允许返回原设置或打开 Model Workbench；
- 成功后关闭整个创建 Dialog，并在有 teammate id 时打开新队友私聊。

### 10.2 Default Roles Surface

```text
Default roles
  New AI teammate
  compact role rows
    role icon | role name + one-line purpose | chevron
```

- 角色面板是紧凑辅助面，不使用大卡片、彩色角色块、伪 `View` 文案或 raw capability 信息。
- 整行是唯一点击目标；hover、focus、selected 与 Dark 使用共享 Button token，不写主题 selector。
- 长名称和说明单行截断并保留 `title`；角色详情仍由现有 shared Dialog 打开，Esc 后焦点返回原行。
- `New AI teammate` 是面板唯一主行动；在窄 Settings 嵌入态不得换行挤压标题。

### 10.3 Create Dialog Grammar

```text
DialogHeader
DialogBody
  role_select: role chooser + name/channel/model
  custom_setup: Back + avatar + name/model/brief/channel
  setup_progress: one summary + seven real steps
DialogFooter
  scoped blocker / secondary action / primary action
```

- Dialog 直接使用 shared `Dialog`，不再经过 deprecated `CreateDialogShell`。
- 名称、简介、模型和频道使用 shared `Field/Input/Textarea/Select`；普通命令使用 shared `Button/IconButton`。
- 角色选择使用两列紧凑按钮，在较矮桌面窗口仍有唯一 body scroll owner；footer 不进入滚动区。
- 自定义页铺满 Dialog body，但不改变 Dialog 几何；头像上传按钮、色板和删除均有键盘焦点与 ARIA。
- 进度页只显示一个主状态；成功、失败、运行中使用语义 token，原始 provider 响应不进入默认层。
- 创建中 Dialog 不可 Esc、外部点击或关闭；失败与编辑态可关闭，焦点返回触发按钮。
- 无可用模型时使用 compact `EmptyState` 和 `Open Model Workbench`，不显示可提交的假表单状态。

### 10.4 Reachable States

| State | Trigger | Required result |
|---|---|---|
| role default | open from Sidebar/Settings/list | default template and ready model selected, no record created |
| role selection | choose another template | name/description projection updates, one `aria-pressed=true` |
| role detail | click Default roles row | shared Dialog, Esc close and trigger focus restore |
| custom setup | Start from blank | Back, avatar, color, name, model, brief and channel remain reachable |
| avatar selected | upload supported file | local preview/file name/remove action, no upload before create |
| no model | no ready chat provider | persistent empty/repair action, create disabled |
| creating | submit valid input | non-dismissible Dialog, seven event-driven steps, local busy state |
| model failure | provider check rejects | no teammate record, failed step and repair/back actions remain |
| partial failure | later setup step fails after record creation | warning result + failed step + Open teammate chat; no Back to setup or duplicate record |
| success | all steps complete | Dialog closes and created private chat opens |
| long/i18n | long role/model/channel/name | no horizontal overflow at both target viewports |

### 10.5 Module And CSS Boundary

```text
AiTeammatesPage.tsx
  -> TeammateRoleCatalog.tsx
  -> TeammateCreateDrawer.tsx (state/orchestration only)
       -> TeammateCreateRoleStep.tsx
       -> TeammateCustomSetupStep.tsx
       -> TeammateCreateProgress.tsx
       -> teammate-role-icons.tsx

teammate-management-create.css
  role catalog + create-specific geometry only
```

- 新 production owner 目标低于 400 行；`TeammateCreateDrawer.tsx` 必须从 594 行降到 400 行以下。
- 不向 2,489 行 `TeammateWorkspace.tsx` 增加创建逻辑。
- 新 focused CSS 禁止颜色字面量、`!important`、Theme/Profile selector、`transition: all` 和
  `.ling-ui-*` 私有 selector。
- 同一 patch 删除 `teammates.css`、`strict-console.css` 和 `components.css` 中已迁移的 role/create selector；
  focused CSS 必须在 legacy owner 后加载。

### 10.6 Verification And Evidence

Focused owner：`ui2-teammate-management-create.spec.ts`。既有 `teammates.spec.ts` 继续拥有 durable create、
provider failure、avatar upload、sidebar entry 和 private-workspace 业务回归；
`ui2-settings-workspace-tools.spec.ts` 继续拥有 Settings overlay/focus boundary。

证据目录：

```text
docs/design/ui2.0升级/evidence/features/ai-teammate-management-create/
```

最少截图：

- `1440x960-ling-light-default-roles.png`
- `1280x800-ling-dark-role-select.png`
- `1440x960-ling-dark-custom-setup.png`
- `1280x800-ling-dark-model-failure.png`
- `1440x960-ling-light-partial-warning.png`

只有 shared primitives、focused/selected regression、双 viewport/Theme 实页交互、console/overflow、键盘、
截图与 metadata 全部通过后，`TEAMMATE-CREATE-001` 才能从 `designed` 进入 `verified`。

## 11. Default Roles / Create Completion Record

- Status: `TEAMMATE-CREATE-001` verified on 2026-07-20; next slice is Profile/Avatar.
- Structure: `AiTeammatesPage.tsx` `484 -> 421`; `TeammateCreateDrawer.tsx` `594 -> 368`; role catalog,
  role step, custom setup, progress, shared fields and icon owners are all below 400 lines. The 2,489-line
  `TeammateWorkspace.tsx` was not expanded with create behavior.
- CSS: `teammates.css` `4,344 -> 2,864`; focused role catalog/create/progress owners are `153/325/135`
  lines. Color literals, `!important`, Theme/Profile selectors, `transition: all`, package-private selectors and
  migrated legacy selector duplicates are all zero.
- Behavior: shared role catalog and Dialog/Form primitives preserve template/custom avatar, ready-model preflight,
  seven event-driven steps, failure repair, success close/open and focus rules. A post-record setup failure now
  exposes a warning and opens the existing teammate without offering a duplicate-creating retry.
- Verification: package `50/50`, focused `5/5`, selected business/embedded/Dark `35/35`, typecheck, i18n, lint
  and diff check passed.
- Evidence: five original-size screenshots and hashes are recorded in
  [`evidence/features/ai-teammate-management-create/metadata.md`](../evidence/features/ai-teammate-management-create/metadata.md).
- Residual at this record: Profile/Avatar, Model, Skills/MCP, Memory and Channels/Tasks/Permissions/Activity/Danger
  remained later P8.1 phases. Profile, Model, Skills, Tasks, Permissions and Activity were subsequently closed by their
  own verified records; Creation UI remains regression-only.

## 12. Settings Shell And Profile/Avatar Contract

### 12.1 Entry Audit

- Real entry: AI teammate private chat -> Settings icon -> Profile; teammate switch resets to Chat/Profile and current
  Settings navigation remains the authority.
- Existing API/domain owners already support `UpdateAiTeammateRequest`, avatar upload/delete and persona
  preview/apply. No API, contract, database, route, `ViewId`, Settings IA or editable-field change is required.
- `TeammateWorkspace.tsx` is 2,489 lines; Profile logic must move to a focused controller before migration.
- `TeammateProfileTab.tsx` is 207 lines but uses legacy buttons/fields/select/toggles, duplicate Save, persistent success
  text and always-expanded persona fields.
- `AvatarCropDialog.tsx` is a 331-line verified user-profile implementation. Move its implementation to the Web shared
  UI adapter and leave the existing Profile import as a compatibility re-export; do not duplicate the crop engine.
- Profile/settings selectors currently live across `teammates.css` and `strict-console.css`, with hard-coded colors and
  a Theme-specific avatar exception. The migrated families require focused owners and zero duplicates.

### 12.2 Target Composition

```text
TeammateWorkspace.tsx
  -> TeammateSettingsHeader.tsx
  -> TeammateSettingsNavigation.tsx
  -> useTeammateProfileController.ts
  -> TeammateProfileTab.tsx
       identity + avatar actions
       lifecycle fields
       protected or advanced profile details
       shared AvatarCropDialog
  -> TeammateSettingsSummaryPanel.tsx
```

- `TeammateWorkspace` keeps active view/Tab and passes existing domain callbacks; it does not own avatar FileReader,
  crop, persona or Profile feedback state after extraction.
- Profile controller owns profile draft dirty/reset/save, independent avatar/persona busy states, scoped error and global
  success Toast. Model save remains with the existing Model owner until its own slice.
- Header/navigation are pure display owners below 150 lines. Profile/controller/shared crop owners stay below 400 lines.
- Shared crop adapter remains domain-neutral and imports no teammate API, route, state or types.

### 12.3 Reachable States

| State | Trigger | Required result |
|---|---|---|
| loaded standard | open Profile | avatar/name/status/pinned/hidden/description; advanced closed |
| dirty/reset | edit an allowed field | Save enabled; Reset restores authoritative teammate only |
| saving/success | Save | scoped busy, one global Toast, no persistent Saved strip |
| save failure | update rejects | draft retained, Profile InlineFeedback and retry |
| protected | open Ling Agent Profile | protected status + four editable surfaces only |
| avatar choose/crop | choose valid image | shared Dialog, drag/zoom, cancel/focus return, no upload yet |
| invalid avatar | non-image/unreadable | persistent local feedback; current avatar unchanged |
| avatar upload/remove | confirm crop/remove | scoped busy, updated avatar/fallback, Toast; failure remains repairable |
| persona closed | standard Profile | no source/content explanation wall in default layer |
| persona preview | expand and Preview | loading, draft identity, source status and warnings; no authority mutation |
| persona apply | Apply draft | profile updates, draft clears, Toast; failure keeps draft/input |
| long/i18n | long name/description/warning | internal wrap/ellipsis, no root overflow at 1440/1280 |
| reduced motion | crop/open/close under reduce | no drag/overlay geometry animation; focus and state remain correct |

### 12.4 UI And Feedback Rules

- Use shared `Button/IconButton/Input/Textarea/Select/Field/Switch/StatusIndicator/InlineFeedback/InspectorSection/
  DataRow/Dialog/Toast` only; no bare production button/input/select/textarea in new Profile owners.
- Camera and remove-avatar are icon-only with Tooltip/ARIA and stable hit areas. Logo and default teammate artwork are
  not replaced or recolored.
- Profile actions appear only in Header while Profile is active. Other Tabs retain their current action owner until
  migrated and do not receive a fake universal Save.
- Protected copy is one concise status sentence. Persona safety warnings remain visible inside the expanded owner;
  raw parser details stay folded or absent.
- Successful Save/avatar/persona operations never use `saveMessage` or local timeout. Global Toast owns dedupe/expiry;
  Profile `InlineFeedback` owns persistent failure.

### 12.5 CSS Boundary

```text
teammate-management-settings-shell.css
  settings grid/header/navigation/summary/content slots

teammate-management-profile.css
  profile identity/form/lifecycle/persona geometry only
```

- Remove migrated shell/profile/avatar/persona selectors from `teammates.css` and Profile compatibility selectors from
  `strict-console.css` in the same patch.
- Generic avatar rendering remains with its current shared/teammate identity owner; crop geometry stays in the existing
  focused crop CSS until final naming cleanup.
- New focused CSS has zero color literals, `!important`, Theme/Profile selector, `transition: all`, private keyframe or
  package-private `.ling-ui-*` selector.

### 12.6 Verification And Evidence

Focused owner: `ui2-teammate-management-profile.spec.ts`. Existing `teammates.spec.ts` retains durable update/persona/
avatar propagation and protected-policy regression; user `profile.spec.ts` / `ui2-settings-profile.spec.ts` protect the
shared crop extraction.

Required screenshots:

- `1440x960-ling-light-standard-profile.png`
- `1280x800-ling-dark-protected-profile.png`
- `1440x960-ling-dark-avatar-crop.png`
- `1280x800-ling-light-persona-draft.png`
- `1280x800-ling-dark-save-failure.png`

Only focused/selected tests, both themes/viewports, crop/keyboard/console/overflow, original-size review, hashes,
metadata and all migration matrices can move `TEAMMATE-PROFILE-001` from `designed` to `verified`.

## 13. Settings Shell And Profile/Avatar Completion Record

- Status: `TEAMMATE-PROFILE-001` verified on 2026-07-21; next slice is Model.
- Structure: `TeammateWorkspace.tsx` `2,489 -> 2,362`; the 314-line Profile controller owns dirty/reset/save,
  avatar and persona state. Profile/Header/Navigation/Summary owners are `278/52/42/53` lines; shared crop remains
  331 lines and domain-neutral.
- Behavior: one Header Reset/Save owner, folded advanced persona, protected Ling Agent field policy, crop before
  upload, action-scoped busy, expiring global success Toast and persistent local failure all match section 12.
- CSS: `teammates.css` `2,864 -> 2,648`, `strict-console.css` `1,187 -> 1,186`; focused Settings shell/Profile
  owners are `257/182` lines. Migrated legacy selector hits and focused color literal/`!important`/Theme/Profile/
  `transition: all`/private keyframe/`.ling-ui-*` hits are zero.
- Shared correction: compact `StatusIndicator` now establishes a relative positioning owner for its hidden label,
  preventing long internally scrolled content from increasing document root height.
- Verification: package `50/50`, focused `6/6`, Teammates `21/21`, selected Profile/Settings/Dark `16/16`, Web
  typecheck/i18n/lint/diff check and five original-size screenshots passed.
- Evidence: [`evidence/features/ai-teammate-management-profile/metadata.md`](../evidence/features/ai-teammate-management-profile/metadata.md).
- Residual: the 2,362-line workspace remains architecture debt. Model, Skills/MCP, Memory and remaining detail Tabs
  are later P8.1 slices and cannot inherit `verified` from Profile.

## 14. Model Assignment Contract

### 14.1 Entry Audit

Current reachable behavior:

- `TeammateModelTab.tsx` is a 103-line legacy surface using `SelectControl`, `MetaRow`, `StatusBadge` and raw buttons;
- `TeammateWorkspace.tsx` owns `settingsProvider`, readiness, `saving`, `saveMessage` and `saveSettings()` inside a
  2,362-line orchestration file;
- the only teammate mutation is the existing `providerPresetId` update; Model Workbench owns provider create/edit,
  API Key and check behavior;
- save success is a permanent inline `<small>`, while save failure is projected through the workspace-wide raw error;
- protected Ling Agent hides the Select but still derives rows from an optional provider id, allowing contradictory
  “managed” and “needs setup” output;
- model selectors remain in `teammates.css` and compete with the verified Settings shell owner.

No API, contract, database, route, Settings IA, provider state machine, private-chat runtime or Logo change is needed.

### 14.2 Target Module Boundary

```text
TeammateWorkspace.tsx
  composition only
  -> useTeammateModelController.ts
       draft dirty/reset/save/error/toast/runtime refresh
       -> teammate-model-view-models.ts
            pure provider/status/feedback/option projection
  -> TeammateModelTab.tsx
       shared UI rendering only

TeammateSettingsHeader.tsx
  current-tab Reset/Save owner without duplicating Model actions

teammate-management-model.css
  Model content geometry and responsive slots only
```

Rules:

- production owners stay below 400 lines;
- `TeammateWorkspace.tsx` must shrink and must not receive new Model state branches;
- view-model code contains no React, API calls or translated JSX;
- controller imports no provider mutation/check API and only calls existing `onUpdateTeammate`;
- Feature components import primitives from `apps/web/src/shared/ui` only;
- focused CSS contains no color literal, `!important`, Theme/Profile selector, `transition: all`, private keyframe or
  package-private `.ling-ui-*` selector;
- migrated `.teammate-model-*`, `.teammate-config-card` and Model-only notice/action selectors are removed from
  `teammates.css` in the same slice when no other consumer remains.

### 14.3 Pure Projection Contract

`buildTeammateModelViewModel()` receives teammate protection, authoritative/draft provider id and current providers.
It returns:

- one `primaryState`, translated label key and semantic tone;
- selected provider identity without leaking endpoint or secret details;
- stable Select options and compatibility/readiness annotations;
- compact summary rows for model and provider;
- optional productized blocker title/detail and repair intent;
- protected/no-provider rendering intent.

Priority is fixed:

```text
managed
  > unassigned
  > missing provider
  > disabled or non-chat
  > missing secret
  > unchecked
  > failed check
  > ready
```

The selected draft controls the previewed state. The authoritative teammate id controls dirty/reset. Missing saved
ids remain visible and diagnosable rather than being normalized to empty.

### 14.4 Controller Contract

`useTeammateModelController()` owns only:

- `modelDirty`, `savingModel` and `modelError`;
- reset of the provider field to the current teammate value;
- one guarded save through `onUpdateTeammate(teammate.id, { providerPresetId })`;
- applying the returned authoritative provider id to the shared settings form;
- best-effort refresh of the existing private runtime after save;
- an expiring, deduplicated success Toast and persistent local failure feedback;
- teammate-switch cleanup for Model error/busy state.

It does not own provider loading, provider checking, API Key entry, Workbench routing, profile fields or other Tabs.

### 14.5 Surface And Action Grammar

- Content starts with `Model assignment` and one `StatusIndicator`; no repeated card title or colored status pills.
- Ordinary teammates use one `Field + Select`. When no provider route exists, render compact `EmptyState` instead of
  an empty decorative panel.
- Protected Ling Agent renders one neutral managed `InlineFeedback`, no Select and no Model Header actions.
- A compact DataRow list shows model and provider only. Ready state has no green success banner.
- Blocked or missing states render one scoped `InlineFeedback`; raw provider response and route metadata stay absent.
- `Open Model Workbench` is always available as a secondary action and becomes the repair action for blocked states.
- Header Reset/Save follows the Profile interaction grammar but uses Model dirty/busy state. There is no second Save
  in content.
- Tab switch preserves the draft; teammate switch resets from the new authoritative object. Esc/focus behavior is
  inherited from Settings shell and shared controls.

### 14.6 Focused Test And Evidence

Create `ui2-teammate-management-model.spec.ts` before production edits. Lock:

1. ready provider, dirty selection, Reset, save loading, success Toast and returned authoritative state;
2. no binding, empty provider list, stored provider missing, disabled/non-chat, missing Key, unchecked and failed check;
3. protected Ling Agent managed state with no Select/Reset/Save;
4. failed save keeps the draft and renders local feedback without a permanent success line;
5. Model Workbench routing, long labels, zh-CN/en-US, Light/Dark, keyboard focus, reduced motion and no overflow;
6. Profile/List/Create/private-chat behavior remains regression-only and does not inherit Model state.

Required evidence directory:

```text
docs/design/ui2.0升级/evidence/features/ai-teammate-management-model/
```

Minimum original-size screenshots:

- `1440x960-ling-light-ready.png`
- `1280x800-ling-dark-missing-key.png`
- `1440x960-ling-dark-protected-managed.png`
- `1280x800-ling-light-save-failure.png`
- `1280x800-ling-dark-long-model.png`

Run package tests, focused Model E2E, `teammates.spec.ts`, Profile, Settings workspace-tools and Dark regressions,
Web typecheck/i18n/lint, `git diff --check`, console/overflow checks, original-size visual inspection and SHA-256.

### 14.7 Exit Gate

`TEAMMATE-MODEL-001` can move to `verified` only when every state in section 14.6 has real fixture coverage,
Header actions have one owner, success/failure feedback follows the global contract, the workspace and legacy CSS
shrink, both themes/viewports have inspected evidence, and coverage/migration/E2E/status documents are reconciled.

## 15. Model Assignment Completion Record

- Status: `TEAMMATE-MODEL-001` verified on 2026-07-21; next slice is Skills/MCP.
- Structure: `TeammateWorkspace.tsx` `2,362 -> 2,348`; Model projection/controller/surface owners are
  `217/113/105` lines. The controller only calls the existing teammate update callback.
- Behavior: deterministic managed-to-ready state priority, missing-id preservation, non-chat/disabled option truth,
  protected Ling Agent path, one Header Reset/Save owner, global success Toast and local persistent failure match
  section 14.
- CSS: `teammates.css` `2,648 -> 2,628`; focused Model owner is 113 lines and Settings shell registration is
  `257 -> 259`. Forbidden style/selector hits are zero.
- Verification: package `50/50`, focused `6/6`, selected business/Profile/Settings/Dark `36/36`, Web static gates
  and five original-size screenshots passed.
- Evidence: [`evidence/features/ai-teammate-management-model/metadata.md`](../evidence/features/ai-teammate-management-model/metadata.md).
- Residual: the 2,348-line workspace remains architecture debt. Skills/MCP, Memory and remaining Tabs cannot inherit
  `verified` and must extract before adding major behavior.

## 16. P8.1e Skills Management Implementation Plan

### 16.1 Preserved Business Boundary

This slice reuses `listSkills`, `getSkillSourceHealth`, `listTeammateSkills`, `replaceTeammateSkills`,
`createSkillImportDraft`, `publishSkillImportDraft` and `archiveSkill`. It does not change API contracts, Registry
ownership, Skill parsing, approval profiles, tool authorization, archive semantics, Settings IA or teammate runtime.
`TEAMMATE-MCP-001` remains inventory until its own focused slice is verified.

### 16.2 Module Split

```text
TeammateWorkspace.tsx
  composition + apply authoritative workspace Skill snapshot

useTeammateSkillsController.ts
  Skill data/UI state + existing API mutations + stale operation guard + Toast/error ownership

teammate-skills-view-models.ts
  pure row/state/source/filter/stats/action projection

TeammateSkillsTab.tsx
  compact summary + toolbar + bounded DataRow list + advanced binding composition

TeammateSkillInspectorDrawer.tsx
  details + folded raw/source sections + contextual actions

TeammateSkillImportDialog.tsx
  import fields + preview/warnings + publish footer

teammate-management-skills.css
  Skills-only layout, truncation, scroll and 1280 containment
```

The controller receives `cwd` and `teammate.id`, exposes `applySnapshot`, and owns Registry entries, bindings,
effective Skills and source snapshots. `refreshTeammateWorkspace` may continue fetching the aggregate snapshot but
must call the controller instead of setting five independent Workspace states. Cross-surface consumers read
`effectiveSkills`, executable count and bindings from the controller.

No new production owner may exceed 400 lines. `TeammateSkillsTab.tsx` must shrink below its current 504 lines;
`TeammateWorkspace.tsx` and `teammates.css` must decrease.

### 16.3 View Model Contract

Each row exposes translated display identity, summary, source summary, one `StatusIndicator` tone/label, tool count,
primary action, menu permissions and detail sections. Priority is:

```text
missing definition > enabled blocked > enabled executable > binding disabled > bindable
```

Filtering and sorting are pure. Enabled bindings sort first, disabled bindings second, bindable definitions third;
within each group use localized display name. Search includes technical source/blocker values for discovery but those
values stay out of the default row.

### 16.4 Interaction And Feedback

- Row click and a keyboard `Enter/Space` open the Drawer. Nested actions stop propagation.
- Bind/Enable/Disable is the only persistent row text action. Details is icon-only; low-frequency remove/archive use
  shared Menu. Archive opens a shared confirmation Dialog before the existing API call.
- `mutationKey` scopes loading to the initiating action. One replacement mutation runs at a time to avoid last-write
  wins against the complete binding array.
- Success uses `useLingToast`; operation errors are productized and retained locally. No raw HTTP route or provider
  response enters primary copy.
- Import draft changes invalidate the previous preview. Publish is disabled until the current content has a checked
  draft without error warnings.
- Closing and reopening Import preserves unfinished form during the current teammate session; successful publish or
  teammate switch resets it.

### 16.5 Focused CSS And Legacy Deletion

Register `teammate-management-skills.css` after the legacy teammate owner and existing P8.1 focused files. Move only
Skills shell/summary/toolbar/list/row/advanced/Drawer/Dialog layout selectors. Delete migrated `.teammate-skill-*` and
`.teammate-import-*` Skills selectors from `teammates.css`; do not move MCP/Memory/Channel selectors. The focused file
must contain no color literals, theme selectors, `!important`, `transition: all`, global element selector or package-
private `.ling-ui-*` override.

### 16.6 Focused Test And Evidence

Create `apps/web/e2e/ui2-teammate-management-skills.spec.ts` before production migration. Lock:

1. loaded summary/search/all five filters and bounded row list;
2. bindable -> Bind, executable -> Disable, disabled -> Enable, blocked and missing-definition truth;
3. source warning, Drawer folded raw details, keyboard open/Esc/focus restore;
4. user binding remove versus custom Registry archive confirmation and failure preservation;
5. advanced bind-by-ID validation, duplicate, success and API failure;
6. Import Dialog preview warning/error, stale-preview invalidation, publish success/failure and busy dismissal guard;
7. empty/no-result/long content, zh-CN/en-US, Light/Dark, reduced motion, console and document overflow;
8. Profile/Model/List/Create/private chat stay regression-only; MCP remains unchanged.

Required evidence directory:

```text
docs/design/ui2.0升级/evidence/features/ai-teammate-management-skills/
```

Minimum original-size screenshots:

- `1440x960-ling-light-loaded-search.png`
- `1280x800-ling-dark-blocked-source-warning.png`
- `1440x960-ling-light-skill-detail.png`
- `1280x800-ling-dark-import-error.png`
- `1440x960-ling-dark-archive-confirm.png`

Run shared package tests, focused Skills E2E, `teammates.spec.ts`, Model/Profile/Settings workspace-tools and Dark
regressions, Web typecheck/i18n/lint, `git diff --check`, forbidden-selector checks and real Vite screenshot review.

### 16.7 Exit Gate

`TEAMMATE-SKILLS-001` can move to `verified` only when every reachable state above has real fixture evidence,
Workspace/CSS line counts decrease, shared overlays own Escape/focus, success/failure follow the global feedback
contract, both themes and both desktop viewport baselines pass, and all coverage/migration/status documents are
reconciled. Code presence or the legacy `teammates.spec.ts` flow alone is not completion evidence.

### 16.8 Completion Record

- Status: `TEAMMATE-SKILLS-001` verified on 2026-07-21; MCP remains decision-gated and Memory may proceed as an
  independent audit.
- Structure: `TeammateWorkspace.tsx` `2,348 -> 2,098`; focused controller/types/view-model/Tab/Import/Drawer owners
  are `399/65/226/354/161/198` lines. The controller only composes existing Skill and teammate APIs.
- CSS: `teammates.css` `2,628 -> 2,105`; focused Skills owner is 390 lines. Role-template preview Skills use a
  separate 197-line role-catalog owner, and legacy Skills selector hits outside focused owners are zero.
- Behavior: deterministic state/filter projection, complete binding replacement guard, latest-published source
  selection, stale operation/teammate protection, import preview/publish lifecycle, distinct unlink/archive semantics,
  global success Toast and scoped persistent failures match sections 16.3-16.4.
- Verification: shared packages `50/50 + 10/10`, focused `13/13`, selected `52/52`, Web static gates and five
  original-size screenshots passed.
- Evidence: [`evidence/features/ai-teammate-management-skills/metadata.md`](../evidence/features/ai-teammate-management-skills/metadata.md).
- Residual: the 2,098-line workspace remains architecture debt. MCP, Memory and remaining Tabs must continue the
  extraction pattern; none inherit `verified` from Skills.

## 17. P8.1f MCP Authorization Implementation Plan

### 17.1 Pending Decision Gate And Preserved Boundary

The user has not selected these MCP options yet. The recommended implementation path is A/A/A:

- expose bounded MCP list options through the client and load up to the daemon's current 500-item maximum per query;
- make Core teammate-binding replacement prevalidated and transactional;
- preserve and disclose existing `all_current_tools`, allow one-way conversion to explicit selection or Clear, and do
  not expose creation of a new automatic binding.

| Decision | A - recommended | B | Current state |
|---|---|---|---|
| Catalog limits | expose bounded query options and load up to 500 per Server | keep silent 100/200 defaults | pending user confirmation |
| Replace safety | prevalidate and commit in one SQLite transaction | UI-only migration with partial-loss risk | pending user confirmation |
| Future-tool authorization | disclose/migrate existing automatic bindings, create explicit bindings only | expose a new automatic authorization switch | pending user confirmation |

No production P8.1f edit may begin by treating these recommendations as approval. Skills work and other independent
UI 2.0 slices may continue while this gate is open.

The slice does not add a transport, OAuth flow, secret value, approval capability, database field, route, `ViewId`,
Settings section or teammate authority. Settings MCP remains the only create/edit/sync/delete owner. Existing
`approvalOverrides` are carried through unchanged and remain outside this visual migration.

### 17.2 Safety Foundation

1. Extend API-client/Web MCP list adapters with optional `{ enabled, limit }` while preserving existing callers.
2. Fetch Servers with `limit=500`, then fetch tools per Server with `limit=500`; do not use one globally truncated tool
   request as the authorization catalog.
3. In `McpStore.replaceTeammateMcpBindings`, dedupe and validate all Server ids before mutation, then execute delete and
   inserts in one SQLite transaction. Add a regression proving an invalid Server leaves every original binding intact.
4. Preserve the daemon request/response contract. No migration or response shape changes are allowed.

### 17.3 Module Boundary

```text
TeammateWorkspace.tsx
  active Tab + shared workspace composition only
  -> useTeammateMcpController.ts
       authoritative/draft snapshots, load/refresh/check/save, dirty/reset
       request identity, scoped busy/error/stale, Toast
       -> teammate-mcp-view-models.ts
            pure eligibility/status/assignment/count/filter/stale projections
  -> TeammateMcpTab.tsx
       -> TeammateMcpServerRow.tsx
       -> TeammateMcpToolList.tsx

TeammateSettingsHeader.tsx
  generic current-Tab action model; Profile/Model behavior remains unchanged

teammate-management-mcp.css
  MCP geometry, truncation and bounded scroll only
```

New production owners stay below 400 lines. `TeammateWorkspace.tsx` must shrink from the post-Skills baseline and may
not keep MCP API calls, binding mutation helpers, search/filter maps or success/error state. The Header must not gain a
third hard-coded `mcpActive` branch; convert it to a pure generic action contract while preserving verified Profile and
Model labels, disabled states and tests.

### 17.4 Pure Projection Contract

`buildTeammateMcpViewModel()` receives Servers, complete per-Server tools, authoritative/draft bindings and global
query/filter. It returns stable translation keys and values for:

- one Server health state using the fixed priority in the design contract;
- assignment state `none | selected | automatic | paused`;
- runtime-eligible, explicitly selected, effectively authorized, unavailable-selected and stale-selected counts;
- tool rows with `available | tool-disabled | server-excluded | stale` availability;
- product display identity, side-effect label, folded raw details and repair intent;
- global visible Server rows and temporary search-driven expansion.

Canonical dirty comparison sorts bindings, selected tool names and approval override keys. Timestamps never participate.
For selected mode, effective authorization is `binding.enabled && eligible && selected`. For automatic mode it is
`binding.enabled && eligible`. A disabled binding never appears authorized. Clear operates on binding existence rather
than visible tool count.

### 17.5 Controller Contract

`useTeammateMcpController()` owns:

- initial and background load with a monotonically increasing request id and teammate identity guard;
- authoritative and draft bindings, dirty/reset and complete per-Server tool maps;
- global query/filter plus explicit expanded Server ids;
- one `checkingServerId`, save busy, scoped load/check/save feedback and stale state;
- pre-save binding refresh; a changed authoritative snapshot blocks replacement and offers Reload rather than silently
  overwriting the external value;
- existing check and atomic replace calls, authoritative response application and a 3000ms deduplicated success Toast;
- explicit select/current-all, clear, re-enable, automatic-to-explicit and tool toggle transitions.

It does not own Server create/edit/sync/delete, secrets, approval overrides editing, teammate profile/model/skills or
Settings routing. `onOpenMcpSettings` is an existing-shell navigation callback supplied by the parent adapter.

### 17.6 Shared UI And CSS

- Add `Checkbox` to `@ling-stack/ui-react` using Radix Checkbox, export it through Web `shared/ui`, and add package tests
  for checked/disabled/keyboard/ref behavior. This is the only new primitive prerequisite.
- Header actions use shared Reset `IconButton` and primary Save `Button`; no content Save survives.
- Global filter uses compact `SegmentedControl`; Server/tool disclosure uses shared `Collapsible`; all icon actions have
  Tooltip, title and accessible name.
- Register `teammate-management-mcp.css` after Settings shell/Profile/Model/Skills focused owners. Delete the migrated
  `.teammate-mcp-*` family from `teammates.css` in the same patch.
- Focused CSS has no color literal, `!important`, Theme/Profile id selector, `transition: all`, private keyframe, global
  element selector or package-private `.ling-ui-*` selector.

### 17.7 Focused E2E And Evidence

Create `apps/web/e2e/ui2-teammate-management-mcp.spec.ts` and make it the visual/state owner. Lock:

1. partial explicit binding, truthful counts, Header dirty/reset/save, override preservation and expiring Toast;
2. disabled Server/tool, Server allow/deny list, stale selection and effective-runtime parity;
3. disabled binding plus zero-tool automatic binding, re-enable, convert-to-explicit and always-reachable Clear;
4. health priority, scoped Check busy/failure/retry and Settings repair navigation;
5. initial/background loading, retained stale data, no Servers, no tools, no result and teammate-switch request guard;
6. keyboard, rapid Collapsible reversal, reduced motion, long catalog, zh-CN/en-US, Light/Dark and no overflow.

`mcp.spec.ts` keeps durable payload/business assertions but drops legacy hard-coded color/height ownership.
`teammates.spec.ts` adds protected-tab and cross-Tab regression only. Also run Settings MCP, Profile/Model/Skills,
Settings workspace-tools and Dark regressions.

Evidence directory:

```text
docs/design/ui2.0升级/evidence/features/ai-teammate-management-mcp/
```

Required original-size screenshots:

- `1440x960-ling-light-selected-bindings.png`
- `1280x800-ling-dark-expanded-long-tools.png`
- `1440x960-ling-dark-all-current-warning.png`
- `1280x800-ling-light-no-servers.png`
- `1280x800-ling-dark-check-save-failure-zh-CN.png`
- `1440x960-ling-light-save-toast.png`

### 17.8 Exit Gate

`TEAMMATE-MCP-001` moves to `verified` only after atomic Core tests, API-client tests, shared Checkbox tests, focused and
selected Web regressions, both themes/viewports, keyboard/motion/console/overflow evidence, original-size review,
SHA-256 metadata and every migration/status document are reconciled. Neither code presence nor the existing MCP happy
path can close the Function ID.

## 18. P8.1g Memory Management Implementation Plan

### 18.1 Fixed Decision And Boundary

User selected option A on 2026-07-21: no permanent Memory delete. Preserve existing Archive/Reject/Quarantine and
review audit semantics. Do not add a route, database migration, hard-delete button or retention exception. Workspace-
wide policy/inbox remains an explicitly labeled governance subsection inside the teammate Memory page.

### 18.2 Module Split

```text
TeammateWorkspace.tsx
  Memory composition only
  -> useTeammateMemoryController.ts
       request identity, authoritative scopes/health/policy/inbox
       refresh/import/export/review busy and scoped feedback
       teammate switch guard and Toast
       -> teammate-memory-view-models.ts
            pure scope/health/review/status/filter/detail projection
  -> TeammateMemoryTab.tsx
       -> TeammateMemoryScopeList.tsx
       -> TeammateMemoryGovernanceSection.tsx
       -> TeammateMemoryReviewList.tsx
       -> TeammateMemoryImportDialog.tsx
       -> TeammateMemoryInspectorDrawer.tsx

teammate-management-memory.css
  Memory geometry, truncation and bounded scroll only
```

Move Memory helpers out of `teammate-workspace-utils.ts`; do not append another controller branch to the 2,098-line
workspace. Production owners stay below 400 lines. Existing API wrappers may expose already-supported filters but do
not change daemon contracts.

### 18.3 Implementation Order

1. Add focused types/view-model tests and request identity model.
2. Extract controller and apply the existing aggregate snapshot through one `applySnapshot` boundary.
3. Replace the 31-prop Tab contract with a focused controller view contract.
4. Move Import into shared Dialog and candidate/source detail into shared Drawer/InspectorSection.
5. Register focused CSS, then delete only proven Memory selectors from `teammates.css/strict-console/components.css`.
6. Add failure/delay/policy/review fixtures without weakening daemon validation.

### 18.4 Test And Evidence Gate

Create `ui2-teammate-management-memory.spec.ts`. Cover loading/retained stale/error, ordinary/protected scopes,
normal/warning/critical health, three policies, all review actions, secret-adjacent folding, import file/paste/preview/
warning/skipped/commit/failure, export exclusion/failure, teammate switch, zh-CN, keyboard, reduced motion and long
content. Run shared packages, teammates, Profile/Model/Skills, Settings workspace-tools and Dark regressions.

Evidence directory: `evidence/features/ai-teammate-management-memory/`. Minimum screenshots:

- `1440x960-ling-light-scopes-health.png`
- `1280x800-ling-dark-workspace-governance.png`
- `1440x960-ling-dark-import-warning.png`
- `1280x800-ling-light-review-inspector.png`
- `1280x800-ling-dark-protected-secret-reduced-motion.png`

`TEAMMATE-MEMORY-001` is verified only after original-size review, SHA-256 metadata, console/overflow assertions,
selector cleanup and all coverage/migration/status documents are reconciled.

### 18.5 Implementation Result

Status: `verified` on 2026-07-22.

- Focused capture passed `5/5`; `teammates.spec.ts` plus focused Memory passed `26/26` on isolated Vite port `4184`.
- Five recaptured original-size screenshots were reviewed after the shared Dialog close-control fix; hashes and reached
  states are recorded in `evidence/features/ai-teammate-management-memory/metadata.md`.
- The final owners are 384-line controller, 244-line view-model, 313-line primary CSS and 93-line overlay CSS. No new
  production owner exceeds 400 lines.
- `TeammateWorkspace.tsx` is 1,802 lines and remains architecture debt. MCP, Channels and Danger must continue the
  extraction pattern and may not append another major state owner.
- No permanent delete, API, contract, database, route, retention or protected-teammate behavior changed.

## 19. P8.1h Channels Relationship Implementation Plan

### 19.1 Fixed Boundary

This slice closes only `TEAMMATE-CHANNELS-001`. The authoritative business operations remain
`listTeammateChannels()` and `replaceTeammateChannels()` with a complete membership replacement payload. No API,
contract, daemon, Core, database, routing, Settings IA, Channel lifecycle, Task, Danger, MCP or private-chat behavior
may change.

`TeammateWorkspace.tsx` is already architecture debt. It may only import the focused controller, pass current
identity/channel inputs, consume effective memberships for existing Task/count projections and render the Channels
Tab. It must lose the old Channels state, save function, toggle function and main UI judgment instead of gaining
another inline behavior branch.

### 19.2 Work Breakdown

| Task | Content | Files / modules | Dependency | Parallel | Status | Verification | Weight |
|---|---|---|---|---|---|---|---:|
| P8.1h-D | zero-decision contract, state/action matrix and module boundary | module contract + this plan | R2/P8 + current API audit | no | completed | document review + diff check | 8% |
| P8.1h-VM | pure channel relationship, lifecycle, filter and payload projections | `teammate-channels-view-models.ts` | contract | yes | completed | focused browser assertions for all row states | 16% |
| P8.1h-C | identity-safe load/refresh/mutation controller, row busy/error and Toast | `useTeammateChannelsController.ts` | view-model payload rules | no | completed | loading/stale/race/failure/default E2E | 24% |
| P8.1h-UI | shared-primitive toolbar/list/row/empty/loading surface | `TeammateChannelsTab.tsx` | view-model + controller | yes | completed | primitive/ARIA/keyboard/disabled-reason E2E | 18% |
| P8.1h-W | remove inline Channels ownership and wire controller/effective memberships | `TeammateWorkspace.tsx` Channels-only lines | controller | no | completed | selected teammate/Tasks/Settings regressions | 8% |
| P8.1h-CSS | focused layout owner, import, proven Channels selector deletion | `teammate-management-channels.css`, `styles.css`, legacy Channels selectors | UI structure | yes | completed | selector scan, line budget, Light/Dark overflow | 8% |
| P8.1h-T | necessary i18n and focused/legacy/Settings/Dark tests | locale dictionaries + focused spec | implementation | no | completed | focused `7/7`; selected `30/30`; static gates | 8% |
| P8.1h-E | original-size evidence, console/overflow review and SHA-256 metadata | `evidence/features/ai-teammate-management-channels/` | all tests green | no | completed | six Light/Dark en/zh originals and SHA-256 | 10% |

The slice is **100%** complete by weighted work. Every row has implementation, named verification and evidence.

### 19.3 Pure View-Model Contract

`teammate-channels-view-models.ts` owns:

- `TeammateChannelFilter = all | active | paused` and localized label keys;
- one row per non-archived current Channel with `joined/default/protected`, lifecycle status, relationship status, searchable text,
  primary action and disabled reason;
- search/filter/no-result projection without mutating server state;
- normalized full-replacement payloads for `join`, `leave` and `set-default`;
- payload dedupe and the invariant that no more than one membership is default for this teammate.

An active joined row exposes `Leave` and, unless already default, `Set default`. An active non-member exposes `Join`.
Paused existing members expose only `Leave`; paused non-members expose no mutation and a visible reason. Archived
channels never produce rows or filter options, but archived memberships remain in normalized full-replacement payloads.
Protected/system rows expose `Always joined` and no action regardless of stored membership rows.

### 19.4 Controller Contract

`useTeammateChannelsController.ts` owns memberships, initial loading, background refresh, retained stale state,
query/filter, row-scoped busy/error and global success Toast. It loads on the `cwd::teammateId` identity, even before
the Tab opens, because existing Tasks/count projections consume the same authoritative memberships.

Every request captures identity and sequence. Identity change invalidates load and mutation results, clears local
filters/errors/busy and dismisses any old success Toast. Mutation submits the payload derived from the last
authoritative snapshot; it does not optimistically replace rows. On success it installs the response, calls the
existing `onRefreshChannels` callback and shows one scoped success Toast. Refresh callback failure must not roll back
the already authoritative membership response.

### 19.5 Surface And CSS Contract

`TeammateChannelsTab` receives one controller object. It renders a compact Header, shared `Input` Search, shared
`Select` lifecycle filter, refresh `IconButton`, optional retained `InlineFeedback`, stable `Skeleton`, compact
`EmptyState`, and a bounded shared `DataRow` list. Relationship and lifecycle each have one `StatusIndicator`; actions
use shared `Button`. No `StatusBadge`, raw `<button>`, ad hoc card or permanent save message remains.

`teammate-management-channels.css` loads after the Settings shell and existing P8.1 focused owners. It owns only
`.teammate-channels-*` layout/content slots. It contains no color literal, `!important`, Theme/Profile selector,
`transition: all`, private keyframe or package-private `.ling-ui-*` selector. Proven Channels-specific legacy selectors
are deleted from `teammates.css`; generic selectors still used by Danger/List are not removed in this slice.

### 19.6 Focused Tests And Evidence

`ui2-teammate-management-channels.spec.ts` must cover:

1. active joined/not joined/default rows, Join/Leave/Set default and exact replacement payload;
2. paused disabled reasons plus archived rows/filter/count omission while archived memberships remain in mutation payloads;
3. protected Ling Agent read-only Always joined and zero PUT;
4. initial loading, empty channel catalog, search no-result and Clear filters;
5. retained stale refresh, row-scoped mutation failure and success Toast without page `Saved`;
6. delayed load/mutation cannot cross teammate identity;
7. exactly 100 rows inside the one internal vertical scroll owner;
8. Light `1440x960` English and Dark `1280x800` Chinese/reduced-motion screenshots, focus, console and root overflow.

Required gates:

```text
git diff --check
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web test:e2e -- ui2-teammate-management-channels.spec.ts
corepack pnpm --filter @ling-stack/web test:e2e -- teammates.spec.ts
corepack pnpm --filter @ling-stack/web test:e2e -- ui2-settings-workspace-tools.spec.ts
corepack pnpm --filter @ling-stack/web test:e2e -- dark-mode.spec.ts
```

Evidence metadata records exact commands/results, viewport/locale/theme, root and list overflow measurements, console
errors, selector scans, production line counts and SHA-256 for every original PNG. Packaged Windows evidence is not
claimed by this Web slice.

### 19.7 Exit Gate

Do not mark the Function ID verified until all eight weighted tasks are completed, the legacy Channels scenario and
Settings embedded boundary pass, original screenshots are inspected at full size, and the module plus CSS/selector/
motion migration docs contain a truthful closeout. Any backend inability to enforce the product contract is reported
as a production gap rather than patched outside this slice.

### 19.8 2026-07-31 Archived-Channel Follow-up

- Archived Channels no longer produce relationship rows, totals, search results or filter options.
- Archived memberships remain in full-replacement mutation payloads and are never silently removed when another
  Channel relationship changes.
- Focused Channels passed `7/7`; Web typecheck and UI2 lint passed. Light `1440x960` and Dark `1280x800` screenshots
  were recaptured and reviewed, with current hashes recorded in the Channels evidence metadata.
- No API, contract, database, Channel lifecycle or membership persistence semantic changed.

## 20. P8.1i Tasks Projection Implementation Plan（历史，设置页已撤销）

### 20.1 Fixed Decisions And Boundary

User reconfirmed **Tasks A/A/A/A** on 2026-07-21. Restore the scoped Tasks Tab; keep `Create task from message` in
private chat; restrict creation to active teammate-member channels; open Runs when `currentRunId` exists and Work
Board otherwise. This path is unrelated to and must not remove or simplify the verified custom AI teammate creation
flow. Do not add an embedded terminal, auto-run, task status editor, API route or database field.

### 20.2 Module Split

```text
TeammateWorkspace.tsx
  Tasks composition only
  -> useTeammateTasksController.ts
       scoped list/refresh, request identity, retained stale/error
       form and message create, trigger-scoped busy, Toast
       -> teammate-tasks-view-models.ts
            pure eight-state/filter/channel/action projection
  -> TeammateTasksTab.tsx
       -> TeammateTaskCreatePanel.tsx
       -> TeammateTaskList.tsx
       -> TeammateTaskRow.tsx

TeammatePrivateChatFeed.tsx
  receives trigger-scoped create state and callback only

AppShell adapter
  existing Open Run / Open Work Board actions only

teammate-management-tasks.css
  Tasks geometry, truncation and bounded scroll only
```

Remove task state/create functions from the 2,098-line Workspace. New production owners stay below 350 lines. The Web
API may expose its existing `limit` option but does not change the daemon response. Do not expand `teammates.spec.ts`;
keep durable business assertions there and add a focused visual/state owner.

### 20.3 Focused Tests And Evidence

Create `ui2-teammate-management-tasks.spec.ts`. Cover navigation reachability, eight states, initial/empty/loaded,
retained refresh/stale/failure, exact 100-row boundary, active member-channel filtering, no-channel repair, one-click
trigger busy/success/failure, explicit create validation/failure, no auto-run, Run/Work Board routing, teammate-switch
race, zh-CN, long content, keyboard and reduced motion. Run Teammates private chat, Work Board, Settings embedded,
Profile/Model/Skills and Dark regressions.

Evidence directory: `evidence/features/ai-teammate-management-tasks/`. Minimum screenshots:

- `1440x960-ling-light-mixed-states.png`
- `1440x960-ling-dark-create-success-toast.png`
- `1280x800-ling-light-create-failure.png`
- `1280x800-ling-dark-no-active-channel.png`
- `1440x960-ling-dark-long-run-routing.png`

Exit requires one visible Tasks navigation entry, trigger-scoped busy, truthful recent boundary, no terminal, focused
CSS/legacy deletion, original-size evidence, SHA-256 metadata and all matrices reconciled.

### 20.4 Verified Closeout

- Production owners: `teammate-tasks-view-models.ts`, `useTeammateTasksController.ts`, `TeammateTasksTab.tsx` and
  `teammate-management-tasks.css`; `TeammateWorkspace.tsx` and `AppShell.tsx` remain thin adapters.
- The controller invalidates delayed initial/refresh responses on teammate switch and after create, so an older GET
  cannot replace a just-created task or cross identity. Global channel state is updated only when the created task
  belongs to the currently selected channel.
- `MessageActionBar` disables itself while loading, and each private message owns independent busy/error state.
- Focused `9/9`; Tasks + Teammates + Work Board + Council + Settings workspace-tools + Dark `49/49`; Web typecheck,
  i18n, lint, diff check and focused CSS/import scans passed.
- Six original-size screenshots, console/overflow checks and SHA-256 values are recorded in
  `evidence/features/ai-teammate-management-tasks/metadata.md`.
- `TEAMMATE-TASKS-001` is verified. Activity was subsequently closed by section 22; MCP, Memory, Channels and Danger
  remain independent slices.

## 21. P8.1j Permissions Truth Implementation Plan

### 21.1 Fixed Decisions And Boundary

User selected A/A on 2026-07-21: read-only capability truth plus Workspace-default runtime preview. Do not add teammate
permission editing, zero-tool selection, context picker, API/database changes or a false exact effective-policy claim.
Settings remains the only modification route.

### 21.2 Module Split

```text
TeammateWorkspace.tsx
  typed Permissions composition only
  -> teammate-permissions-view-models.ts
       pure ceiling/profile/risk/default-preview projection
  -> TeammatePermissionsTab.tsx
       -> TeammatePermissionCapabilityList.tsx
       -> TeammatePermissionPolicySummary.tsx

AppShell adapter
  current Workspace default policy snapshot + loading/error/refresh + Settings route

teammate-management-permissions.css
  Permissions geometry, truncation and bounded scroll only
```

No controller owns a draft or Save state. Reuse the current Core policy resolver/projection where possible; do not
reimplement deny/ask precedence in JSX. Keep every new production owner below 300 lines and shrink legacy CSS.

### 21.3 Focused States And Tests

Create `ui2-teammate-management-permissions.spec.ts`. Lock ordinary, managed Ling Agent, none/standard/strict,
none/low/medium/high/critical risk, one/many/legacy-empty tools, required tool/action details, Workspace deny precedence,
loading/stale/error/retry, teammate switch, Settings navigation, zh-CN, long content, keyboard and reduced motion.
Assert no editable checkbox/select/save, no raw `policy/enforced/none`, no claim that approval is bypassed and no
document overflow. Run Profile/Model/Skills/Settings authorization/workspace-tools/Dark regression.

Evidence directory: `evidence/features/ai-teammate-management-permissions/`. Minimum screenshots:

- `1440x960-ling-light-read-only-ceiling.png`
- `1280x800-ling-dark-strict-details-zh-CN.png`
- `1440x960-ling-dark-workspace-deny-preview.png`
- `1280x800-ling-light-protected-managed.png`
- `1280x800-ling-dark-policy-error-reduced-motion.png`

Exit requires shared UI-only rendering, one feedback owner, focused CSS/legacy deletion, complete screenshots and
matrix reconciliation. Code-only policy rows remain `implemented`, not `verified`.

### 21.4 Closeout Record

Status on 2026-07-21: **verified**.

- `teammate-permissions-view-models.ts` uses Core `resolveSessionRunPolicy()` and contains no React or API calls.
- `TeammatePermissionsTab.tsx` is read-only and uses shared primitives; no checkbox, Select, Save, direct Radix import
  or policy mutation survives.
- AppShell invokes the existing approval-policy refresh for the Teammates view and passes scoped loading/error/retry;
  the large workspace only composes typed props.
- focused `5/5`, selected `60/60`, Web static gates, six original-size screenshots and visual review passed.
- Evidence and hashes: `evidence/features/ai-teammate-management-permissions/metadata.md`.

## 22. P8.1k Recent Activity Implementation Plan（历史，设置页已撤销）

### 22.1 Fixed Decisions And Boundary

User selected A/A on 2026-07-21: register the Settings Activity Tab and call it bounded `Recent activity`; retain the
verified private Dock Activity unchanged. Reuse the existing 1-200 API and request 100 items. Do not add an audit event
store, pagination contract, completed-approval history or retention promise.

### 22.2 Module Split

```text
TeammateSettingsNavigation.tsx
  register Activity using the existing settings section model

TeammateWorkspace.tsx
  Activity composition only
  -> useTeammateActivityController.ts
       initial/background refresh, request identity, retained stale/error
       local query/type filter and reset on teammate switch
       -> teammate-activity-view-models.ts
            pure kind/title/status/time/action projection
  -> TeammateActivityTab.tsx
       compact toolbar + bounded DataRow list + optional folded source detail

apps/web/src/api/teammates.ts
  expose existing bounded limit argument only

teammate-management-activity.css
  Activity geometry, truncation and scroll only
```

Do not edit `teammate-private-dock.ts`, `TeammatePrivateChatDockPages.tsx` or its CSS except a proven regression fix.
Server English strings are treated as data hints and mapped to client product labels; unknown kinds remain neutral and
raw ids stay folded.

### 22.3 Focused States And Tests

Create `ui2-teammate-management-activity.spec.ts`. Cover the five source kinds and tones, initial/empty/loaded,
retained refresh/stale/failure/retry, search/all-five filters/no-result, descending order, exact 100-row boundary,
Run navigation, protected teammate, teammate-switch race, zh-CN, long values, keyboard and reduced motion. Add daemon
coverage for all five aggregation kinds and limit clamping without changing the response shape. Run private Dock,
teammates, Profile/Model/Skills, Settings workspace-tools and Dark regressions.

Evidence directory: `evidence/features/ai-teammate-management-activity/`. Minimum screenshots:

- `1440x960-ling-light-all-kinds.png`
- `1280x800-ling-dark-all-kinds-zh-CN.png`
- `1440x960-ling-dark-retained-error.png`
- `1280x800-ling-light-filter-no-result.png`
- `1440x960-ling-light-protected-100-row-scroll.png`

Exit requires a real Settings entry, no duplicate Dock owner, focused CSS/legacy deletion, original-size evidence,
console/overflow/keyboard assertions and full matrix reconciliation.

### 22.4 Verified Closeout

Status on 2026-07-22: **verified**.

- `teammate-activity-view-models.ts` owns pure kind/title/status/search projection; the controller owns request identity,
  retained stale/error and local filters; `TeammateActivityTab.tsx` owns shared-primitive composition only.
- focused `6/6`, selected Activity/Teammates/Council/Settings/Dark `51/51`, Web static gates and five original-size
  screenshots passed.
- Evidence and hashes: `evidence/features/ai-teammate-management-activity/metadata.md`.
- No daemon API, contract, database, retention model, private Dock Activity or task ownership changed.

## 23. P8.1l Danger Zone Implementation Plan

### 23.1 Fixed Boundary

Keep existing `disableAiTeammate` and `hardDeleteAiTeammate` behavior authoritative. Do not change API/contracts/Core/
DB/routes/Settings IA, cleanup counts, tombstone semantics, protected policy or historical channel/run references.
The UI owns only truthful lifecycle presentation, shared confirmation, scoped feedback, request identity and focus.

### 23.2 Module Split

```text
TeammateWorkspace.tsx
  typed composition only
  -> useTeammateDangerController.ts
       independent disable/delete busy and error
       Dialog/reason state, identity invalidation, callback settlement, focus fallback
       -> teammate-danger-view-models.ts
            pure protected/system/Ling Agent projection
  -> TeammateDangerTab.tsx
       shared Button/InlineFeedback/StatusIndicator composition
       -> TeammateHardDeleteDialog.tsx
            shared Dialog/Field/Input/Button/InlineFeedback

teammate-management-danger.css
  Danger geometry, wrapping and bounded scroll only
```

Production owners remain below 400 lines. The large Workspace loses prior delete state/function and contains only hook
creation plus props. Feature code imports through `shared/ui`, never Radix or package internals. Focused CSS is imported
by the focused Tab because the task write boundary excludes the global stylesheet manifest; legacy Danger selectors are
deleted from `teammates.css` in the same slice.

### 23.3 Interaction And Result Ownership

- Protected/system/Ling Agent gets the same discoverable Danger navigation but a read-only surface with zero controls.
- Disable and delete each have a single-flight ref plus independent state. Teammate identity change resets local draft,
  error, busy and Dialog while stale completions are ignored.
- Hard delete opens the shared Dialog. Cancel owns initial focus. Radix/shared overlay owns one-Esc/outside interaction;
  `busy` blocks every dismiss path. Close auto-focus returns to the trigger when it still exists.
- Existing AppShell/domain callback remains the only success owner. The controller waits a bounded 30 animation frames
  for the Settings teammate-management fallback or Workspace removal because current domain mutation callbacks swallow
  failures after setting global error. No target transition yields a local failure and keeps Reason/Dialog intact.
- Successful removal stabilizes focus on the visible teammate Search for six frames so Settings shell auto-focus cannot
  leave keyboard users on a stale trigger; an identity switch never invokes that fallback or steals focus.

### 23.4 Focused Tests And Evidence

`ui2-teammate-management-danger.spec.ts` covers:

1. ordinary shared controls and no browser dialog;
2. Cancel initial focus, one Esc close and trigger restore;
3. native Input border/shadow zero and focused shell/native height containment;
4. hard-delete busy dismissal protection, retained reason, failure, retry, exact payload and success removal;
5. post-removal Settings Search focus fallback;
6. disable-only busy/failure while Hard delete and Settings navigation remain available;
7. delayed disable result across teammate identity switch;
8. protected Ling Agent read-only surface with zero mutation requests;
9. Light `1440x960`, Dark `1280x800`, en/zh, reduced motion, long copy, console and root overflow.

Evidence directory: `evidence/features/ai-teammate-management-danger/`. Required original PNGs are default, focused
Dialog, delete failure, disable failure, delete success/fallback and protected read-only. Metadata records SHA-256,
branch/HEAD/dirty state, exact port/commands, visual review and honest packaged macOS/Windows status.

### 23.5 Verified Closeout

Status on 2026-07-22: **Web verified**.

- focused `5/5`; selected Dark/Profile/Settings and current Teammates behavior pass;
- the stale legacy hard-delete test was migrated by the integration owner to the shared Dialog/Reason contract;
  selected Teammates/Profile/Settings/Dark regression is `36/36` after the transient unrelated Council case passed its
  isolated serial rerun;
- Web typecheck, i18n, lint, target diff/selector checks and six original-size screenshots close the Web gate;
- packaged Electron macOS/Windows evidence is not available and is not claimed;
- no API, Core, DB, route, Settings IA, deletion cascade or retention behavior changed.
