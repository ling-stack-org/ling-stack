# Council Channels A Implementation Plan

## Scope

实现 [`08-Council-Channels-A.md`](08-Council-Channels-A.md) 的 `COUNCIL-CHANNELS-001`。本计划只迁移
Council Workspace 的 Channels Tab，不修改 API、contracts、Core、数据库、路由、AppShell、Settings IA、
Council List/Members/Create/Clone 行为、locale 或全局 UI2 状态文档。

## Baseline

- `CouncilWorkspacePage.tsx` 直接拥有 selected channel、policy GET/PUT、loading/saving/error 和三种 mutation。
- `CouncilWorkspacePanels.tsx` 内嵌原生 tabs、label/select/button 与 relationship row。
- 频道目录被截断为前 6 个非归档频道，archived 已有关系不可见。
- 所有 policy mutation 共用一个 saving/error，无法表达行内 busy/failure。
- effect cleanup 能阻止部分旧 GET，但没有 retained stale、同步 policy authority 或 mutation identity guard。
- `councils.css` 同时拥有 List/Members/Channels/Settings selector，Channels 没有 focused owner。

## Task Checklist

| Task | Owner | Dependency | Parallel | Verification | Status |
|---|---|---|---|---|---|
| CCHA-01 合同与 truth boundary | focused docs | Council A decision | yes | runtime provenance hard stop | completed |
| CCHA-02 pure view-model | new view-model | existing types | yes | exact payload assertions | completed |
| CCHA-03 controller | new hook | CCHA-02 | no | load/mutation identity race | completed |
| CCHA-04 UI2 panel | new component | CCHA-02/03 | no | shared primitive DOM/accessibility | completed |
| CCHA-05 Page/Panels extraction | two existing owners | CCHA-03/04 | no | Page/Panels net line reduction | completed |
| CCHA-06 focused CSS | new CSS + delete old selectors | CCHA-04 | yes | forbidden scan + overflow | completed |
| CCHA-07 focused E2E | new spec | CCHA-03/04 | no | 7 reachable-state scenarios | completed |
| CCHA-08 evidence/docs closeout | evidence folder + module docs | all tests | no | PNG/hash/metadata | completed |

## Implementation Boundaries

### Pure view-model

`council-channels-view-model.ts` owns:

- active/paused + archived channel catalog merge and ID dedupe;
- policy attached ID -> one relationship row projection;
- unavailable Council projection without raw ID display;
- paused/archived restriction keys;
- attach/prefer/detach exact full-policy payload derivation.

It must not import React、API、router、i18n context or CSS classes.

### Controller

`useCouncilChannelsController.ts` owns:

- archived catalog discovery with `limit=100` and independent failure boundary;
- stable channel selection repair;
- initial/refresh load, retained stale and raw server failure ownership;
- synchronous policy/busy refs plus React presentation state;
- `cwd::channelId` identity and monotonic GET sequence;
- per-Council busy/error plus serialized full-policy PUT queue;
- canceling stale GET writes when mutation begins;
- existing `onOpenChannel` adapter without changing navigation.

Controller 不持有 visual class，不产生 runtime projection，不创建 Feature timer。

### Presentation

`CouncilChannelsPanel.tsx` 只消费 controller：

- Header count + icon refresh；
- shared `Field/Select` channel selector；
- visible lifecycle `StatusIndicator` and truthful Open action；
- warning/danger `InlineFeedback`；
- attach selected Council surface；
- shared `DataRow/StatusIndicator/Button/IconButton` relationship rows；
- stable `Skeleton`、EmptyState 和 bounded list。

无需确认的 detach 不引入 Dialog。关系结果已经在 rows 中可见，不引入 success Toast。

### Composition

- `CouncilWorkspacePage.tsx` 删除全部 channel policy state/effect/mutation，仅实例化 controller 并传递一个 prop。
- `CouncilWorkspacePanels.tsx` 删除内嵌 `CouncilChannelPanel`，使用共享 Tabs 键盘壳并渲染 focused panel。
- 为 legacy dark selector 保留 `.council-detail-tabs` 兼容 class，但视觉 ownership 来自共享 Tabs。
- Members、List/Health、Create/Clone 和 Settings 的 props/callback 不改变。

### CSS

- `council-channels.css` 使用 `.council-channels-*` family，目标 `<300` 行。
- `councils.css` 通过 import 加载 focused owner，并删除旧 `.council-channel-*` selector。
- 不写硬编码颜色、`!important`、`transition: all`、Feature keyframe、raw duration/easing 或 package-private
  `.ling-ui-*` selector。
- Panel 为 flex column；list 是唯一 `overflow-y:auto` owner，设置 `scrollbar-gutter:stable` 和
  `overscroll-behavior:contain`。

## State Machine

```text
channel identity change
  -> clear old policy/error/busy
  -> initial GET
     -> loaded(authoritative policy)
     -> failed(no rows + Retry)

loaded
  -> refresh GET
     -> refreshed(replace authority)
     -> stale(retain rows, disable mutations, Retry)

loaded
  -> queued row mutation
     -> derive payload from latest ref
     -> PUT
        -> success(replace authority)
        -> failure(retain authority, row-scoped error)
```

## Focused E2E Scenarios

1. Empty policy -> attach selected custom Council，exact `[selected] + preferred=selected`。
2. Attach managed/builtin Council，不修改 Council 内容，source 可见。
3. Prefer/Detach exact full payload，row busy 不锁无关 row，direct teammate memberships 不变。
4. Open Channel 使用真实 Settings -> workspace navigation，message feed 可见。
5. paused/archived lifecycle：attach/prefer 禁用，detach 可用，archived Open 禁用，zh-CN/Dark/reduced motion。
6. native Select focus geometry 完全包含在 `.ling-ui-select` 外壳；Tabs ArrowLeft/ArrowRight。
7. initial policy failure -> no rows + Retry；refresh failure -> retained stale + disabled mutation。
8. prefer failure 只在 initiating Council row；Retry payload 与 authority 一致，无 optimistic state。
9. delayed old GET 不覆盖新 selection；delayed old PUT completion 不写入当前频道。
10. no channels 与 no attachments 是两个不同 empty state。
11. 100 attached Councils + long names：单一内部 scroll owner、ellipsis、无 root/panel horizontal overflow。
12. 页面无 Council runtime、task ownership、last run、success rate 或 execution order 文案。

## Verification Commands

```bash
LING_PLAYWRIGHT_PORT=4192 corepack pnpm --filter @ling-stack/web exec playwright test \
  e2e/ui2-council-channels.spec.ts

LING_PLAYWRIGHT_PORT=4192 corepack pnpm --filter @ling-stack/web exec playwright test \
  e2e/ui2-council-list-health.spec.ts \
  e2e/ui2-council-members.spec.ts \
  e2e/ui2-council-create-clone.spec.ts \
  e2e/councils.spec.ts \
  e2e/ui2-settings-workspace-tools.spec.ts \
  e2e/dark-mode.spec.ts

corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web lint
git diff --check -- <Council Channels touched paths>
```

额外 gate：

```bash
rg -n "#[0-9a-fA-F]{3,8}|!important|transition:\\s*all|@keyframes|\\.ling-ui-" \
  apps/web/src/styles/council-channels.css

rg -n "running|last run|success rate|execution order|runtime provenance|task ownership" \
  apps/web/src/features/councils/CouncilChannelsPanel.tsx \
  apps/web/src/features/councils/useCouncilChannelsController.ts \
  apps/web/src/features/councils/council-channels-view-model.ts
```

## Evidence Contract

目录：`docs/design/ui2.0升级/evidence/features/council-channels/`

1. `1440x960-ling-light-attached-managed-preferred.png`
2. `1280x800-ling-dark-archived-removal-only-zh-cn.png`
3. `1440x960-ling-dark-retained-policy-refresh-failure.png`
4. `1280x800-ling-dark-row-mutation-failure.png`
5. `1280x800-ling-light-no-channels.png`
6. `1440x960-ling-light-100-attached-councils.png`

metadata 必须记录真实 Vite URL、分支/dirty worktree、fixture、locale、theme、viewport/PNG、SHA-256、console、
root/panel overflow、list scroll、request payload、focus/keyboard/reduced motion 和 Desktop packaged exclusion。

## Exit Gate

- exact attach/prefer/detach payload 与现有 API 行为一致；没有 optimistic fake state。
- active/paused/archived/unavailable/managed relationship truth 可达且无伪启用 action。
- load、empty、stale、row failure、selection/mutation race 和 100-row layout 有自动化与截图证据。
- Page/Panels 净减少；新 production owners 全部 `<400`；focused CSS `<300` 且 forbidden scan 为零。
- focused、Council regressions、Settings/Dark 和静态 gate 全部通过。
- 只申请关闭 `COUNCIL-CHANNELS-001`；Runtime、完整 Settings/Archive 和 packaged Desktop 继续开放。

## Residual Risks

- Policy API 没有 revision/ETag；Controller 只能串行本窗口 mutation，无法阻止另一个客户端最后写入覆盖。
- Archived catalog discovery 与 active/paused AppShell 快照来自两个请求；短时间顺序变化由 ID repair 处理，但不是
  单一数据库 snapshot。
- policy error 使用 daemon 返回 message；本切片禁止改 locale，因此没有新增专属产品化错误 key。
- `Attached councils` 复用现有翻译作为行状态；若后续允许 locale slice，可新增 singular `Attached` 文案。

## Verified Closeout

- Focused capture and final main-agent rerun: `7/7` passed.
- Council List/Members/Create/Clone, legacy Council, Settings workspace-tools and Dark selected regression: `40/40`
  passed.
- Web typecheck, i18n, lint, touched-path diff, CSS forbidden scan and document-link checks passed.
- Six original-size screenshots were reviewed and current hashes were recorded in
  [Council Channels evidence](../evidence/features/council-channels/metadata.md).
- All `CCHA-01..08` tasks are complete. Web status is `verified`; packaged macOS/Windows and Council runtime provenance
  remain separate gates.
