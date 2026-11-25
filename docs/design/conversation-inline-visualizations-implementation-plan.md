# 会话内可视化实施计划

功能与交互以[会话内可视化设计](conversation-inline-visualizations.md)为准。每一步以可验证的用户行为为出口。从同一独立分支交付，由 PR 校验整个影响范围。

| 顺序 | 模块与交付 | 出口 |
| --- | --- | --- |
| 1 | Contracts 定义有界文档。Core 在工作区 SQLite 保存不可变内容及 Run、Thread、Turn、消息所有权。UI Core parse 只认顶层独立引用。 | 位置、引用去重、上限、幂等、持久化重开测试通过。 |
| 2 | Daemon 实现受策略约束的发布工具与按消息读取的服务。Pi 注册和恢复正式工具描述，Web Timeline 复用隔离预览。 | 回复提交后可读，运行中及跨会话请求被拒绝。Playwright 验证切换、折叠、脚本授权与关闭。 |
| 3 | 配对 Gateway 和 Remote Client 协商只读命令，使用现有认证会话按需传输。Mobile 消息接入独立 WebView。 | 新旧网关兼容、摘要校验、绑定撤销和断线后重读覆盖。记录 iOS／Android 构建、模拟器和真机各自的实际证据。 |
| 4 | 验证普通对话、频道与队友私聊的现有回复生产路径。核对受管 runner 的注册契约及支持矩阵。 | 在同样的消息作用域下读取，旧客户端显示文字。明确支持的生产 surface 和 runner。 |
| 5 | 更新设计、使用行为和 API 文档。使用仓库 TypeScript 检查、回归、浏览器、文档和依赖检查。 | PR 的变更范围、适用平台、验证结果和现场缺口可追踪，适用 CI 全部通过后合并。 |

## 验证记录

| 范围 | 证据 |
| --- | --- |
| 发布与历史 | [Pi SDK 测试](../../packages/runner-pi/test/sdk-tool-result.test.ts)执行真实工具调用并验证回执与日志。 [Daemon 集成测试](../../packages/daemon/test/conversation-visualization.test.ts)覆盖普通会话、频道、队友私聊、SQLite 重开和按消息读取。覆盖幂等、冲突、未提交拒绝、过期版本和跨会话拒绝。模型输出由测试夹具提供。 |
| 迁移与续跑 | 历史迁移测试从旧架构升级并保留原数据和约束。用户回答后的续跑沿用已冻结的工具集合，交由当前执行所有者发布。 |
| Web 和 Desktop | [Chromium 端到端测试](../../apps/web/e2e/conversation-visualization.spec.ts)覆盖共享消息渲染器的正文顺序、HTML 控件、展开与焦点恢复、脚本开关和刷新。Desktop 安装版的交互仍待验证。 |
| 配对协议 | Daemon 的认证 WebSocket 集成测试覆盖协商后读取及未协商拒绝。[远程客户端测试](../../packages/remote-client/test/client.test.ts)覆盖旧 PC 降级、带摘要的读取与校验失败。 |
| 原生构建 | 本机通过 iOS 无签名真机目标构建和 Android arm64 APK 构建。签名分发、iOS／Android 真机配对、跨网络读回与 WebView 触摸验收仍待验证。 |
