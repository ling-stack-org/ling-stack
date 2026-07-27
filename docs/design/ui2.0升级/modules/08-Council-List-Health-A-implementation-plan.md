# Council List / Health A Implementation Plan

## Scope

实现 [`08-Council-List-Health-A.md`](08-Council-List-Health-A.md) 的 `COUNCIL-LIST-001`。
本计划只覆盖 Council 列表和 Health summary，不回写全局覆盖矩阵、README、migration 03-10、
`04-UI2.0后续升级执行方案.md` 或状态看板。

## Task Checklist

| Task | 内容 | 文件 / 模块 | 前置依赖 | 可并行 | 状态 | 验证 | 切片占比 |
|---|---|---|---|---|---|---|---:|
| P8.2a-D | 零决策合同与状态矩阵 | 本合同 + implementation plan | Council A | 否 | 已完成 | 文档 diff check | 8% |
| P8.2a-VM | 纯健康/列表投影 | `council-list-health-view-model.ts`、`lib/ai-councils.ts` | 合同 | 是 | 已完成 | focused pure browser assertions | 18% |
| P8.2a-C | Search/filter/selection/refresh controller | `useCouncilListHealthController.ts` | view-model contract | 否 | 已完成 | race/single-flight/stale E2E | 18% |
| P8.2a-UI | List 和 Health focused components | `CouncilListHealthPanel.tsx`、`CouncilHealthSummary.tsx` | VM/controller | 是 | 已完成 | primitive/ARIA/state E2E | 20% |
| P8.2a-W | Page/Panels 薄接线 | `CouncilWorkspacePage.tsx`、`CouncilWorkspacePanels.tsx` | controller/UI | 否 | 已完成 | Council + Create/Clone regression | 10% |
| P8.2a-CSS | CSS owner 迁移 | `council-list-health.css`、`councils.css`、`styles.css` | UI structure | 是 | 已完成 | selector/forbidden scan | 8% |
| P8.2a-T | i18n、mock、focused E2E | locales、mock、focused spec | implementation | 否 | 已完成 | focused 全绿 | 8% |
| P8.2a-E | Vite screenshots + metadata | evidence directory | all tests green | 否 | 已完成 | 5+ 原图、console/overflow/SHA | 10% |

本切片约占完整 UI 2.0 的 `1.6%`；上表比例是本切片内部权重。

## Module Boundaries

### Pure view-model

`council-list-health-view-model.ts`：

- 定义 `CouncilListHealthState`、`CouncilListRowView`、overview 和 filter option。
- 判断 report missing/stale/truncated/complete。
- 派生单一主状态、tone、finding count、partial reason。
- 搜索、过滤、排序只使用输入和已翻译 label，不持有 React state。

`apps/web/src/lib/ai-councils.ts` 只保留可跨 Council surface 复用的纯 label/projection helper；
不新增请求、缓存或业务状态。

### Controller

`useCouncilListHealthController.ts`：

- 拥有 query、filter、explicit selected ID、refresh busy/error/stale。
- 使用 request sequence 和 mounted guard，旧 refresh 不得覆盖新 state。
- Refresh single-flight；失败保留 rows；成功清除 error/stale。
- 接受 projected Council selection，清空 query/filter 并保持 Create/Clone authority flow。

### Focused components

`CouncilListHealthPanel.tsx` 只接收 view model 和 callback，使用共享 Input/Select/IconButton/DataRow/
InlineFeedback/EmptyState/Skeleton。

`CouncilHealthSummary.tsx` 只接收 selected row view 与现有 channel relationship projection，使用
StatusIndicator/InspectorSection。它不读取 API、不猜 runtime。

### Composition

- `CouncilWorkspacePage.tsx` 保留 Members/Channels/Settings domain orchestration，只接入 controller。
- `CouncilWorkspacePanels.tsx` 保留 Tabs 和既有 section；移除内联 List/Health JSX，接入 focused components。
- 两个文件不新增主要业务逻辑，目标是净减少或保持 orchestration。

## Implementation Order

1. 写 pure view-model 和类型，先固定状态优先级与 report completeness。
2. 写 focused spec fixture，覆盖 pending/partial/attention/healthy/paused 和 search/filter/selection。
3. 写 controller，覆盖 refresh single-flight、retained stale 和 unmount/identity guard。
4. 写 List/Health components 并接入 Page/Panels。
5. 迁移 CSS selector；从 `councils.css` 删除对应 owner。
6. 补中英文文案和最小 mock error/delay fixture。
7. 跑 static/focused；修复后跑指定回归。
8. 启动真实 Vite，采集截图、原尺寸目检、console/overflow 和 SHA metadata。
9. 独立检查未修改保护文件、无重复 owner、production owner `<400` 行。

## Focused E2E Scenarios

1. Initial loading：5 row Skeleton，toolbar geometry 稳定。
2. Empty：Create 可达；无 selected detail。
3. Search no-result：Clear filters 恢复显式选择。
4. Healthy/attention/paused：每行一个 StatusIndicator，无 “running”；critical/warning/info 仅过滤 finding。
5. Missing report：pending，不误报 healthy。
6. Truncated report：未命中 Council 显示 partial，不误报 healthy。
7. Stale report：`generatedAt < updatedAt` 显示 partial。
8. Refresh failure with rows：保留 rows/selection，persistent error + stale，Retry 清除。
9. Refresh single-flight：重复点击只有一个 refresh sequence，busy 只在 Refresh。
10. Long list / zh-CN / 1280：内部滚动，identity ellipsis，无 document 横向 overflow。
11. Dark / reduced motion：token 色，shared disclosure，无 Feature animation。
12. Create/Clone authority：focused regression 保持 detail projection/source drift 行为。

## CSS Gate

```text
new focused CSS color literals              0
new focused CSS !important                  0
new focused CSS transition: all             0
new focused CSS @keyframes                  0
new focused CSS raw duration/easing         0
new focused CSS package-private selectors   0
old List/Health selector duplicate owners   0
councils.css line delta                      < 0
```

## Verification Commands

```bash
git diff --check
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web exec playwright test e2e/ui2-council-list-health.spec.ts
corepack pnpm --filter @ling-stack/web exec playwright test e2e/councils.spec.ts
corepack pnpm --filter @ling-stack/web exec playwright test e2e/ui2-council-create-clone.spec.ts
corepack pnpm --filter @ling-stack/web exec playwright test e2e/ui2-settings-workspace-tools.spec.ts
corepack pnpm --filter @ling-stack/web exec playwright test e2e/dark-mode.spec.ts
```

## Evidence Contract

目录：`docs/design/ui2.0升级/evidence/features/council-list-health/`

最少截图：

1. `1440x960-ling-light-healthy-attention.png`
2. `1440x960-ling-dark-partial-health.png`
3. `1280x800-ling-light-long-zh-cn.png`
4. `1280x800-ling-dark-refresh-stale.png`
5. `1280x800-ling-dark-no-result.png`

`metadata.md` 必须记录 source server URL、commit/worktree note、locale、Theme、fixture、viewport、PNG
实际尺寸、SHA-256、console errors、page/document overflow、list scroll boundary、reduced-motion（如适用）和
保护边界复核。

## Exit Gate

- 所有状态只陈述配置/readiness/channel relationship；页面不存在 runtime provenance 文案。
- pending/partial 不误报 healthy；report truncation 有自动化断言。
- Search、filter、Refresh、selection、empty/no-result/stale/error 全部可达。
- shared primitive 使用符合合同；List/Health 内无原生按钮、旧 SelectControl 或直接 Radix。
- Create/Clone、Members、Channels、Settings 指定回归通过。
- focused CSS 和旧 CSS owner 无重复；`councils.css` 净减少。
- 5+ 张真实 Vite 原图通过 console/overflow/SHA 验收。
- focused worker 不直接回写全局总控、覆盖矩阵、README、migration 03-10 或状态看板；verified gate 由主
  集成 owner 统一回写，避免并行覆盖。

## Verified Closeout

Status on 2026-07-22: **verified**. Focused `6/6`, Council legacy `2/2`, Create/Clone `7/7`, selected integration
`51/51`, Web static gates and five original-size screenshots passed. Original-size review found and fixed oversized
refresh feedback plus collapsed narrow-column actions; focused bounds now prevent both regressions. Evidence and
SHA-256: `evidence/features/council-list-health/metadata.md`.
