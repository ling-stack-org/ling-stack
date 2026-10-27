# E6 main 整合后的可靠性差量

基线是已保存的普通 merge `d369e4ca`。本页记录后续修复及其验收边界，
不替代原 Continuity/待决操作设计，不代表整个 E6、GUI 或发布验收完成。

## 五项具体缺口

1. **RPC 与 HTTP 使用同一鉴权边界。** 配置 Bearer token 时，WebSocket
   upgrade 必须先鉴权，再进入 initialize/订阅/执行分发。只接受 Authorization
   header；不把 token 塞进 query/subprotocol。未配置 token 的本地行为不变。
   当前浏览器入口缺通用 Bearer 传输时安全拒绝，不宣称支持认证远端 UI。
2. **频道加载错误使用稳定归属。** transcript refresh/paging、反馈 Map、View
   selection 和 dismiss 共享 workspace/channel/branch scope key。请求开始时捕获
   owner，保留 observation/read epoch；topic 不借用 root/branch 的错误归属。
3. **交互 HTML 的离线边界由浏览器执行。** CSP 默认拒绝，仅允许内联脚本、
   样式与明确的本地 data/blob 资源。可信 wrapper 的 frame-src 限制内层 opaque
   srcdoc 的自身导航，避免误把 connect-src 当作 location/meta-refresh 禁令。
   两层 policy 先于作者字节，srcdoc 全属性编码，不依赖伪 head 扫描或作者 CSP。
4. **市场索引获取复用固定地址传输。** 公网 DNS 全答案校验、连接 IP 固定、
   HTTPS/SNI、每跳重验、总 deadline、非成功状态拒绝和流式 UTF-8 字节预算都在
   Host 完成；不使用未受控 global fetch，也不在完整缓冲后检查字符长度。
5. **通知冷启动先加载持久事实。** 首次 preferences GET 与 IM delivery sink
   都先 ensureLoaded；registry 的单次初始加载由共享 promise 串起，避免迟到
   snapshot 覆盖已经成功持久化的新 destination。禁用目的地仍不得派发。

以上不新增数据表或放开权限，不重写历史，不自动重放命令、批准或模型任务。
市场传输、通知产品修复及其测试生命周期分别审阅；不能用正常路径通过数
代替启动、关闭失败时的资源清理证据。

## 已有证据与缺口

- RPC：真实隔离 Host RED 5 fail/2 pass → 44/44，通过窄独审。
- 频道归属：真实 producer/feedback/consumer RED 11 fail/4 pass → 41/41，
  通过窄独审；包含此修改的 Web 全套 **1020/1020**，typecheck exit 0。
- HTML：新测试 RED 0/8 → 定向 14/14；contracts 全套 **112/112**。
  内置浏览器合成 loopback 探针由旧策略 9 次请求变为新 production 零请求，
  三种场景内联脚本仍运行。真实按钮点击受工具嵌套帧定位错误阻挡，
  不能据此宣称完整交互或 packaged GUI 通过。
- 新 canvas 1.0.13 在本机 Node 实际绘制并编码 PNG；keyring 2.1.2 实际加载
  原生模块，但未构造 credential entry、未访问 Keychain。不是 Electron 包内验收。
- 市场传输：exact-source 13/13；共享传输组合 40 pass、0 fail/cancel、1 个既有
  parent child-only skip，实际 exit 0。隔离子进程的 socket/TLS 场景确实执行，
  不是公开 Internet 访问证明。源码窄独审无剩余已确认产品缺陷。
- 通知：原始 RED 3 fail/5 pass → 定向 8/8；后继双隔离组合 29/29。
  后续补上测试 fixture 的提前清理登记和环境恢复；当前通知、市场与故障注入
  组合 59/59、零 fail/cancel/skip、实际 exit 0，其中纯 VM 为 27 项。
  fixture 独立闭合审查已完成，旧 N1 与市场临时目录清理发现可关闭；既有
  governance 同时 body/close 失败可能只保留 close 错误的诊断限制仍保留。
  不冒充 Daemon 全量或 GUI 验收，也不因此关闭下述数据库事故。

Office 固定输入清单从 1625 补为 1637：十个新 runtime 可达输入、一个显式
type-only diagnostics contract，以及共享鉴权 helper。列表包含不等于内容批准。
原审核 map 在固定 d369 快照已有 68 项变化（13 tracked、55 generated），
后续修复也会改变 hash；旧正式记录不能自动覆盖。最终准确差量及测试需在
实现停止写入后绑定，不重读字节未变的全部源码，也不放松既有审核契约。
最终包含共享鉴权 helper 的原 source-input 组合已实际正常退出：1397/1397，
零 fail/cancel/skip。独立静态审查覆盖固定表与三类负例接线，不等于全部新字节
已获内容批准。只读 proposal 仍为 approved:false、approval:null：12 项新增、
71 项原输入 hash 变化、1554 项未变，15 个原生输入未变；正式审核记录尚未更新。

## 测试隔离事故，必须保留

旧 governance 通知测试 helper 未指定独立 home/default workspace，在扩大组合
时误访问了 E6 工作树的 `.ling-stack/ling-stack.sqlite`，并留下 migration 191
写入迹象；随后因既有 delegation marker 冲突而在 Daemon 启动前失败。不能把
抛错等同于未写数据库。缺少运行前快照，无法证明其他字节或业务记录完全未变。

已停止该未隔离入口，不擅自回滚、清 marker 或修日常数据库。测试 helper 已改为
自有临时 workspace/home，并在所有退出路径恢复环境；后继组合再加外层临时
LING_STACK_HOME 防护。原失败及影响限制在本地
`output/e6-20260928/main-integration-notification-restart-repair-20261027.md` 保留。

## 不变的未完成边界

旧 QA App 仍绑定 f135 包，不覆盖 d369 或上述 WIP。Mac 锁屏阻塞正常 GUI 操作、
原待决范围案例与正常退出；不使用备用驱动或终端绕过锁屏。新包仍需最终精确
输入差量审阅与 QA 绑定、原生/打包路径及真实客户端验收。H09 硬输出上限和
本人认证、P3 剩余矩阵、最终 PR/main 核验均不因单测通过而完成。

CI 按用户要求不启用或 dispatch；不正式发布、不做 Windows、不升级全局 gstack。

## 远端备份的脱敏检查

checkpoint 首次普通 push 被拦截，原因是市场 URL 拒绝测试中两项带
`user:password` 的保留 `.test` 主机样例，不是真实凭据。仅在仓库既有
`.gstack-redact-allowlist` 登记扫描器匹配的两项精确原文；不改测试躲模式，
不加通配、不禁用或跳过 hook。直接调用原扫描器验证：样例 HIGH 从 2 到 0，
另一个未登记的合成凭据仍触发 HIGH；实际 push 结果由远端读回另行确认。
