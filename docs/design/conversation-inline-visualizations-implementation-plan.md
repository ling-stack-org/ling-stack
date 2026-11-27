# 会话内可视化实施计划

功能与交互以[会话内可视化设计](conversation-inline-visualizations.md)为准。每一步以可验证的用户行为为出口。从同一独立分支交付，由 PR 校验整个影响范围。

| 顺序 | 模块与交付 | 出口 |
| --- | --- | --- |
| 1 | Contracts 定义有界文档。Core 在工作区 SQLite 保存不可变内容及 Run、Thread、Turn、消息所有权。UI Core parse 只认顶层独立引用。 | 位置、引用去重、上限、幂等、持久化重开测试通过。 |
| 2 | Daemon 实现受策略约束的发布工具与按消息读取的服务。Pi 注册和恢复正式工具描述，Web Timeline 复用隔离预览。 | 回复提交后可读，运行中及跨会话请求被拒绝。Playwright 验证切换、折叠、脚本授权与关闭。 |
| 3 | 配对 Gateway 和 Remote Client 协商只读命令，使用现有认证会话按需传输。Mobile 消息接入独立 WebView。 | 新旧网关兼容、摘要校验、绑定撤销和断线后重读覆盖。记录 iOS／Android 构建、模拟器和真机各自的实际证据。 |
| 4 | 验证普通对话、频道与队友私聊的现有回复生产路径。核对受管 runner 的注册契约及支持矩阵。 | 在同样的消息作用域下读取，旧客户端显示文字。明确支持的生产 surface 和 runner。 |
| 5 | 更新设计、使用行为和 API 文档。使用仓库 TypeScript 检查、回归、浏览器、文档和依赖检查。 | PR 的变更范围、适用平台、验证结果和现场缺口可追踪，适用 CI 全部通过后合并。 |

## 原位脚本与大文档交付

| 模块 | 验收 |
| --- | --- |
| Pi、Daemon、SQLite | 保留内联 HTML 输入，支持当前 Run 的工作区暂存文件。验证文件授权、真实工具执行、同 Run 文件读取、格式和大小校验、内容快照、旧库迁移与重开。 |
| Web 与 Desktop | 在正文启动与停止脚本，展开保持单一实例和独立授权。用自包含 WebGL 示例操作画布和 HTML 控件，验证刷新、键盘、窄屏与日志。 |
| Gateway 与 Mobile | 测试分块协商、原始字节边界、合并后的完整性校验、拒绝过期及跨会话读回、断线和旧客户端行为。分别记录网关联调与真机验证的覆盖范围。 |

## 验证记录

| 范围 | 证据 |
| --- | --- |
| 发布与历史 | [Pi SDK 测试](../../packages/runner-pi/test/sdk-tool-result.test.ts)执行真实工具调用并验证回执与日志。 [Daemon 集成测试](../../packages/daemon/test/conversation-visualization.test.ts)覆盖普通会话、频道、队友私聊、SQLite 重开和按消息读取。覆盖幂等、冲突、未提交拒绝、过期版本和跨会话拒绝。模型输出由测试夹具提供。 |
| 迁移与续跑 | 历史迁移测试从旧架构升级并保留原数据和约束。用户回答后的续跑沿用已冻结的工具集合，交由当前执行所有者发布。 |
| Web 和 Desktop | [Chromium 端到端测试](../../apps/web/e2e/conversation-visualization.spec.ts)和本机 Electron 开发渲染器覆盖正文顺序、HTML 控件、展开与焦点恢复、脚本开关和刷新。Desktop 安装版的交互仍待验证。 |
| 配对协议 | Daemon 的认证 WebSocket 集成测试覆盖协商后读取及未协商拒绝。[远程客户端测试](../../packages/remote-client/test/client.test.ts)覆盖旧 PC 降级、带摘要的读取与校验失败。 |
| 原生构建 | 本机通过 iOS 无签名真机目标构建和 Android arm64 APK 构建。macOS WebKit 验证了 iOS 离线规则和原生 WebView 文档的静态渲染。签名分发、iOS／Android 真机配对、跨网络读回与 WebView 触摸验收仍待验证。 |
| 原位脚本与大文档 | 本地测试提供方驱动真实 Pi SDK 和 Daemon，通过现有写入与命令工具发布 WebGL 样例。原样例为 743,628 字节，补足至 5,000,000 字节后，Chromium 和 macOS Electron 开发版均验证了正文内脚本启停、按钮操作及刷新重开。Chromium 还覆盖窄屏。[迁移测试](../../packages/core/test/conversation-visualization-migration.test.ts)和[配对协议测试](../../packages/daemon/test/conversation-visualization.test.ts)覆盖旧库、获准的文件写入、超限拒绝、单连接四次满额读回、可重试限流和旧客户端降级。 |
| 5 MB 移动端验证 | 移动端使用的 Remote Client 通过本地认证 Gateway 读回同一份 5,000,000 字节文档的 39 块并校验摘要。macOS WKWebView 使用移动端离线预览文档，检查文档末尾、原生折叠控件和禁用脚本。iOS 无签名真机目标构建和 Android Expo JS 打包通过。手机真机运行与跨网络读回仍待验证。 |
