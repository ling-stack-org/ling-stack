# Council Create / Clone A Implementation Plan

## Baseline

- `CouncilWorkspacePage.tsx`：584 行，拥有 Create / Clone 草稿、错误、busy 和 API 调用。
- `CouncilWorkspacePanels.tsx`：698 行，内嵌 Create Dialog，Clone 为即时动作。
- `councils.css`：859 行，禁止扩张；`.council-create-inline*` 已无生产消费者。
- `refreshAiCouncils` 会保留错误但吞掉 rejection，因此 mutation owner 必须从父级列表是否出现新 id
  判断投影是否完成。

## Vertical Slices

1. Create focused E2E：真实成员/routing payload、零成员二次确认、双击单 POST、busy 不可关闭、
   失败保留草稿并重试。
2. Create implementation：纯 payload view-model、Dialog、controller、Toast 与列表投影确认。
3. Clone focused E2E：审阅语义、名称/描述/pinned payload、成员/routing 原子复制、频道不复制、
   busy/失败重试。
4. Clone implementation：只读源摘要和现有 clone API 单次提交。
5. Projection failure E2E：POST 成功但 list refresh 失败时不出现伪列表项，显示 stale 与 repair；
   repair 后真实选择目标。
6. Visual/accessibility：Light 1440x960、Dark 1280x800、zh-CN/en-US、Esc、focus restore、
   overflow 和 console。
7. Paged-list authority：创建对象被前 100 条 pinned/name 排序截断时，用现有 detail GET 权威确认并选择；
   正常列表出现后释放临时投影。
8. Clone source drift：提交前重读 Council + Members；成员/routing 变化时更新 review、保留草稿并要求二次
   确认，第一次不得发 POST。

## Mock Boundary

只在 `MockState` 增加 Council create/clone delay、下一次 create/clone failure、下一次 council list
failure。请求次数和 payload 由 Playwright 的公开 request 事件观测，不增加全局统计 fixture。

## Verification

```text
git diff --check -- <touched paths>
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web exec playwright test e2e/ui2-council-create-clone.spec.ts
corepack pnpm --filter @ling-stack/web exec playwright test e2e/councils.spec.ts
corepack pnpm --filter @ling-stack/web exec playwright test e2e/ui2-settings-workspace-tools.spec.ts
```

Evidence 写入 `docs/design/ui2.0升级/evidence/features/council-create-clone/`，metadata 记录 viewport、
Theme、locale、fixture、console、overflow、focus、截图尺寸和 SHA-256。

## Exit Gate

- Create / Clone 均为同步 single-flight，busy 时无关闭路径。
- 失败 Dialog 与草稿保留，重试成功。
- Create payload 含真实成员与 routing；Clone 只发送 API 支持字段。
- 成功 Toast 与 stale/repair 状态均可达，且列表不伪造新对象。
- 新 production owner 均少于 400 行，Page/Panels 净移除主要 Create / Clone 状态。
- focused 与指定回归、静态检查和双主题实页证据全部通过。

## Verified Closeout

- Create/Clone state moved into 346-line controller, focused Dialogs/view-model and focused CSS; Page/Panels only
  compose triggers, projection status and selected Council.
- Focused `7/7`; Council + Settings workspace-tools `16/16`; selected integration `49/49`; typecheck, i18n, UI2 lint
  and diff check passed.
- Existing API/client/contracts/database were unchanged. The mock now models list `limit=100`, list sort, detail
  failure and source drift only for deterministic browser verification.
- Two screenshots and SHA-256 metadata remain in `evidence/features/council-create-clone/`.
- `COUNCIL-CREATE-001` is verified. Members was subsequently closed by Council Members A; full
  `COUNCIL-SETTINGS-001`, Channels, Archive/Restore and runtime
  provenance remain open.
