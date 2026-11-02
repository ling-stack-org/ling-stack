# E6 剩余目标与执行计划 — 2026-10-23

状态：剩余工作计划，不是验收通过、合并或发布记录。

本计划依据当前实现分支、最新真实退出回执和具体 QA 批准整理，取代
2026-10-19 检查点作为执行顺序的用途。旧记录保留，不再从其历史“未实现”段落重新开工。

## 1. 唯一基线与已有成果

- 唯一实施树：`ling-e6-continuation/ling-stack`；分支 `codex/e6-safe-continuation`。
- 资源重建/首次打包基线：`7b648dfd541bde9e8a94bba566ff65b972fe5aa5`；
  P1 与首轮复制修复已保存为本地 checkpoint `69a7a32a`，不是 push/PR/merge。
- 此次只读核查未刷新远端；本地记录显示已整合 `main@9014741d`（#578），
  不能据此宣称当前远端没有更新。最终提交/合并前再核对一次，不在验收中途无条件滚动基线。
- 前述验收文档、已批准 Office manifest、四个测试夹具已随 checkpoint 保存；
  当前追加差量为 P2 冷资源 bootstrap/服务 readiness 分层修复与对应记录。
  宏路径修复已获具体批准并真实打包；原 untracked crash report 保留且不纳入提交。
- 最新 Core 完整回归 4431/4431、Runner 567/567、Office source closure 1343/1343
  已有 exit0 证据；Daemon 完整回归 7419 项中 7407 通过、12 既有 skip、零失败/取消，
  actual exit0，`sourceUnchanged=true`。不要因编写新计划而重跑。
- 当前输入的合成 SQLite/scheduler 性能已通过原五项门槛；不是 GUI 或真实模型性能证明。
- 问答/审批恢复、动态委派的预算与持久权威、整树暂停恢复和收尾、T13B 投影/保留/停机
  已有实现及隔离验证。它们不再列为“从零实现”；仍需当前 packaged 组合证据，
  也不能把测试中启用的能力说成已对普通生产 Run 全面开启。
- 原具体 Office QA packet 已由用户批准并通过正式 reader，仅限隔离 arm64/ad-hoc QA。
  不重复请求同一批准；受审输入改变时仅补受影响差量审阅和新的具体批准。

## 2. 五个剩余目标

### P1 — 可重建的 GStack 打包资源链

当前状态：下列构建准备缺口已实现并通过真实重建；P1 通过，不代表 P2–P5 完成。

工作：

1. 固定现有上游版本，获取源码、锁定依赖、模型及浏览器资源；不升级用户全局 GStack。
2. 复用 managed 构建入口，保留容量预算、单写入者、缓存/临时目录归属、失败清理、
   不覆盖既有 generation 和完整校验。下载可访问性不代替完整下载及校验回执。
3. 收口 fresh 构建与已审来源的绑定：原 source manifest pin、旧 resource-stage checksum、
   固定 ffmpeg 路径都要核对实际来源与可复现性。不能删掉 hash guard、接受任意新 hash，
   或用全局安装/fixture 冒充已审可执行资源。
4. 提供清晰的获取→构建→校验→选择步骤；完整 bundle 验证通过后才生成
   `.ling-stack/build/gstack-desktop-selection.json`，失败不发布半成品选择。
5. 定向覆盖损坏/缺失、平台错误、构建输入变化、中断及重复执行；完成必要差量独审。

存储决策已确定：用户选择显式的 `local-bounded` 受限本地构建目录。原外部卷模式仍为
默认，不自动降级；本地模式使用独立私有缓存父目录，不改全局安装或普通工作区。
保留 12GiB logical budget、至少 20GiB 空余、同父目录/target 的跨进程单写入者、
canonical 路径与目录身份检查、最多两代及中断残留阻断。监督器检查不是 OS 硬配额，
也不承诺防御不受限的同 UID 进程；发现身份/路径异常时拒绝继续，不主动删除未知内容。
本地模式已完成定向回归和独立边界审阅；后续新增模块仍需差量审阅。

### P1 当前实际检查点

- 独立私有目录：用户缓存目录中的 `ling-gstack-e6-20261023/resources`（本机绝对路径仅保存在本地 QA 记录）。
- 固定上游 GStack `1.91.101.0@47d639abffa882b8cbb641d7d1dedf08ecada9ec` 源码已获取，
  3714 文件/57 技能完整验证。旧 source manifest 通过精确字节重建恢复，未更新 reviewed pin；
  当前 recipe 与恢复产物的区别保存在资源目录 `artifacts/report/source-reconstruction.json`。
- TestSavant 固定 7 文件、116117227 bytes 已全部下载且 SHA 匹配；不等于 redistribution 批准。
- 原生依赖已真实构建 exit0，native receipt：
  `sha256:9d84d9c113892c6f23ee26de9639928a74c84a286a054424a1cd582a6eaaa921`。
  使用本机 thin arm64 Node 24.15.0 与 Bun 1.4.4；universal Node 被正确拒绝，未放松 target 校验。
- Shell AST helper 已真实构建 exit0：
  `sha256:81aa775f018be99d99d9754e6ef13d73234d39e3946ca491383087f82fd0a03a`；新增 helper 的差量独审已完成。
- 平台资源首次 exit1 的原因已精确确认：五组 inputs 图全部与旧审阅相同，只有 compiler 不同。
  已在 lease scratch 获取并核对原 Bun 1.4.2 的完整 SHA，原 native/resource builder 重建
  真实 exit0（session59206，148829ms），没有更新任何 reviewed pin 或全局 Bun。
  新 resource stage：`sha256:58dff1d02f2839af8acdb180cdd75ff0bed4576e0ae1a997351aeed76c8bde93`，
  retained native receipt：`sha256:b6dae2d466f8e995a64dca93579028fb03afc7300a804806334bdd6fae0a0ba7`。
  当前 root 4134885777 bytes，未超预算；不是 executable/package/GUI 完成证据。
- assembler 已去除丢失本机目录的硬编码依赖，要求 detached stage SHA；定向测试 3/3。
  browser composite 和首次 selection 已实现；最终相关9文件组合34/34，无skip，差量独审剩余finding=0。
- browser首次因隔离HOME缺少gh登录配置实际exit1，失败保留；修为固定公开元数据读取后，
  session79852真实exit0（192819ms）。固定浏览器版本154.0.8037.97、transport/inventory
  精确匹配既有pin，三官方archive完整校验，只读挂载正常卸载；root使用4742812128 bytes。
  executable session76789真实exit0（65488ms），29635文件、1296949186 bytes；完整bundle
  manifest SHA`42e8edca5d7f7ba275d462756fc8ab85e1c9638b69f9811994bafb895b034d00`。
  select-executable session37198真实exit0（9612ms），正式首次selection已发布且reused=false；
  root使用6425116095 bytes，未超12GiB预算。P1真实闭环，不是fixture或全局安装替代。
- P1 产物和实现已本地提交保存；没有成功的新 macOS QA 包、GUI 验收、模型评估、推送或合并。

完成标准：从明确的固定输入重建出真实 bundle；模型/浏览器/manifest/identity 全部匹配；
选择清单可被正式 Desktop reader 接受，不再依赖那一份已丢失的本机旧 stage。

### P2 — 生成并核验新的隔离 macOS QA 包

依赖：P1。

历史复制故障：P1已通过，原命令的真实打包session55530已exit1；当时日志为
`output/e6-20260928/human-qa-package-resource-restored-20261023.log`。
完整校验在afterPack拒绝：Builder walker漏复制清单内一项`.gitkeep`。根因已复现，
已从已验证manifest增加精确单文件映射，真实Builder复制回归RED→GREEN；原邻接72/72。
独审随后发现 Builder 会把字面路径中的 `${…}` 当宏展开。现对所有输出映射的 from/to
在返回配置前拒绝宏语法；真实 expandMacro 回归在修前五场景全失败，修后邻接78/78、无skip。
此一项差量已独审并获用户具体批准。后继session36004真实打包exit0，身份与codesign
均已读回匹配；完整产物指纹见`output/e6-20260928/p2-packaged-identity-readback-20261023.md`。

已修复的冷启动阻碍：正确隔离启动上述旧包后，真实界面显示本地服务20秒启动超时；已保留截图并
正常退出，未进行会话或模型调用。完整固定资源认证/保留先于listen/FD3，实测原保留34.2s，
8worker候选保留24.3s；不能只优化或扩大HTTP probe时限就宣布完成。

冷启动补充契约（实现、差量独审、具体批准及新包真实GUI冷启动复测已完成）：

1. 普通/开发服务readiness仍为20s；packaged资源准备另有固定60s绝对预算，不由活动续期。
2. Desktop只从自己spawn的child继承FD4读取单个有界记录，严格核schema/phase/pid并等待EOF。
   Daemon在完整资源认证/保留后才写`resources_ready`并关闭FD4，之后才启动服务；不信日志、
   文件、HTTP或模型文本来宣称资源成功。完整资源缺失/损坏仍失败关闭，不切回旧builtins。
3. FD3引擎权威保留独立校验与PID/endpoint绑定，读取总预算涵盖资源阶段；取消或child终止
   时立即撤销两个reader，不能因原20s早到而丢失真实权威。排队IO错误必须安全排空到close，
   不允许Promise虽拒绝但Desktop因未处理error崩溃。
4. verifier最多8个worker，保留原inventory/path/inode/stat/SHA256守卫；首次错误停止新准入，
   等已打开句柄全部关闭后拒绝，lazy读取仍重新校验。不是缓存跳过验证。
5. 资源阶段成功后才开始普通20s readiness；缺失/伪造/错误PID/超时/退出/取消都不产生连接成功。
   不自动重放任务，不接管未知stale writer；失败QA缓存经精确核验后仅可恢复隔离，不删历史。
6. 固定Office审核清单显式纳入新协议和Main阶段控制器。独审与新具体用户批准后才重打QA包，
   不能沿用Builder-copy批准覆盖本轮新源码；正式发布仍禁止。

当前完整资源bootstrap（production准备函数、真实App资源、独立cache）实测27.4s退出0，
仅证明资源路径可在候选预算内完成，不是新包GUI通过。
最终相关12文件组合1497/1497、零失败/取消/跳过、actual exit0；Core/Daemon/Desktop Main
编译与diff-check通过。两独立差量审阅均已完成，选定输入未解决finding=0，报告位于
`output/e6-20260928/p2-cold-preflight-independent-review-20261023.md`和
`output/e6-20260928/p2-bootstrap-independent-review-20261023.md`。
用户已批准新具体packet5927e6e5。session92413新包actual exit0，严格codesign和ASAR
身份校验通过；真实Main36013/Daemon36023隔离启动，资源28168ms、随后服务174ms后就绪，
内置Cua已看到实际主窗口/初始化页。证据见
`output/e6-20260928/p2-cold-bootstrap-packaged-readback-20261023.md`。
P2完成，直接继续P3；不重复既有长套、P1重建或旧CPA调查。此处不代表P3/H09或总目标完成。

- 冻结最终输入并检查是否改变既有批准的 closure；未变输入复用原审阅，新增变化单独审阅。
- 如改变受审输入，展示新具体 packet 请求批准；不重新审阅全部已确认未变内容，
  不让旧批准自动覆盖新字节。
- 执行原 `LING_DESKTOP_PACKAGE_HUMAN_QA=1 ... package:mac` 路径；保留真实退出码及日志。
- 核验包 hash、资源 identity、签名状态、Daemon 与源码对应关系。
- 使用原独立 QA profile/workspace、端口 17928；启动后读回 PID/argv/目录归属，
  不 reset/reseed 历史、不动日常客户端数据。
- GUI 操作首选 Codex 内置 Computer Use；仅遇到明确能力限制时使用备用 `cua-driver`。

完成标准：确实产出并运行同一冻结输入的新 QA 客户端；不是只有编译成功或旧包截图。

### P3 — 当前包的真实行为、UI 与可靠性联合验收

依赖：P2。按下列顺序执行，用户可在客户端重开历史检查。

| 批次 | 案例 | 核心验收目标 |
| --- | --- | --- |
| 基础会话与小项目 | N-01/N-02/N-03/P-01/B-01/T-01/V-01/E-01/J-01 | 三种会话共享展示；连续上下文；真实写代码/运行测试/修错；batch 边界；文件增删统计与逐文件 diff 跳转；完整 turn 复制；单一有效结果 |
| 频道与动态委派 | C-01/C-02/C-03/C-04/F-01 | 至少两个真实 required participants；子 Agent 叙述和工具可追溯；partial 不成功；预算/权限/optional 随父停止；真实结果汇合 |
| 审批与恢复 | A-01/R-01/R-02/R-03 | Allow once/similar/deny/expiry；问答恢复；真实 retry、SSE 断线、Daemon 重启；工具不重复执行、旧 writer 不越界、未知效果不冒成功 |
| 长历史与规模 | H-01/H-02 | 三种会话首尾可达、滚动/焦点/折叠稳定；单一 root window；密集 child 数量/延迟实测 |

- 完整断言仍以 [原验收矩阵 §6.3](conversation-codex-style-transcript-implementation-plan.md#63-e6-packaged-macos-完整案例清单)
  为准；K/U/S 和 Office 原生增量不删减，按现有明细补证。
- H10–H12：在真实授权 workflow 下验证持久预算、权限继承、启动/控制/恢复、
  required fan-in、optional 停止和真实排空；不从模型“已完成”文本推断终态。
- T13B：真实客户端路径补证投影重建、recovery/audit pin 和统一停机恢复；GC 默认不删，
  只在临时隔离数据上验证显式 Host 期限，不对用户历史做清理实验。
- 已验时长格式、R03 restore/collapse/copy 不无故重做；仅在输入适用且范围匹配时引用旧证据，
  当前包尚缺的联合行为单独补验，不能直接把整项涂绿。
- 500-child 若来自合成数据，单列 `simulation=true`，不代替真实 C-01/F-01。
- 每案关联包身份、执行中/终态截图、semantic state、Thread/Run/Attempt/action lineage、
  脱敏日志与真实产物；区分 pass/fail/not_run/simulation。

完成标准：20 个基础 case 及必需增量逐项有判定；未触发工具/缺能力明确保留未验，
不能用 API-only、预置历史或静态截图当真实 Agent 执行。交付客户端内可检查的会话索引。

### P4 — H09 受预算的真实评估闭环

可在 P1/P2 准备期间推进 Provider 能力条件；真实 source 和客户端认证依赖 P2/P3。
此问题不应阻止其它不依赖 H09 pilot 的案例继续验收。

- 现有 CPA Codex chat route 的硬输出上限缺口已核查并落文档，不重复调查同一源码。
- 在已授权服务中选择有可证明硬输出 cap 的 Provider/model/API 路径；若必须修改 CPA、
  切换未授权 Provider 或凭据，另取对应授权，不自行改共享代理。
- 通过同一隔离 QA workspace 的真实 Host 执行建立 source；不把原 synthetic Run 改成真实。
- 冻结脱敏的案例/基线/候选产物，沿现有单次任务与计费路径执行 pilot。
- 沿用每批最多 3 次、24 小时最多 12 次、并发 1、retry 0；未知用量/结果停止，
  不虚构零费用、硬输出 cap 或退款。
- 真实人工提交、纠正、撤回、审计读回由用户本人完成系统认证；自动点击不是本人认证。
- 可信报告不直接变成已校准的自动 promotion；未满足门槛不擅自启用 enforcement。

完成标准：真实来源、受限模型调用、预算/用量回执、用户认证与纠正/撤回历史完整闭环。

### P5 — 修复验收新发现并交付可合并结果

依赖：P3/P4；发现失败即进入修复，不必等所有案例跑完。

- 对真实失败先保留证据、定位根因，补最小完整链路与回归；不靠改文案/压制错误过关。
- 只重跑受影响验证；仅在共享基础或冻结输入变化确实使旧全套失效时重跑相应全套。
- 受审输入变化后补差量独审/具体批准，并在新包复测受影响场景；旧失败不覆盖。
- 汇总“需求→实现→自动验证→真实案例→遗留项”；明确代码已提交、PR、已合并和发布的区别。
- 完成最终差异核对、文档/public/license/security 等适用本地检查；按届时授权提交、推送、
  更新或创建 PR、合并后核验远端 main。不得把主 CI 停用说成 CI 通过。

完成标准：当前范围的必需项无未解释的 fail/not_run；用户能检查真实 App 案例及产物，
代码和证据已安全保存；若仍有外部阻碍，具名列出，不能宣称总目标完成。

## 3. 顺序、边界与不再重复的工作

主线：P1 → P2 → P3 → P5；P4 的 capability 准备可穿插，最终与 P3 一起进入 P5。

不变边界：Windows、全局 GStack 升级、主 CI 启用、正式签名/公证发布不在这轮。
GStack 固定版本资源重建不等于全局升级；macOS QA 批准不等于发布批准。
没有确定的新根因不重复 Codex 源码查询、已通过测试、原全量独审、时长格式或历史复制验证。

本计划不生成新 Goal、不自动提交/合并代码，也不表示上述 P1–P5 已执行完成。
