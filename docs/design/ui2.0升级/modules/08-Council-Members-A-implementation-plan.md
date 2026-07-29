# Council Members A Implementation Plan

## Scope

实现 [`08-Council-Members-A.md`](08-Council-Members-A.md) 的 `COUNCIL-MEMBERS-001`。本计划只迁移
Members Tab，不修改 API、contracts、Core、数据库、Council Channels、完整 Settings、Archive/Restore、
UI2 总控、覆盖矩阵或状态看板。

`COUNCIL-RUNTIME-001` 在整个实施过程中继续保持 blocker。任何测试、文案、fixture 或截图都不能制造
Council runtime provenance。

## Current Baseline

- `CouncilWorkspacePage.tsx`：约 `538` 行，直接拥有 members load/save/error、candidate、add/remove/toggle/move。
- `CouncilWorkspacePanels.tsx`：约 `520` 行，内嵌 `CouncilMembersPanel` 和旧按钮/Select/row JSX。
- `councils.css`：约 `433` 行，仍拥有 `.council-member-*` selector family。
- `councils.spec.ts`：约 `280` 行，把 Members、Channels、Settings、Create/Clone 放在一个长 happy path。
- `GET /ai-councils/:id/members` 和 `PUT /ai-councils/:id/members` 已存在；PUT 是无 revision 的整组原子替换。
- `AiCouncilHealthReport` 已包含 member findings，但 report 可能 missing、stale 或 truncated。
- 当前 UI 允许修改 built-in Council；store bootstrap 会补回缺失的 Development Council 基线成员，目标 UI
  必须改为 managed Council read-only，避免“移除成功”在重启后反转。

## Task Checklist

| Task | 内容 | 目标文件 / 模块 | 前置 | 状态 | 验证 | 切片占比 |
|---|---|---|---|---|---|---:|
| P8.2b-D | 零决策合同与 implementation plan | 本文档 + contract + Workspace links | Council Members A | 已完成 | 文档检查 | 8% |
| P8.2b-VM | 纯 candidate/fingerprint/readiness/intent 投影 | `council-members-view-model.ts` | contract | 已完成 | focused view assertions | 16% |
| P8.2b-C | load/preflight/PUT/health controller | `useCouncilMembersController.ts` | VM | 已完成 | race/conflict/single-flight E2E | 20% |
| P8.2b-UI | Members panel、row、remove dialog | focused components | VM/controller | 已完成 | primitive/ARIA/state E2E | 18% |
| P8.2b-W | Page/Panels 薄接线和旧逻辑删除 | existing Page/Panels | controller/UI | 已完成 | line budget + regression | 8% |
| P8.2b-CSS | focused owner 和旧 selector 清理 | `council-members.css`、`councils.css` | UI | 已完成 | selector/forbidden scan | 8% |
| P8.2b-T | i18n、focused route overlay、focused E2E | locale integration + focused spec | implementation | 已完成 | focused 9/9；共享 i18n 与旧回归已更新 | 10% |
| P8.2b-E | 真实 Vite、截图和 metadata | evidence directory | focused green | 已完成 | 6 张原图、console/overflow/SHA | 12% |

本切片约占完整 UI 2.0 的 `1.8%`；上表比例只表示 Council Members A 内部工作量。

## Module Boundaries

### Pure view-model

`apps/web/src/features/councils/council-members-view-model.ts`，目标 `<260` 行：

- `CouncilMemberFingerprint`：稳定序列化 member identity/config，不含 timestamp。
- `CouncilMemberIntent`：`add / toggle / move / remove` discriminated union。
- `CouncilMemberReadinessState`、`CouncilMemberRowView`、panel summary 和 candidate option。
- candidate 过滤：排除已有、hidden、disabled、Ling Agent/system teammate；paused 保留并标注。
- report completeness：workspace、valid time、Council/member timestamp、finding truncation、post-mutation pending。
- matching finding 优先级、tone、产品化 label；不把 raw `title/message` 直接传到默认层。
- `applyCouncilMemberIntent` 返回完整连续 position payload，并保留已有 `slotKey/label`。
- 所有函数只接收值和 `Translate`，不持有 React state、不调用 API、不读取 locale 文件做判断。

必须为 fingerprint、candidate、managed source、empty member mutation、partial report、paused Council、明确 finding
和连续 position 写独立测试断言。

### Controller

`apps/web/src/features/councils/useCouncilMembersController.ts`，目标 `<360` 行：

- 输入：`cwd`、selected Council、health report、teammates、`onRefreshCouncilHealth`、`t`。
- 输出：authoritative members、rows、summary、candidate selection、loading/busy/error/conflict/stale、remove target 和 callbacks。
- Council identity 改变时递增 request sequence，关闭旧 Dialog，清空旧 rows/selection/error 后加载新成员。
- 同一 Council refresh 保留权威 rows；失败标 stale 并禁止 mutation，避免用旧整组覆盖服务器。
- mutation 统一走 synchronous ref single-flight：preflight GET -> fingerprint compare -> intent -> PUT -> response -> health refresh。
- fingerprint drift 时不自动 rebase、不 PUT；采用最新 GET 结果并要求用户重新确认。
- PUT 成功后设置 `postMutationHealthBaseline`；只有后续新 `generatedAt` 才清除 readiness pending。
- PUT 成功、Health refresh 失败时保留成员结果；只显示 readiness stale repair。
- 所有 async completion 检查 mounted、Council ID 和 request sequence；旧 Council 结果只能被丢弃。
- 不创建 Toast timer，不调用 global alert，不在 controller 内维护视觉 class。

### Focused components

`CouncilMembersPanel.tsx`，目标 `<260` 行：

- 只消费 controller view model/callback；不 import API、Health raw enum 或 Council store helper。
- 使用共享 `Select`、`Button`、`DataRow`、`StatusIndicator`、`InlineFeedback`、`EmptyState`、`Skeleton`。
- 固定 summary、feedback、Add row 和 bounded list 的滚动所有权。
- managed Council 显示只读状态和 `Clone to customize`，不渲染 mutation controls。

`CouncilMemberRow.tsx`，目标 `<180` 行：

- 只渲染 avatar/identity、一个 readiness、`IconButton`、`Switch` 和 Remove trigger。
- 不从 teammate/raw finding 临时推断状态；不使用原生 button 或旧 `.compact-*` control class。

`CouncilMemberRemoveDialog.tsx`，目标 `<160` 行：

- 使用共享 Dialog，包含 channel projection 影响、direct membership 不变和 last-enabled warning。
- busy 时所有关闭路径锁定；失败保留 Dialog；关闭恢复 trigger focus。

### Composition

- `CouncilWorkspacePage.tsx` 删除 members state/effect/save/add/remove/toggle/move 和 payload helper，只实例化
  `useCouncilMembersController` 并向 Panels 传一个 focused controller boundary。
- `CouncilWorkspacePanels.tsx` 删除内联 `CouncilMembersPanel`，只在 Members Tab composition 中渲染新组件。
- 两个文件都必须净减少；不得在它们内部新增 preflight、fingerprint、readiness 或 Dialog state。
- `useCouncilListHealthController` 保持 List/Health owner；只把现有 `refresh` callback 提供给 Members controller。
- Create/Clone controller、authority projection 和 source-drift 行为保持原样。

### CSS owner

- 新增 `apps/web/src/styles/council-members.css`，目标 `<300` 行。
- `apps/web/src/styles.css` 在 List/Health 与 general Council CSS 的稳定层级加载 focused owner。
- 从 `councils.css` 删除 `.council-member-*`、Members panel 专属 status/action selector；通用 Tabs/Channels/Settings 保留。
- 不命中 package-private `.ling-ui-*` 子结构，不复制共享 Button/Switch/Dialog/StatusIndicator 视觉。

## Mutation State Machine

```text
idle
  -> preflight(member intent)
    -> conflict(latest members, no PUT)
    -> saving(one full PUT)
      -> saved(authoritative response)
        -> readiness-pending
          -> ready(new Health generation)
          -> readiness-stale(refresh failed)
      -> failed(old authoritative members retained)
```

Rules:

1. `membersLoading`、`membersStale`、managed source 或任一 mutation flight 时禁止新 mutation。
2. Preflight GET 与 loaded fingerprint 不同：更新 rows、显示 conflict，不发送 PUT。
3. Add target 已存在或 Remove target 已不存在：采用最新 rows，结束 intent，不发送 PUT。
4. Toggle/Move target 不存在：采用最新 rows并要求重试，不按旧 index 操作。
5. PUT payload 始终发送完整数组，positions 归一化为 `0..n-1`。
6. PUT response 是成员配置最终 authority；Health refresh 不是 PUT 成功的判据。
7. API 无 conditional field，GET-to-PUT race 写入 residual risk；本切片不伪造冲突已被彻底解决。

## Implementation Order

1. 写 focused spec 的 request/state fixture，先固定 managed read-only、payload 和 readiness truth。
2. 写 pure view-model，覆盖 fingerprint、intent 和 report completeness。
3. 写 controller，先完成 Council identity/load guard，再完成 preflight/single-flight/Health pending。
4. 写 Members panel、row 和 Remove Dialog；接入 shared primitives。
5. 从 Page/Panels 删除旧 member owner并完成薄接线。
6. 迁移 selector 到 focused CSS，删除 `councils.css` 重复 owner。
7. 补中英文 copy、Tooltip、ARIA 和最小 deterministic mock hooks。
8. 跑 static/focused；修复后跑 Council、Settings workspace tool、Create/Clone、List/Health、Dark regression。
9. 启动真实 Vite，采集六张以上截图，检查原图、console、overflow、focus、scroll 和 reduced motion。
10. 最后复核只关闭 `COUNCIL-MEMBERS-001`；runtime、channels 和完整 settings 仍保持原状态。

## Focused E2E Scenarios

1. Initial load：四行稳定 Skeleton；跨 Council 切换不泄漏上一 Council rows。
2. Custom ready：完整 Health report 下每行一个状态，summary 数量准确，无 runtime 文案。
3. Managed source：builtin/template 无 Add/Switch/Move/Remove，`Clone to customize` 可打开既有 Clone Dialog。
4. Add candidate：排除已有、hidden、disabled、Ling Agent；paused 候选可见且标注；payload 追加末尾并不写本地化 label。
5. No candidate：compact empty + Manage teammates；现有 member actions 不受影响。
6. Add failure：选择保留、旧 rows 不变、persistent error；Retry 只产生一个 PUT。
7. Toggle：Switch single-flight；disable 后保留成员/位置；enable 不把 blocked teammate 误报 Ready。
8. Reorder：first/last control disabled；一次 PUT，连续 position；页面无 priority/execution-order copy。
9. Remove cancel：Dialog impact copy 可读，Cancel/Esc 不发送 PUT并恢复焦点。
10. Remove confirm：busy 时不可关闭、双击 single PUT；成员消失但 direct channel membership fixture 不变。
11. Last enabled remove：确认中出现强化警告；成功后 empty/no-enabled readiness 不误报正常。
12. Load error no rows：persistent Retry，mutation disabled。
13. Refresh error with rows：保留 rows、stale/read-only；Retry 成功恢复 mutation。
14. Preflight drift：外部 add/toggle/reorder 后本次 intent 不 PUT，最新 rows 显示并要求复核。
15. Selection race：旧 Council GET/PUT completion 不写入新 Council。
16. Health pending：PUT 成功后旧 report 不可显示 Ready；新 generation 到达后才更新。
17. Health refresh failure：成员保存保持成功，readiness stale 可单独 Retry。
18. Missing/stale/truncated report：无 finding 的成员保持 pending；已返回明确 finding 仍显示阻塞。
19. Paused Council：panel 说明不参与频道，健康成员显示 Ready after resume。
20. Long zh-CN / 1280：内部滚动、identity ellipsis、actions 不折行、无 document horizontal overflow。
21. Dark / keyboard / reduced motion：token 色、完整 focus、Tooltip/ARIA、无 Feature animation。
22. Regression：Create/Clone source drift、List/Health partial 防误报、Settings embedded shell 均不回退。

## Mock And Test Boundary

- 不继续向约 `15k` 行的 `mock-daemon.ts` 堆叠完整 Members 状态机。
- 允许在 focused spec/support 中增加小型 route overlay，控制 members GET/PUT delay、next failure、Health generation、
  external drift 和 request capture；通用 handler 只接最薄的 fixture hook。
- 不增加 production API 或测试专用 contract 字段。
- request 次数、method、Council ID 和完整 payload 通过 Playwright request/route 观测。
- legacy `councils.spec.ts` 的成员 mutation fixture 改用 custom Council；built-in 修改断言替换为只读 + Clone，
  Channels、Settings、Create/Clone 既有断言保持独立。

## CSS Gate

```text
new focused CSS color literals              0
new focused CSS !important                  0
new focused CSS transition: all             0
new focused CSS @keyframes                  0
new focused CSS raw duration/easing         0
new focused CSS package-private selectors   0
old Members selector duplicate owners       0
councils.css line delta                      < 0
CouncilWorkspacePage.tsx line delta          < 0
CouncilWorkspacePanels.tsx line delta        < 0
new production owner line count              < 400
```

## Verification Commands

```bash
git diff --check -- <touched paths>
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web exec playwright test e2e/ui2-council-members.spec.ts
corepack pnpm --filter @ling-stack/web exec playwright test e2e/councils.spec.ts
corepack pnpm --filter @ling-stack/web exec playwright test e2e/ui2-council-list-health.spec.ts
corepack pnpm --filter @ling-stack/web exec playwright test e2e/ui2-council-create-clone.spec.ts
corepack pnpm --filter @ling-stack/web exec playwright test e2e/ui2-settings-workspace-tools.spec.ts
corepack pnpm --filter @ling-stack/web exec playwright test e2e/dark-mode.spec.ts
```

额外静态扫描：

```bash
rg -n "running|last run|success rate|execution order|runtime provenance" \
  apps/web/src/features/councils apps/web/src/i18n/locales apps/web/e2e/ui2-council-members.spec.ts
rg -n "#[0-9a-fA-F]{3,8}|!important|transition:\\s*all|@keyframes|\\.ling-ui-" \
  apps/web/src/styles/council-members.css
```

命中必须逐项确认；产品文案中的命中一律删除，测试中的禁止断言可保留。

## Evidence Contract

目录：`docs/design/ui2.0升级/evidence/features/council-members/`

最少截图：

1. `1440x960-ling-light-custom-ready-mixed.png`
2. `1440x960-ling-dark-managed-read-only.png`
3. `1440x960-ling-dark-remove-confirm.png`
4. `1280x800-ling-light-empty-no-candidates-zh-cn.png`
5. `1280x800-ling-dark-readiness-partial.png`
6. `1280x800-ling-dark-save-conflict-stale.png`

`metadata.md` 必须记录 source server URL、branch/worktree dirty note、locale、Theme、fixture、viewport、PNG
实际尺寸、SHA-256、console errors/warnings、document/root overflow、Members list scroll owner、focus return、
keyboard、reduced-motion、request count/payload 和 runtime-provenance 禁止项审查结果。

截图必须来自真实 Vite source server，不接受组件 story、静态 HTML、旧截图或仅测试断言。每张原图都要目检
成员 identity、状态、actions、反馈和父级 Council header 是否重叠。

## Exit Gate

- Add/Remove/Enable/Disable/Reorder 全部走真实 GET preflight + 单一完整 PUT，响应为 authority。
- managed Council 只读且 Clone 可达；页面不再承诺内置基线成员可永久移除。
- readiness 对 missing/stale/truncated/post-mutation report 不误报 Ready。
- PUT 成功与 Health refresh 成功被拆成两个事实；后者失败不回滚成员配置。
- conflict、identity race、single-flight、Dialog close lock 和 focus return 有自动化证据。
- Page/Panels 净减少，所有新 production owner `<400` 行，旧 CSS owner 无重复。
- focused、指定回归、静态门槛和六张真实原图全部通过。
- 证据通过后只能申请将 `COUNCIL-MEMBERS-001` 标为 verified；不得连带关闭 Channels、完整 Settings 或 Runtime。
- focused implementation worker 不回写 UI2 总控、覆盖矩阵、状态看板或其他模块文档；集成 owner 统一处理。

## Residual Risks

- API 无 revision/conditional PUT，preflight 后到 PUT 前仍可能发生最后写入覆盖；没有 API 变更前只能记录，
  不能宣称完全解决。
- Health report 可能因 workspace findings 超过 limit 而 partial；此时 Members surface 必须保持 pending/partial。
- managed Council read-only 是产品层保护，API 仍允许成员 PUT；本切片不把 UI 保护描述成服务端授权边界。
- Council member order 当前只影响存储与 projection 枚举顺序，不证明 runtime scheduler 会按该顺序执行。

## Implementation Result

当前状态：`verified`（2026-07-22）。

- Focused E2E：`9/9`；同一次证据运行采集六张原尺寸 PNG。
- Council List/Health：`6/6`；Create/Clone：`7/7`。
- Web typecheck、i18n、UI2 lint、touched-path whitespace 与 focused CSS gate 通过。
- 证据与 SHA-256：[`../evidence/features/council-members/metadata.md`](../evidence/features/council-members/metadata.md)。
- 旧 `councils.spec.ts` 已把成员 mutation fixture 改为 custom Council；builtin 断言改为只读 + Clone。
- Settings workspace-tools 通过 Settings 导航进入队友管理，不再要求 managed Members 面板伪造 `Manage teammates`。
- Focused `9/9`、List/Health `6/6`、Create/Clone `7/7`、legacy Council `2/2` 和 Settings workspace-tools
  `7/7` 通过。共享 Dialog 关闭图标不再创建会抢占第一次 Esc 的 Tooltip，确认框单 Esc 与 busy lock 均通过。
- `COUNCIL-RUNTIME-001` 未关闭，API 无 conditional PUT 的最后写入残余竞态仍保留。
