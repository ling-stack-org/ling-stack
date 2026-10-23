# 工作摘要

Status: current implementation reference
Owner: Web and Daemon maintainers
Last verified: 2026-10-23
Document type: feature reference
Code anchors: `packages/contracts/src/work-summary.ts`, `packages/daemon/src/features/work-summary/`, `apps/web/src/features/workspace/work-summary/`
Test anchors: `packages/daemon/test/work-summary.test.mjs`, `packages/daemon/test/work-summary-routes.test.mjs`, `apps/web/e2e/work-summary.spec.ts`

在频道、普通对话和 AI 队友私聊顶部点击现有“摘要”按钮，打开右侧工作摘要。环境信息、分支和原有操作入口保留在同一面板中，不再增加第二个汇总按钮。

摘要列出当前项目已知会话、关联工作目录的净变更、最近三次提交，以及手动关联的 GitHub PR。多个会话共享同一 Git worktree 时，变更只统计一次；不同 worktree 分别展示。点击变更行，在当前会话的右侧审查抽屉打开对应目录的 diff；不会弹出独立对话框或离开会话页面。

## 数据与边界

- `GET /workspace/work-summary?cwd=...` 读取当前已打开项目的摘要，返回 `WorkSummaryResponse`；项目尚未加载时返回 404。
- PR 关联使用 `POST /workspace/work-summary/pull-requests?cwd=...`，JSON body 为 `{ "url": "https://github.com/owner/repo/pull/123" }`；解绑使用同一路径的 `DELETE`，并在查询参数中传入 `cwd` 和 `url`。
- 变更按 HEAD 到最终工作目录内容计算，包含有界读取的未跟踪文本。暂存后又反向修改为 HEAD 内容的文件会抵消。二进制单独计数，不虚构增删行数。
- 单次最多读取 500 条线程、500 个频道、500 个私聊 owner 和 20 个不同来源路径。超限有提示。未跟踪文件最多读取 200 个，每个最多 1 MiB，总计最多 8 MiB；不完整的统计显示为未知，不能视为零。
- Git 摘要缓存 10 秒，PR 状态缓存 30 秒；面板打开且页面可见时每 15 秒刷新。控制面变更合并刷新。关闭面板停止轮询，刷新失败保留上次数据及更新时间。
- 仅使用当前项目已知绑定、run 路径和工作目录；不扫描机器上的其他仓库。API 沿用本地 Origin 与受信工作区校验，读取摘要不会初始化其他项目 store。
- 变更详情调用 `GET /workspace/changes?cwd=...&baseline=head`，沿用既有审查抽屉的有界预览；超过预览限制时显示截断。不传 `baseline` 的入口仍使用原有暂存区与工作目录比较方式。

## GitHub PR

每个项目最多关联 30 个 PR，只接受 `https://github.com/owner/repo/pull/number`。关联保存在项目 SQLite store，可解绑并跨重启保留。它不会创建、合并或修改 GitHub PR。

daemon 通过现有 SecretResolver 读取 `GITHUB_TOKEN` 或 `GH_TOKEN`。未配置时不请求 GitHub，仍保留可打开的 PR 链接，并显示未连接。配置后读取 draft/open/merged/closed 与当前 head SHA 的 CI 状态；缺失、分页未取全或失败不能显示为成功。

## 模块职责

- `packages/contracts/src/work-summary.ts` 定义传输契约；API client 封装读取、PR 关联和净变更详情请求。
- `packages/core/src/storage/sqlite/work-summary-store.ts` 保存 PR 关联，migration 175 建表。
- `packages/daemon/src/features/work-summary/` 分开路由、聚合、Git、GitHub 和有界缓存。
- `apps/web/src/features/workspace/work-summary/` 分开共享导航上下文、面板、分组、变更、提交、PR 行及刷新状态。三个会话页面保留各自抽屉控制器。
- `WorkspaceClientView.tsx` 保留频道编排，类型、环境加载、面板导航、标题区域和弹层组合分别抽到相邻模块。

## 验证范围

自动化覆盖真实临时 Git 仓库的净抵消、特殊路径、无 HEAD、二进制和读取限制，以及 SQLite 关联持久化、HTTP 权限边界、PR 当前 SHA 判定。浏览器测试覆盖三种会话入口、共享统计、懒加载抽屉、PR 关联与解绑、刷新失败和窄窗口。GitHub 响应测试使用 fixture，不代表真实账号权限验证。

本次新增专用文案提供英文与简体中文，其余语言缺失译文的条目使用英文回退，已有译文继续使用。
