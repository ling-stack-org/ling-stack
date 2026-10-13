# H09 可见 QA 与固定人工报告：实施合同

日期：2026-10-10。承接 `29ed9745`，不重新实现 159/160。
仅专用 QA enrollment 和 Host 审阅的脱敏产物；用户政策已确认，没有新增待选项。

## 模块边界

- Contracts/Core：固定 namespace 下 enrollment JOIN 后分页，以及真实 SQLite 原子报告读回。
- Daemon：私有 Main ingress、可信 lineage 校验和 report-only producer；不开放普通 API。
- Desktop Main/preload：固定 canonical workspace、exact owner/URL、清理后的 epoch fence，
  公开窄 `list` / `generateReport`，复用单项 `submit` / `cancel` / `inspect`。
- Web 设置：启动与诊断内独立 QA 面板，纯异步 controller、视图和聚焦测试分开。
  不把反馈表单或报告插入运行时间线，不新增会话复制/总结。

## 列表与隔离

列表默认25项、最多50项，包含 completed/unknown 等所有明确 enrollment 的任务。
游标必须属于同一固定 namespace；筛选和 JOIN 在 LIMIT 前完成，不能借 worker queued selector。
Renderer 不选择 workspace/namespace、不提供任意路径或审阅 artifact 内容。
Main 返回固定配置 workspaceCwd 与 canonicalWorkspaceCwd 的可信绑定；每次读操作前后核对
配置路径 realpath 仍指向固定 canonical workspace，失效/别名重定向拒绝返回。UI 只接受这两个
Host 验证路径之一，其他 cwd 拒绝整页；不通过 Renderer 自报别名或仅移除比较来放宽隔离。
workspace/capability/选中任务切换立即擦除旧快照，迟到成功、错误和报告都不能回写新 scope。
列表读取只在用户展开 QA 区域后发生；有界分页由用户触发，不后台采集或自动全量加载。

## 单项反馈与未知提交

选中已登记任务后先 inspect，未取得可信当前 head 前不开放提交。
无 head 仅 adjudicate；active head 可 correct/revoke，绑定 exact event；revoked head 不重新裁决。
只有明确 submit 点击才创建新 requestId 和调用 native 单项确认；UI 表单本身不是身份认证。
提交、报告和 inspect 串行；提交期间禁重复、可取消 exact requestId，但取消返回不代表已回滚。
失响应或 submission_unknown 时不换 requestId 重发、不自动重新认证；先只读 inspect。
pending/unknown 状态禁新提交。成功提交后也先 inspect 事实，而不是用按钮点击推断持久化。
异常只显示固定安全错误码/说明，不渲染原始错误、栈、密钥或服务端正文。

## 固定 report-only producer

用户显式以 `{taskId,eventId,revision}` 生成报告。报告绑定完整 enrollment/event/consumed intent、
payload digest、durable audit seq/action、五个 artifact byte pins、配置和 rubric lineage。
读回缺失、审计不符或 sealed bytes 漂移为 unavailable，不靠字段存在证明可信。
报告不伪造137 humanGrade、不增加 promotion 样本/阈值、不消耗模型 quota。
不泄露 OS binding、confirmation key、原始 artifact bodies、凭据或普通会话内容。
生成时取得的是固定报告内容；后续 inspect 只改变独立 currentness（current/stale/unavailable）。
纠正/撤回不覆盖旧报告、不回退旧 pass、不静默生成新报告；生成新报告必须再次显式点击。
该报告是只读派生产物，不宣称新增 durable 报告表、后台报告存储或历史自动迁移。

## 验证与剩余门槛

Core：真实临时 SQLite、分页普通前缀/foreign cursor、终态任务、lineage/pins/audit漂移与读事务。
Daemon/Main：真实私有 HTTP、strict DTO、scope/owner/epoch、响应预算，no-auth escalation。
Web：scope/selection迟到结果、重复提交、unknown只读恢复、分页、correct/revoke、stale报告保留；
真实 TSX 渲染检查可见状态/无权限字段/有界列表，不把替身测试称 packaged 验收。
原生窗口滚动/取消和真正用户认证、受预算 Provider completion、正式 Office source approval、
Mobile native、owned macOS12类验收仍须独立真实证据。
H10 根预算未答，不启 dynamic children；总目标 active。根 checkout 和独立 writer WIP 不修改。
