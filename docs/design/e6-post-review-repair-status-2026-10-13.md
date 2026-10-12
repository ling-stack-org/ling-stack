# E6 全量独审后的修复状态

日期：2026-10-13。实施分支：`codex/e6-safe-continuation`。
本记录区分局部修复、独立复核、远端备份、完整验收及合并，不替代正式审核批准。

## 已完成的局部闭环

| 根因 | 修复边界 | 实际回归 | 独立复核 |
| --- | --- | --- | --- |
| B003 | External-work 准入与取消使用原子状态 CAS 和精确 lease；Host 投影失败保留真实发送/执行事实，返回 503，不伪造执行失败或授予重发权限 | Core 完整 45/45；Host 完整 25/25；build、直接类型检查及限定 diff check 通过 | 原独立审阅者复核其发现的 Host 收尾缺口，无剩余已确认严重问题 |
| A08 | Draft 确认在同连接事务内建立 thread、definition 和 source pointer；反向 update/discard 不能覆写已确认终态；重复 discard 不改变原终态时间 | Core 完整 10/10；新 HTTP 与原 API 完整 12/12；build、直接类型检查及限定 diff check 通过 | 原独立审阅者复核真实双连接 RED→GREEN，反向 writer 候选关闭 |
| A22 | Parser 接受 exact primitive `approve/deny/manual`；Coordinator、Host、Core 各有独立权限守卫；畸形判词保持人工审批，不隐式写 deny | 新回归 55/55；五文件完整邻近 164/164；合法批准的真实命令仅执行一次，重复恢复不重放；build、直接类型检查及限定 diff check 通过 | 未参与实现的独立审阅者核对十个最终源码 SHA、控制流和日志，无已确认 finding |
| A09 长定时器/失败收口 | Node 单段 timer 有界；唤醒重读真实 due；首次、refresh 和异步收尾持久故障进入可恢复 error；旧 entry/generation 不能撤销后继 | 产品矩阵 21/21，随后独立旧 entry 隔离 1/1，原 API 5/5；build、类型检查及限定 diff check 通过。不是拼成一次 22/22 | 原未实施者复核同一异步收尾 finding 的真实 RED→GREEN，限定源码字节范围关闭 |
| A11 实际连接/事实边界 | 一次审核 DNS 全答案并固定到实际 socket；不可变审核集合内的连接回退保 Host/SNI/TLS；redirect 每跳重审；绑定不可克隆/复用；清理先于 completed，COMMIT 后不重发 | 三组分别 6 tests/5 pass/1 skip、25/24/1 skip、4/4/0 skip，均 0 fail/exit 0；HTTP/TLS fallback 直接 child 各 1/1、0 skip。两个 suite skip 是防递归 child 占位入口，不能称零跳过；最新 build、直接 tsc/diff check 通过 | 未参与 A11 实现的审阅者核对十个最终源码 SHA、真实 child 接线和控制流，PASS_SCOPED_WITH_LIMITS，无新确认 P1/P2；上层真实 API/packaged/GUI 不在此结论中 |
| A33 readonly Attempt 血缘 | Core 在原 captured-owner 准入下对新 `tool_start/update/end` 缺失 Attempt 作精确 stamp，显式错配在 durable insert/JSONL 前拒绝；原 SQL fence 和既有审批历史不变 | 主最终 9/9、邻近 9/9、Core 全文件 8/8，均 exit 0、0 skip；26 次执行、19 个独立用例。真实 SDK read 只证明 start/end；Core update、单 read、主动重投旧 callback 不冒充 SDK update、跨 Attempt batch 或自然迟到 | 未参与实现者核对三文件、八份原始日志和真实 producer/consumer，PASS_SCOPED_WITH_LIMITS，无新确认 P1/P2；approved=false，不批准完整 E6 |
| B004/B005 Memory Markdown | fence-aware 结构解析仅剥一个 framing EOL，保 Body 字节、末尾 LF/CR、CRLF 和候选权威；skipped title 复用共享脱敏并正确计 aggregate；GET 与文件输出同源 | 最终 fresh build 后完整导入 16/16（7 parents+9 children）、导出 4/4、API 3/3；相邻 Core 24/24、Daemon 14/14，均 exit 0、fail/skip 0；Core/Daemon build、直接类型及限定检查通过 | 未参与实现者核对五 owned、24 份原始日志 SHA 和 API/SQLite 消费者链，PASS_SCOPED_WITH_LIMITS，无新确认 P1/P2；新 CRLF API 用例仅 dryRun，不冒实际持久化运行、GUI/packaged 或完整 E6 批准；approved=false |

B003/A08/A22/A09 上述回归均零跳过；A11 的两个 child 入口 skip 如上明确保留。各自实际执行者取得 exit 0。独立审阅者读取执行日志与源码，未重复执行测试；不能把继承的执行结果写成审阅者本人运行。

A11 后继 TLS fixture 已移除固定 synthetic key/cert，改为 Node crypto 运行时随机 P-256、短期自签 CA/SAN certificate；随机 key 仅在 native TLS 测试 API 内存 export，不落盘/记录、不关闭验证。初次真实 socket setup 因 Node 不接受 KeyObject 失败，日志保留；修正 API 边界后三组最终为 7/6/0/1、26/25/0/1、4/4/0/0（tests/pass/fail/skip），均 exit 0，四个直接 TLS child 各 1/1、无 skip。Root 对两文件完整新增 diff/helper/native 接线及实际日志作限定复核，未发现新确认 P1/P2。此后继不是全历史 secret scan 通过；已提交 synthetic fixture 仍存在历史，不改写、不绕 hook，正常 push 与远端 head 另行核验。

A22 首次 54 例的 43 个失败中，34 个是产品行为 RED，9 个是 fixture 血缘不足。修正 fixture 后，旧产品的 9 条真实链为合法 manual/deny 2 条通过、畸形判词 7 条失败。首轮 GREEN 的 approve 正例曾因 fixture 缺频道归属被生产准入正确拒绝；仅修正 fixture producer 后，最终 55/55 通过。失败记录保留，不声称首次即全绿。

## 正在处理，不能据此认定完成

- A09 的 RRULE INTERVAL/anchor 是仍未关闭的独立失败面。上表不证明 error-entry restart 时旧 Run 仍 in-flight 的所有重叠执行边界；后继隔离正例等旧 Run 完成后才交付新 due，不冒充重叠执行验收。
- A11 的上层 Comfy connection-check/analyze/import/submit/poll/collect 真实 API 失败回归仍未完成；静态链确认安全传播失败，但现有公开 envelope 仍用 generic code，不能称网络错误细分已全链统一。IPv6 实际 socket、Electron packaged/GUI 未验收。原 sanity/旧 sender RED/ambient 逐字日志未保存，不用最终 GREEN 补造原 RED。
- A11 两次早期未隔离 fixture 进入 store 初始化栈；defaultWorkspaceCwd 确认是实施树，实际 opened DB 文件及 before/after 未证。不能扩称用户日常 DB 被改或未改，不为补证重开/重置数据库。后继全部产品 Node 入口使用 fresh home 与默认 workspace 双隔离。
- A21 及全量独审登记的其他根因仍继续；A33、B004/B005 的局部回归及独审边界见上表，不能把局部闭环全部清零。A21 两私有 Core 接口名和原子承载已接纳，只有 worker/接口准备，尚未运行真实 RED 或实现普通 view 的安全恢复。

## 不变的验收与合并门槛

1. 原完整输入阅读已到 EOF，不重复全文阅读；阅读覆盖不等于内容批准。后继变更必须重新绑定精确输入并完成受影响独立复核。
2. Office 的具体审核记录仍须用户批准；本记录不生成 `approved` 或 `contentReviewComplete`，不授权正式发布。
3. 后继 fresh packaged macOS、真实客户端案例、问答/恢复/沙盒/Harness 联合矩阵仍未全部完成。上述局部回归不是新包 GUI 验收。
4. E6 PR 保持草稿；备份不是验收通过。主 CI 停用且无 checks 的 PR 不能当成通过；有冲突、已确认缺口或未达到原验收门槛的 PR 不合并，不使用 admin bypass。
5. Dependabot #527/#528 仍保留 API/版本/许可适配或实际安装/build 缺证；#529–531 已由外部提交合入 main，head/merge checks 均无记录，不冒称 hosted 安装、缓存、artifact round-trip 通过或本轮由 Root 合并。
6. origin/main `6ddd5e6b75e314cc0fbeee370991c70c7383a0ff` 的整合候选已按三冲突映射受控解开并验证依赖图，不代表 E6 已合入远端 main。main #535 的 35 roots / 1,211 packaging inputs 审核记录不能覆盖已提交 E6 merge candidate 的 38/1,282，更不能覆盖尚未重新枚举的后继 WIP。不会自动刷新 approved；同事范围审阅不替代本分支具体用户批准。

## main 整合候选的新验证与剩余门

- 保 Pi 两包 exact 1.1.0、SDK57/RN0.86.3、Daemon/Runner Undici7.30.0、cache4.3，并入 main 的 image-size2.0.4/Forge/Braces/sprintf 两版本补丁及两侧测试并集。Metro0.84.5 没有 image-size 消费边：畸形图片 fixture 已校准到真实 Daemon→PPTX→image-size，RN/Expo 两条 Metro 资产正例独立保留，不移植 Metro0.87 patch。
- 离线 lock-only 和首 frozen install exit0，但实际安全首轮为14/16：braces 安装路径有 patch_hash，文件无防护。pnpm10 的 installDeps 先按 workspace-state 返回 Already up to date，原 force 命令仍未重import。仅将 exact 生成 cache `.pnpm-workspace-state.json` recoverable 移入 ignored 证据目录后，同一 frozen/force/side-effects-cache=false 真重import 1,293 个包、exit0；未删除用户数据、不改 manifests/lock/onlyBuiltDependencies 或 pnpm 安装源码。
- 最终安全42/42（Mobile/tooling16、Daemon2、downloader/formatting24），全部 fail/skip0；许可证、Mobile typecheck、Runner/Daemon fresh build:ci exit0。Pi1.1/SDK压缩邻近31/31、fail/skip0，是此次依赖整合后重新执行，不重做旧迁移设计。
- public 首轮6条告警均为固定 synthetic 测试 token 未明确带 test 标签；仅将三测试文件的合成字面明确命名为 test fixture，不改 scanner/allowlist、不编码或隐藏真实密钥。最终源码检查 exit0，当前4,576文件；两Memory完整文件7/7和A11实际Comfy native parent1/1均 exit0/skip0。这不是全历史 secret scan；历史 synthetic TLS key 限制保持。
- Expo install --check exit1，具体仅 expo57.0.27→~57.0.28、expo-dev-client57.0.19→~57.0.20 的新SDK57补丁要求；下一独立兼容步骤补齐，不升级SDK58，不把本次typecheck当配套检查全通过或真机验收。
- 三冲突及消费锚点的独立静态复核报告 `main-merge-scoped-review-20261013.md` SHA `e74f4266c85543925155647e91d4d550f77a8d2c7b5c3ca35c8d1b1d07834924`，STATIC_SCOPED_PASS_WITH_UNVERIFIED_RUNTIME/approved=false；独审没有亲自执行上述运行验证。原始日志位于 `output/e6-20260928/main-merge-*-20261013.log`，首失败保留。
- 审批恢复实际SQLite reopen/HTTP/SSE四个具名邻近4/4、exit0/skip0；Markdown链接334文件检查通过。以上 Root 的 tee 日志仅保存原始 stdout，进程 exit0 来自实际 exec/write_stdin 回执，不伪装日志本身含 command/exit 或独审亲自执行；后继合成fixture限定复核据此分开注明来源。
- 三测试命名增量独审 `synthetic-fixture-name-review-20261013.md` SHA `6ffc26c23ab95857ad033e13298c2d41ff7e401e6c1be8a22e72e91b25328198`，PASS_SCOPED_WITH_LIMITS/approved=false。三个新测试 SHA 与日志已冻结；旧 B004/B005/A11 的产品结论不变，但原整文件测试 SHA 不冒包含本增量。

## Dependabot 兼容子集与菜单回归后继

本组不接收 #527/#528 整组升级。只处理 Daemon MCP SDK exact1.32.1、六项 Radix exact patch、Expo~57.0.28 与 Dev Client~57.0.20；保 Pi1.1.0、RN0.86.3、Mobile React19.2.3、Daemon/Runner直接Undici7.30及安全补丁。Expo配套check现已通过；前节首次exit1保留为历史，不重复迁移SDK58或Pi。

四文件闭包独审发现 focus-scope1.2/slot1.4 真正传递minor，另有合法范围内的Expo json-file/env解析回落；没有把全部lock差异描述为升级。实际验证为MCP完整协议44/44、HTTP/SSE三层facade3/3、Pi/MCP/压缩三个完整文件34/34，全部fail/skip0；模型transport为测试替身，不使用真实Provider。Mobile类型与Expo配套、Runner/Daemon/ui/Web构建通过；不代表Mobile真机或新macOS包通过。

原浏览器运行先因缺匹配Chromium失败，未进入产品页面。将精确headless1243装入本QA ignored目录后，六选例实际4pass/2fail：sidebar空态fixture误含Engineering，菜单Escape未关闭。只在sidebar该空态case设channels=[]、增加初始可见与无Engineering断言，保全局factory和所有原断言；后继完整两例通过。

菜单根因是默认IconButton Tooltip保留窗口与双Radix dismissal模块栈竞争Escape。Tooltip/Dialog/Popover上游exact1.1.19，Menu/Toast exact1.1.20；原真实trace和Vite双模块支持诊断，未实跑旧HEAD依赖baseline，不宣称已证明为本升级新引入。仅禁用closed Tooltip动画的临时反证使原例1/1通过，随后撤除，不提交CSS探针、不给wrapper强制close。

最终根修是根pnpm精准override `@radix-ui/react-dismissable-layer@1.1.19`→`1.1.20`。这是**主动覆盖上游exact patch pin**，不是合法range dedupe。两版API/层栈核心相同，含primitive2.1.10→2.1.11闭包。新增单例回归从每个真实consumer锚点核CJS/ESM realpath，旧安装1fail→后继1pass；不是用root hoisting冒充实际消费。

后继fresh frozen/offline/force/side-effects-cache=false实际重import1301包、exit0。最新证据：

- 单例回归及原primitives完整34/34，零fail/skip；后继安全42/42，零fail/skip。
- 七完整spec 21/21、零fail/skip/exit0，其中20个mock浏览器真实DOM案例、1个viewport纯逻辑案例；无CSS探针/重试，含原菜单、Dialog忙碌禁止关闭/外点/Escape/焦点、Popover、Toast、Tabs、Switch、toggle-group、sidebar及三种会话反馈。不是真实Daemon/model或packagedGUI验收。
- fresh ui/Web build及Web typecheck exit0，原chunk/dynamic-import警告仍保留。许可证1211版本/23families通过，不替代binary notice审批。
- 五类consumer在当前实际Vite模块图同import `dist-C2VXoZer.js`，browserHash25122564；没有声称Desktop packaged图已核。

四测试隔离变更仅涉及fresh绝对cwd/first-run identity同源、strictPort和显式禁止复用、Switch焦点+Space及sidebar局部fixture。独立限定静态审阅无已确认越界；其旧NOT_GREEN判词与原4pass/2fail保持历史，后继21pass另绑日志，不回写旧报告。

原始日志在 `output/e6-20260928/dependabot-patch-*-20261013.log` 与 `dependabot-dismissal-*-20261013.log`。后继DOM日志自身包含启动隔离参数与DOM_EXIT；早期tee未保存完整命令/exit的日志由Root真实工具回执索引注明，不伪装独审者本人执行。

当前完整E6、nested Menu/父Dialog交叠回归、后继具体Office批准、新macOS客户端联合验收和适用CI仍未全部满足。原#527/#528还含范围外major/API/许可/Native或安装门，不能因兼容子集通过而合并整组。#533继续draft备份；未通过不合并、不启用CI、不管理员bypass。

## 证据定位与保全

本地完整执行记录位于实施树的 `output/e6-20260928/office-full-content-review-20261010/`：

- `b003-core-red-green.md`、`b003-host-red-green.md`、`b003-independent-review.md`。
- `a08-confirmation-red-green.md`、`a08-independent-review.md`。
- `a22-exact-verdict-red-green.md`、`a22-final-source-sha256.txt`、`a22-independent-review.md`。
- `a09-long-timer-red-green.md`、`a09-independent-review.md`；最终 scheduler SHA 为 `16974df4346f96afd896ec139a67dc55b497ba2db64eff6a46ffd949e6bb0a7d`，测试 SHA 为 `bd98f7758fee78934f4db96f4a5448d0bf3ee8ff7aa74137ef90163485f411d1`。
- `a11-http-pin-red-green.md`、`a11-independent-review.md`；报告 SHA 分别为 `a60e671df32eaca0a079f9ee874bf434232ed0d6eae155f1e5508c2892112f64`、`7136f8098be9a3060521fa61f0a3cf8ef89b4a67574895bd03f8624693c01d9e`。后继整合改变任一 owned 字节就重新绑定证据，不继承旧整文件 SHA 为新版本批准。
- `a33-readonly-lineage-red-green.md`、`a33-frozen-sha256.txt`、`a33-independent-review.md`；实现与独审报告 SHA 分别为 `6219199f70763a24980f494cb50e8cbe039bb3c9a4909fd5f004109daa86036f`、`9569e2175ef6d6218770ffd0d8a6d17712929df1fb601a28cc6bfc49aad6d9a1`。主最终日志是 `a33-green-closed.log`，不得用旧名含 green 的中间失败日志代替。
- `a11-ephemeral-tls-checkpoint.md`、`a11-ephemeral-tls-independent-review.md`；实现与限定复核报告 SHA 分别为 `15e714da5b55b0db0ab871e1eaa1d6bd6b03ebfc83c66e57c346453663a472e1`、`6b86376cf692448e9dd248a02d78da2e8157183ecd6b850e1f9af2e1d9ede460`。旧 A11 报告/freeze 不覆盖后继两个测试文件。
- `b004-b005-memory-red-green.md`、`b004-b005-final-freeze.log`；实现与冻结记录 SHA 分别为 `d49e614b4478131c5053c50a4dc0950d6fffe45c485790b21a01fc5e6f22a850`、`ba9d7659d018656d8ecf9a989a5f78dec4c80ad35f5c291538f8fc19c32462e9`。继承 build 回执明确不作原始逐字日志，最终 fresh build/tsc 及 post-build 测试另有真实原始记录；末尾 lone CR/两个严格 fence 补充负例仅 GREEN，不补造旧 RED。
- `b004-b005-independent-review.md`；最终限定独审 SHA `8f9232f2de2b1add51ba846860cf8b2dcfa2d89c273a043b9cb0212cd6fefae1`。Root 全文读回并现场匹配报告与五 owned SHA；不重复执行已通过的 Memory 测试。一次最终三文件共 23 个 Node tests（14 顶层、9 子测试），相邻六文件 38 个顶层；不累计重复运行。

不修改根 checkout、日常数据库或另一 writer 的 `harness-delegation-storage-checkpoint-2026-10-09.md` WIP。仅对明确归属、完成局部闭环的修复作备份；未完成或他人 WIP 不批量 stage，不 reset、clean、stash、force-push 或删除分支。
