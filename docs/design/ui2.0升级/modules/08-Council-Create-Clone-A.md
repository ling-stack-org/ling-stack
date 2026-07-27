# Council Create / Clone A Contract

## Scope

本切片只完善 `COUNCIL-CREATE-001` 与 `COUNCIL-SETTINGS-001` 中的 Create / Clone。
Council A 只展示现有配置和可由成员状态确定的 readiness，不扩展运行时事实。

Create 使用现有 `CreateAiCouncilRequest`，一次提交名称、描述、routing mode 与已选 AI 队友。
Clone 使用现有 clone API，一次提交名称、描述和 pinned，并由服务端原子复制源 Council 的成员与
routing policy。

## Product Truth

- Create 可选择所有当前可用、非隐藏、非 Ling Agent 的 AI 队友。
- 零成员不是阻塞错误，但第一次提交只显示 readiness 警告；用户必须再次明确提交。
- Create 成功后的 Council 为 `user`、`active`，pinned 采用现有请求默认值。
- Clone 审阅页明确显示成员和 routing 会复制，新对象为 `user`、`active`，pinned 可在现有 API
  范围内修改。
- Clone 不复制频道接入；新对象需后续单独接入频道。
- Clone API 不接受成员覆盖，因此审阅页的成员摘要只读，不做 clone 后二次写入。
- Clone 提交前必须通过现有 Council detail 和 members API 重读源配置。成员或 routing 变化时更新审阅、
  保留用户草稿并要求再次确认；第一次确认不发送 clone POST。
- POST 成功与列表刷新是两个事实：POST 成功显示 Toast；客户端通过现有 `GET /ai-councils/:id` 权威
  确认新对象，不依赖最多 100 项的列表是否包含该 id。
- 列表/详情读取失败保留权威旧列表并显示 stale/repair 状态，不把未经 GET 确认的 POST 响应直接插入
  列表。权威 detail 可作为临时选择投影，正常列表接管后立即释放。

## Reachable States

| Surface | States |
|---|---|
| Create | editing, zero-member confirmation, submitting, failed, succeeded |
| Clone | reviewing, source-changed, reconfirming, submitting, failed, succeeded |
| Projection | refreshing, checking-by-id, projected, over-100-list, stale, repairing |

Create / Clone 提交中，关闭按钮、Cancel、Escape 和外部点击全部不可关闭；同一提交使用同步 ref
single-flight guard。失败留在原 Dialog，保留全部草稿并允许重试。

## Module Boundaries

- `council-create-clone-view-model.ts`：资格过滤、初始草稿、payload 与只读摘要投影。
- `useCouncilCreateCloneController.ts`：Dialog 状态、single-flight、API、Toast、刷新确认和 repair。
- `CouncilCreateDialog.tsx`：Create 表单、成员多选、routing、readiness 与错误/进度。
- `CouncilCloneDialog.tsx`：可编辑字段与成员/routing/频道复制语义审阅。
- `CouncilMutationProjectionStatus.tsx`：stale/repair 的持久反馈。
- `council-create-clone.css`：本切片布局；不向 `councils.css` 添加规则。
- `CouncilWorkspacePage.tsx` / `CouncilWorkspacePanels.tsx`：只保留触发、选择与展示接线。

所有新增 production owner 必须少于 400 行。

## Hard Stops

- 不新增 `sourceCouncilId`、provenance、聚合 API、数据库字段或 migration。
- 不承诺 Council 已运行、模型/provider/skill 可运行、运行来源或跨频道聚合使用情况。
- 不修改 Members、Channels、Settings、Archive 的业务语义。
- 不修改 AI Teammate、Permissions、Tasks、总覆盖矩阵或 UI2 总控文档。
- 不用 clone + replace members 等两步写入制造部分成功。

## Verified Closeout

`COUNCIL-CREATE-001` reached `verified` on 2026-07-21. Create/Clone focused `7/7`, Council + Settings workspace-tools
integration `16/16`, selected Tasks/Teammates/Work Board/Council/Dark `49/49`, Web static gates and two original-size
screenshots passed. Evidence is in `evidence/features/council-create-clone/metadata.md`.

This does not close the whole `COUNCIL-SETTINGS-001`: settings draft/save races, Archive/Restore and policy-cache
invalidation remain separate Council A work. `COUNCIL-RUNTIME-001` remains blocked by absent provenance. The existing
clone API also has no revision/conditional-submit field, so a final GET-to-POST race remains an explicit residual risk.
