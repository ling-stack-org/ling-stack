# E6 本地 WIP 保存点（更新至 2026-10-06）

此提交是用户要求的**代码防丢保存点**，不是可发布版本，不代表整个目标通过。

## 当前合并与验收边界（2026-10-06）

用户已授权处理 PR、整合代码并继续原目标；以下旧 checkpoint 中的“不合并”仅描述当时的保存请求，不覆盖本次授权。所有旧提交、已有实现和历史 WIP 保留，不重写分支历史。

- 已正常合入 main 的 PR：#501 (`c4ebdc90`)、#508 (`56d8d347`)、#510 (`753848ee`)、#505 (`474421c4`)。已核实际 merge commit 和远端 main；没有客户端发布或 packaged GUI 验收。
- E6 从已保存的 `4e0c24bc` 整合 main `474421c4`。模型发现保留 E6 `fetchProvider`/dispatcher 和 main 的分页、共享 10 秒 deadline；55 个 catalog 保留双方文案，只有两个同名新标签沿用 main 的翻译措辞。保留 E6 sidebar/titlebar selectors、workspace capability mock 和 main 新增模型发现场景，不整文件覆盖。
- 新合并输入的 14-package build:ci、Web TypeScript/Vite build 实际 exit 0；provider/HTTP 定向回归 44/44、Web selector/payload/workflow 11/11、55 语言 6608 个键审计均通过。公共扫描 4252 文件、Markdown 289 文件通过。Playwright 仅完成 27 个测试的 discovery，不是 UI 或 packaged GUI 通过。
- macOS source-placement 测试夹具新增精确 dyld observer：仅固定路径、自己产生的负虚拟 FD 和 exact sentinel 摘要；其他 FS/hash 原样转发。生产 reviewed hash、OS/platform、native guard 未变。原两文件 12/12，强制宿主 profile 未审核场景由旧夹具 2 红 / 2 绿变为 12/12；边界 8/8。此模拟不提供物理 OS/profile/FD/kernel/descendant 证据。邻域 84/86 的 Git borrowed-actor 子测试及父级在关闭新 observer 的基线同栈失败，未隐藏。
- 旧 E6 CI `37427829699` 对应 `e9a6389c`，不是本次候选：构建、类型、Web/unit、公共检查和真实 macOS helper/Seatbelt通过；Linux 合同、Daemon shards 1/2/3 失败。Linux HTTP 夹具 decision action 已在 `4e0c24bc` 修正，仍待实际新 Linux lane。其他 source/bootstrap 夹具、审批恢复和 Office 真实 SDK 写入失败须分别收口，不把定向通过拼成完整 CI 全绿。
- #502 已请求同步最新 main，仍需 fresh CI 和另一维护者正常审批；#503 含旧行为回退/冲突，保留而不硬合；#509 的 EPL-2.0 许可、OfficeParserAST.toText 和大版本迁移仍阻塞。#507 仍 Draft，缺完整 fresh CI、组合 review 和正常维护者审批，不绕过保护规则。

公开 U gate、受控进程保护边界和 D0/E1–E6/U/T/Harness 总目标不变。Full Access / 其他不受限同 UID 程序不承诺隔离，raw transport 不是授权。继续原 inventory/scope/canonical/Office route、live/restart/问答/ACK/recovery/API/UI 与 fresh packaged macOS 验收；已完成时长、R03 和旧切片不重复。

## 本次 checkpoint 增量（2026-10-05；Office pair 验真与 rollback 隔离）

用户重新要求向既有 Draft PR #507 保存一次。上一保存点 `970f8de8c03ad8da2f401463968e272fba860bbf` 及历史完整保留；仅追加本轮 10 个源码/测试文件和本记录，不合并、不升版本、不改根 checkout、真实数据库或其他工作区。

- generic launch/continue 对 Office 两种证据显式拒绝，物理效果只能进入原 pair 的 typed roster；有效反例 RED 0/10 → GREEN 10/10。
- public consumer 验证完整 committed pair、对端精确持久行、相同 settledAt、kind/signature、parent digest 与 required children/grandchildren。settlement 使用独立 candidate 入口，在同一事务写完 producer/parent 后才验两边；不提前公开单边 safe，不新增递归回环。consumer 完整文件 67/67。
- owned transaction 的 ROLLBACK 失败关闭共享 DatabaseSync，令旧 Statement/其他引用一并失效。BEGIN 失败不接管 caller 事务；精确 no-active 错误必须经捕获的原 native executor 确认，不能仅相信 wrapped error。close 抛错时保留原 close 后备和所有错误。最终 isolation 22/22，含精确伪 no-active 反例。
- migration150/147/149 矩阵 195/195；只修 JOIN view 夹具，不改迁移产品源码。Core/Daemon 构建实际 exit 0。最终 Daemon full 2872/2872、exit 0；保存前重新核验其 1292 项 consumed source 和 1585 项 dist 指纹全部一致，唯一后改的 facts 测试不被 Daemon 引用。
- Core 首次 full 1890/1896、exit 1：6 项旧错误码断言被更早的 pair gate 拒绝。测试已按精确新边界更新，保留零副作用与旧 hash 校验，并新增 fresh unbound pair 反例；最终 facts 文件 160/160、exit 0。**修改后的 Core full 尚未复跑，不称完整 Core 全绿。**
- 真实 Office no-start 反例仍为 0/1、exit 1：callback/native/effect/resource 全零且 pair 原行未变，但现有 settlement 抛 `host_office_local_launch_unknown`，留下 blocker。必须补原票 closed/noStart、独立 receipt 与原子 known_no_start，不把 failed terminal 改 safe。creator-bound directory receipt、固定 production route、live/restart/answer recovery 和 fresh packaged macOS 联验仍待完成。

本次仅防丢 WIP；公开 U gate 继续关闭，完整 D0/E1–E6、U/T、Harness 目标 active。忽略的 output、日志、截图、安装包、QA 数据库或密钥不上传；branch/PR HEAD 读回后才确认远端保存。

## 前次 checkpoint 增量（2026-10-05；Office journal pair 未验证 WIP）

用户要求再向既有 Draft PR #507 保存一次。上一远端保存点 `50a61fbe491bc1bc9f213618f84a3136cf9c073b` 及全部历史保留；本次仅追加 Office journal pair 源码、测试和本记录，不合并、不升版本、不改根 checkout 或真实数据库。

- migration150、两种 Office evidence/settlement、原票 pair gate、同事务 producer/parent settlement、RunStore/SQLite facade 和 Tracker 接线已写入；新 consumer/迁移/真实 SDK pair 故障回归源码一并保存。
- 所有并行作者已冻结。当前源码与测试尚未统一构建或运行，不能称为 GREEN、safe receipt 验收完成或可合并候选。五个新增 `.mjs` 文件仅 Node 22.22.1 语法检查通过；本次 `git diff --check` 通过。旧测试结果不证明本增量。
- 待修：generic `launchHostOperation` / `continueHostOperationEffect` 仍可绕过 Office effect roster/封口；consumer 的公开整 pair 状态/settlement 验真未补齐；通用事务 ROLLBACK 失败后隔离连接待处理。保留这些已知风险，不为备份隐藏或宣称解决。
- Office `known_no_start` 的独立零效果证明仍待实现，缺证明时 consumer 拒绝安全完成；creator-bound directory receipt、固定 production route、live/restart/answer recovery、fresh packaged macOS 和最终联合门禁仍待完成。

仅保存防丢 WIP，公开 U gate 继续关闭，完整 D0/E1–E6、U/T、Harness 目标保持 active。不上传忽略的 output、日志、截图、安装包、QA 数据库或密钥。

## 前次 checkpoint 增量（2026-10-05；terminal 时间夹具修复）

用户再次要求向现有 Draft PR #507 推送保存。上一保存点 `46b3f458157728ce71a89fe61a1c118bafa7c108` 及全部先前历史保留；仅追加测试修复和本记录，不合并 main、不升版本、不改根 checkout、真实数据库或同事 WIP。

- 上一 Core 329/330 的唯一失败已定位为测试夹具时间顺序错误：延迟 target read 的 close 后，后续 temporary 观察仍可能晚于人为设置的 terminal completedAt。严格 `boundedTime` 拒绝是正确行为，不是生产 parser 漏洞。
- 仅将 closeAt 改为原 manifest 完成时间之后，并同步后续固定 writer 成员观察的时间；生产校验与两条原断言保留，没有删除、跳过或放宽测试。
- 同一递增 Date preload 下，修复前定向 **0/1、exit 1**；修复后定向 **1/1、exit 0**，整个 terminal 文件 **77/77、exit 0**，fail/cancel/skip/todo 均为 0。原 RED/GREEN 日志分别为 `U-office-terminal-timing-incrementing-red-20261005.log`、`U-office-terminal-timing-incrementing-green-20261005.log`、`U-office-terminal-timing-full-green-20261005.log`，保留在忽略的 `output/e6-20260928/`，不上传。
- 这是测试夹具修复及本地 Core 验证，不代表当前 Core 全套、safe settlement、迁移 150、daemon restart 或 packaged GUI 已验收。原 32 项输入清单中的 terminal 测试已改变，不再宣称原整份清单全匹配。
- 下一实施片为 role-specific evidence/settlement、闭合 schema 与原 parent/producer 原子 safe/fan-in。迁移 150 在本保存前尚未落盘，不包含在此提交内；creator-bound directory receipt、固定 production route、live/restart/answer recovery 及 fresh packaged macOS 联验仍待完成。

公开 U gate 仍关闭，D0/E1–E6、U/T、Harness 完整目标仍 active。远端保存完成以正常 push 终态及 branch/PR HEAD 独立读回为准；保存不等于合并或正式交付。

## 前次 checkpoint 增量（2026-10-05；Office terminal manifest 与历史 replay WIP）

用户要求将当前进展追加保存到既有 Draft PR #507。上一远端保存点 `47b0c332baf70416bef54f6b9cea4308c2f49ba6` 保留；本次仅保存源码、测试和本记录，不合并 main、不改版本、不重写历史。**这是包含已知失败的 WIP 备份，不是发布或可合并候选。**

- 新增严格 terminal manifest 类型、完整 effects/member/resource/readRef/workspace 事实校验，以及 `sealHostOfficeLocalTerminal` / `getHostOfficeLocalTerminal` 接口。原 ticket 与原 parent/producer pair 才能封口；有效 claim 在写入前锁存，rollback 或 COMMIT 返回丢失后不重新开放 effects，只允许原票相同 claim 重试。
- Daemon 从原 execution owner 与 SQLite effects 全集生成独立 terminal artifact，不用 writer 文本作为安全证据。最终 root 独立检查原 dev/inode、目录与非 symlink；同 hash 外部文件节点替换不能返回成功。物理 `published` 与 `terminalSealConfirmed` 分轴保留，不篡改真实发布事实。
- 新增纯 Core `verifyOfficeLocalReplay`，只消费 sealed 历史、不读取当前磁盘、不重新打开 FD。覆盖实际短写、offset、fsync/close、recovery/temporary/publication、原节点身份、完整只读资源及最终成员顺序。它返回验证数据，不颁发 capability 或 journal safe settlement；失败、unknown、Host unconfirmed 仍拒绝安全完成。
- 真实 SDK/create/short-write/overwrite 测试在最终 target 被改写并删除、SQLite 重新打开后验证历史；这不是 daemon restart recovery 或 packaged GUI 验收。initial-absent directory 的 creator-bound receipt 尚未实现，不能永久删去该功能或凭 post-mkdir lstat 授权 cleanup/safe。
- 已收取冻结输入的两个最终测试进程：Core terminal/replay/facts **329/330、exit 1**；Daemon writer/resources/snapshot/open-resource-clock/Tracker **104/104、exit 0**。32 项 source/test/dist 输入再次 `shasum -c` 全部一致，结果不能标成全绿。
- 唯一已知 Core 失败为 `host-office-local-terminal.test.mjs` 的 “Office final member content observation precedes close; readRef completion need not equal member observation”，抛出 `host_office_local_evidence_invalid`。原因尚未确认；原失败测试和日志保留，本次不删除、跳过或放宽断言来制造通过。
- 本次保存前 Core、Daemon TypeScript `--noEmit` 均实际 exit 0；迁移 149 的既有实现不在本增量内。详细本地日志为 `U-office-terminal-replay-core-final-20261005.log`、`U-office-terminal-replay-daemon-final-20261005.log`，输入清单为 `U-office-terminal-replay-inputs-20261005.sha256`，均在忽略的 `output/e6-20260928/` 内，不上传。

**下一实际入口：** 先解决并验证上述 Core 失败 → role-specific Office evidence/settlement、新闭合 schema 与 typed journal consumer → 原 parent/producer 同 `BEGIN IMMEDIATE` safe/fan-in → creator-bound directory receipt → 固定 production Office route → live executor、retained restart、answer continuation/ACK/delivery/recovery/API/UI → fresh packaged macOS Computer Use 联验、最终全套源码门禁与正式 combined review/CI/merge。

公开 U gate 仍关闭；D0/E1–E6、U/T、Harness 完整目标仍 active。本次不修改根 checkout、同事 WIP、真实数据库或历史，不上传密钥、安装包、截图或忽略的 output；保留本分支所有先前保存点。远端保存成功需推送后的 branch 与 PR HEAD 独立读回，不能仅凭本地提交声称完成。

## 前次 checkpoint 增量（2026-10-04；原始身份、资源与 terminal migration149）

提交推送前的远端保存点为 `c46084ef6f6884f6b37746c2ca705e35db4a0ec3`；用户授权将本节增量追加保存到现有 Draft PR #507。仅正常快进，不合并 main、不改版本、不重写历史，保留所有已有保存点。

- 所有 refresh/final read FD 在首次 fstat 前进入原 execution owner；read 有独立 lifetime/readId 与 close 返回事实，不伪造 Host effect，也不进入 effect cleanup。未知 close 不重试、不 fstat，最终观察失败不得返回 `published`。
- Prepared seal 必填捕获的 `workspaceIdentity`，ledger 不采纳后来替换的 root。原 write open 的首次 FD identity/time 通过 `openResource` 进入不可变 effect observation；首次 fstat 失败只保留实际 native 返回，后续 cleanup 不回填原 seal。
- 三个真实墙钟回拨反例已经修复：读 open 后、读 finally close 前，以及原 write FD 首次身份采样。只让 Host 观察时间不倒退，不改 primitive native 返回时间，不放宽 Core 的严格校验。
- 新合同定向 **48/48**、完整 Office facts **159/159**、完整 Core **1473/1473**，实际 exit 0，1171 个 Core 输入指纹前后一致；这些是 migration149 接线之前的输入，不冒称新 migration 的完整 Core 门禁。
- Daemon 全套 **2828/2828**、实际 exit 0，输入指纹已核对；它在最后一项 write-open clock 修复之前完成，不能冒称证明最终增量。最终该反例 **1/1**、Office/Tracker 完整相关矩阵 **92/92**，实际 exit 0，20 个消费输入指纹一致。最终整体 Daemon 门禁仍留到下一联合候选收口，不重复旧测试冒充进展。
- 独立审查所发现的 clock 缺口均已真实 RED→GREEN；最后 changed-lines 复核无新增确认 finding。这不是 whole-file safe verifier 或整个 E6 验收。
- migration149 已完成源码、统一 Core 构建及新测试 **51/51**，实际 exit 0、fail/cancel/skip/todo 均为 0，12 项 source/support/dist 输入指纹前后一致。独立 append-only terminal 表及封口后 effect INSERT/UPDATE 屏障覆盖 replacement、跨 execution 冲突、recursive_triggers off/on、rollback 和原 147/148 保留；不重建旧表、不合成 terminal 或授予 safe。这是隔离 schema/真实 fresh-store 注册测试，不是 live Office terminal 验收。
- 本次保存前 Core、Daemon TypeScript `--noEmit` 检查均实际 exit 0。只读增量审查未确认误删、无关 WIP 或凭据混入；只审查 checkpoint 保存风险，不冒称全仓正式 pre-landing review。

**直接下一项：** typed complete terminal manifest、原 ticket/pair 持久封口 API、纯 Core whole-file replay verifier、role-specific evidence/settlement、原 parent/producer 同事务 safe/fan-in、固定 route。migration149 不重复实现或重跑；最终联合 full suite 仍须绑定后续最终源码。

公开 U gate 继续关闭。created directory 的 creator-bound receipt、live executor/restart、answer continuation/ACK/recovery 及 fresh packaged macOS Computer Use 联验仍须完成；不靠 writer 最终 hash/成功文字洗成 safe，不改真实数据库，不改根 checkout。这次只追加本次授权的新增保存点，不上传密钥、真实数据库、安装包、截图或忽略的 output。完整本地证据索引：`output/e6-20260928/U-OFFICE-IMMUTABLE-IDENTITY-READ-CLOSE-GREEN-20261004.md`、`output/e6-20260928/U-OFFICE-TERMINAL-MIGRATION-149-20261004.md`。

## 前次增量保存（2026-10-04；close-return / Host COMMIT 回归）

用户要求继续向现有 Draft PR #507 推送一次防丢保存。上一保存点 `586707fa4cb6482e463a9a12f27cdcd8925c105b` 保留；只追加测试及本记录，不改生产源码、不合并 main、不改版本、不重写历史。

- `office-local-writer.test.mjs` 新增两例：真实 native close 返回后，SQLite COMMIT rollback，以及 COMMIT 实际完成后抛错。测试增量为 76 新增、0 删除。
- 原生 FD 真正 close 后，由 OS 重新打开同一 inode 并复用同一数字 FD；断言失败清理不重复 close、借用 FD 仍可读完整 SDK 字节。close 实际调用和 effect row 均为 1。
- native returned 与 Host unconfirmed/EIO 分轴保留，resource 保持 closed；原 parent/producer 仍 launched、无 settledAt、保留两个 blocker，不获得 no-start/safe，不发布 target，不允许原 plan 重跑。
- Node 22.22.1 命令：`node --test --test-concurrency=1 --test-name-pattern='Office close-return Host COMMIT' packages/daemon/test/office-local-writer.test.mjs`。实际 **2/2 GREEN、exit 0**，fail/cancel/skip/todo 均为 0。作者测试已结束，无待收取 handle；Root 与独立只读审计核对 TAP 和当前六项指纹一致，复用本次冻结证据，不重跑旧矩阵。
- 本次没有产品 RED，因此没有为备份修改生产实现。未新增 null/undefined throw 回归，不称该故障输入已验收。
- 两份详细本地证据 `U-OFFICE-CLOSE-RETURN-HOST-FAULT-20261004.md` / `U-office-close-return-host-fault-20261004.log` 位于忽略的 `output/e6-20260928/`；这里只保存摘要，不上传真实数据库、安装包、日志或密钥。

已核对的输入 SHA-256：

```text
94779fb8cddfee4545fdcffa2d8e3057d8ced1f7d4f6a6dfba5c656b3ddd95f0  packages/daemon/test/office-local-writer.test.mjs
042bbd08ee83b8c01b2e8c36da806f4e942972ccba008dbcab2926e5393ca40b  packages/daemon/src/features/office-documents/office-local-writer.ts
46dde34295d2c63872b184b51c0af17bb1b942a805eb576c6822030ad3a7df97  packages/daemon/src/features/office-documents/office-local-resources.ts
2d75136a24e27235fd84529e82c058d95e1badbe3a685035c89c7d20f0c0145d  packages/daemon/dist/features/office-documents/office-local-writer.js
66bfecc49be0298329c29bd97913de37c9fa4f52b1f2fefdf6a4abad3318ab5b  packages/daemon/dist/features/office-documents/office-local-resources.js
05a91951083ae3bebb800b29552d3ef41200b2b7e27a4b2d2ed9d004ca6183a8  packages/core/dist/storage/sqlite/host-office-local-store.js
```

**未完成边界：** 相关完整 Daemon suite、完整 terminal verifier、原 pair 原子 safe 封口/fan-in、固定 production route、restart/drain 和 fresh packaged macOS GUI 仍未完成。公开 U gate 关闭，总目标 active，备份不等于发布验收。

本轮只读 terminal 接点审查指出，实施前须补原 open FD identity 的不可变事实、受 owner 管理的 final readback lifetime/close-returned、prepared workspace root identity；最终 hash 或 writer `published` 文本不能代替这些事实。terminal 应独立不可变存储，封口后拒绝追加 effect，原 parent/producer 必须同事务完成。旧 patch verifier 不放宽。不存在 creator-bound receipt 的 absent directory safe 策略及 readback owner 具体接法仍是实现决策，不把审查建议冒称已落代码。

下一实际入口：补齐上述事实链与 terminal 合同 → 纯 Core whole-file replay verifier → 原 pair 原子封口/fan-in → 固定 route与相关完整测试 → 原总计划后续真实验收。不重做已验收切片。

## 前一次增量保存（2026-10-04；586707fa writer clock 与资源回归）

用户要求再次推送现有 Draft PR #507 保存。只追加代码防丢检查点，不合并 main、不改版本、不重写历史；上一保存点 `759e1cc2ccb338715d470612a0e45b3bb4ec46a0` 完整保留。

- 本增量仅包含 writer、writer 回归、新 resource owner 回归及本记录。没有新增全文件删除，也没有新增兼容 fallback；旧 fixtures 直接改为 `resources`、同一 `resourceLifetimeId` 和 native/Host 分轴合同。
- 已复现 seal 时间顺序缺陷：递增 Date 的真实 SQLite/SDK 回归在原代码 **0/1、exit 1**。writer 改为一次采样 `completedAt`，同时用于 effect artifact `createdAt`；不放宽 Core 校验，不改 native 实际返回时间。
- 当前 writer/snapshot/Tracker 联合矩阵实际 **51/51 GREEN、exit 0**，fail/cancel/skip/todo 均 0；运行前后 writer source/test/dist SHA 相同，保存前再次读回相同。
- 新 resource owner 真实 FD 回归实际 **11/11 GREEN、exit 0**，fail/cancel/skip/todo 均 0；覆盖同 inode 同数字 FD 复用、unknown close 禁重试/fstat/cleanup、首次 fstat 失败保留持有、clone/跨 owner 借权拒绝和三终态 lifetime 不复用。运行前后 source/test/dist SHA 相同，保存前再次读回相同。
- Daemon TypeScript 构建、两测试文件 Node 22.22.1 语法检查与 diff check exit 0。只读窄审查未发现阻止 Draft 保存的 P1/P2；这不是全仓正式 pre-landing review。
- 早期七项矩阵 **7/8** 和首个联合矩阵 **50/51** 的失败日志仍保留；失败项是错误 message/code 断言未对齐，已使用实际 `attempt_host_operation_launched_no_start` code。首个联合命令的尾部 shasum exit 不作为 suite 成功，最终矩阵独立保存真实 suite exit。
- **真实 writer close-return 后 COMMIT rollback/post-COMMIT 故障联测、相关完整 Daemon suite、restart/drain、完整 terminal verifier、safe 封口和固定 production route 尚未完成。** resource owner 的 Host callback 单测不冒称 COMMIT 集成。
- 本次没有 fresh packaged macOS/GUI 验收。公开 U gate 仍关闭，整个 D0/E1–E6、U/T、Harness 目标仍 active。密钥、真实数据库、安装包、截图和忽略的 output 不上传。
- 推送前正常执行凭据扫描及既有 pre-push，推送后独立读回 branch/PR HEAD；未读回前不声称远端保存成功。

下一实际入口：补真实 writer close-return/Host COMMIT 故障回归 → 相关完整 Daemon suite 及窄审查 → complete terminal manifest/纯 Core whole-file verifier → 原 parent+producer pair 原子封口/fan-in → 固定 route → 原总计划后续真实验收。不重复已验收切片。

## 前一次增量保存（2026-10-04；759e1cc2 native writer/resource WIP）

用户再次授权将当前新增代码推送到现有 Draft PR #507。仅追加防丢检查点，不合并 main、不改版本、不重写历史，不把保存成功当作实现完成。

- 上一远端保存点：`a06e20138e76db0a96ac9c2d9657aa128ca926f3`，已有 ancestry 保留。
- 本次仅保存 Core facts 测试语义修正、Daemon native writer、独立 resource owner 和本记录。原 Descriptor 逻辑迁入 resource owner，不是删除功能；没有新增全文件删除。
- Core 新合同已经统一构建，原严格反例 **15/15 GREEN**、完整 facts **111/111 GREEN**，均 exit 0、无 fail/cancel/skip/todo；source/test/dist 指纹前后一致。Core 测试文件指纹本次再次读回一致，复用既有证据，不重复跑相同套件。
- Daemon writer 已落原 native 返回点锁存、实际短写/零进展失败及 native/Host 分轴；resource owner 已落原对象能力、强持有、open/close effect lineage、unknown close 不重放。保存前 Daemon TypeScript 构建实际 exit 0；测试语法检查、diff check exit 0。
- **Daemon 新合同故障联测和资源模块全集尚未执行**；Tracker/旧 fixtures、restart/drain 接线、完整 terminal verifier、safe 封口及固定 production route 未完成。旧 2780/2780 不用于证明本次实现。
- 独立只读审查指出尚待处理的时间顺序风险：effect seal 先取 `createdAt`、payload 后取 `completedAt`，跨毫秒可能被严格 Core 拒绝。本次忠实保存 WIP，不隐藏该缺口，不为了备份改动生产逻辑。
- 公开 U gate 仍关闭，无 safe receipt、新包或本次 packaged GUI 验收；整个 D0/E1–E6、U/T、Harness 目标仍 active。新密钥、真实数据库、安装包、截图及忽略的 output 不纳入本增量。
- 推送前扫描当前增量，正常执行 pre-push；推送后读取远端 branch/PR HEAD 校验完整 SHA。实际终态写入本地接续入口，不提前声称远端保存成功。

下一实际入口：修正 seal 时间顺序并运行 Daemon 七项故障合同与资源回归 → fixtures/Tracker/restart-drain → 相关完整套件及独立窄审查 → 完整终态/纯 Core verifier → 原 pair 原子封口/fan-in → 固定 route及总计划剩余真实验收。不重做已验收切片。

## 前一次增量保存（2026-10-04；a06e2013）

用户要求将当前进展再次推送到现有 Draft PR #507。本轮只追加 WIP 防丢保存，不合并 main、不发版、不重写历史；已有保存点不重复推送。

- 上一远端保存点：`90d9af8969fd131d85610fa54065d1d0b56414b7`。
- 新增范围为四个源码/测试路径及本记录：Core `host-office-local-records.ts`、新纯校验模块 `host-office-local-observations.ts`、`host-office-local-facts.test.mjs`，以及 Daemon `office-local-writer.test.mjs`。
- Core 严格校验已落源码：resource lifetime、native/Host 分轴、实际 bytesWritten、immutable seal 的 lineage/时间/精确字段边界；直接拒绝旧单轴格式，不新增兼容回退。新模块只验证事实，不赋予 safe/settlement 权威。
- 本轮保存前两个测试文件的 Node 22.22.1 语法检查及 `git diff --check` 实际 exit 0；**没有统一构建新 Core/Daemon，也没有新源码 GREEN 或 packaged GUI 验收**。
- 已收取旧构建反例终态：Core 的 15 项严格合同反例 **0/15、exit 1**（均是应拒绝而未拒绝）；Daemon 的 7 项 native-return/短写/COMMIT/首次 fstat 反例 **0/7、exit 1**（目标断言失败）。这些 RED 留作后续修复证据，不改成通过。
- Daemon writer/Tracker/resource consumer 尚未适配。本轮增加的 Daemon 测试描述目标行为，不表示实现已完成；旧 2780/2780 仍只覆盖 `1d19a401`，不覆盖本保存点。
- 未纳入真实数据库、密钥、安装包、截图或忽略的 output 产物；没有删 WIP、没有改根 checkout。PR 保持 Draft，公开 U gate 保持关闭，无 safe receipt、固定 production route 或整体 E6 完成声明。
- 推送后由远端 branch 和 PR HEAD 双读回确认，再把完整 commit hash 记录到本地 `output/e6-20260928/CONTINUE-HERE.md`；未读回前不声称远端保存成功。

接续不变：统一构建并核验 Core 严格 parser/fixtures → Daemon native 返回点锁存、短写和强持有 resource lifetime → 完整终态及纯 Core verifier → 原 parent+producer pair 原子封口/fan-in → 固定 route。总目标仍 active，不重做已验收切片。

## 前一次增量保存（2026-10-04；90d9af89）

用户再次要求推送到现有远端 Draft PR 保存一次；继续使用 `codex/e6-safe-continuation` 和 PR #507，不合并 main、不改版本、不重写历史。

- 上一远端保存点：`76600b95676552b98614955f022b3bc02f2265dc`。
- 本次追加已本地提交的 `1d19a401a41288aeac76e0e6ce7da9e168839205`：Office 成员清理、固定预算读取、FD close ownership 和目录残留策略。该提交的定向 **24/24**、独立 Tracker **1/1**、Daemon **2780/2780** 证据见 `office-local-writer-verification-2026-10-04.md`；下方旧 writer RED 状态仅作为历史记录，不再作为当前修复状态。
- 另保存当前 `host-office-local-types.ts` 的**未完成合同升级**：增加 Host `resourceLifetimeId`，将 native syscall 结果与 Host transaction outcome 分轴，并定义实际 `bytesWritten`。Core records/parser、测试夹具、Daemon Tracker/writer consumer 尚未适配；不能称合同已接通、可构建或验收通过，旧 2780/2780 不覆盖这份新合同。
- 本次新增保存范围仅上述源码/测试/文档；未纳入新的真实凭据、数据库、安装包、截图或忽略的本地运行产物。没有删除 WIP，不改真实数据库或历史，不跳过 pre-push 凭据检查。
- PR 保持 WIP/Draft；本次仅防丢备份，不构成安全完成证明、production route 上线或整个 E6 完成。公开 U gate 继续关闭，未知效果不标为 safe。
- 推送成功必须由远端 branch SHA 和 PR HEAD 双读回确认；最终 hash 写入本地 `output/e6-20260928/CONTINUE-HERE.md`。该本地证据目录仍不在远端备份范围。

保存后直接继续：严格 Core parser/fixtures → Daemon native-return latch、实际短写和 resource lifetime → complete terminal/纯 Core verifier → 原 parent+producer pair 原子封口/fan-in → 固定 route。既有时长/H2/R03/MCP/Media/Reviewer 切片不重复执行。

- 实施分支：`codex/e6-safe-continuation`。
- 提交前 HEAD：`3ffd26818bb399c5bf7350ed38a14e6db0d26ed1`。
- 保存范围：该专用工作树当前全部非忽略源码、测试、设计、语言目录、锁文件及已有 tracked 证据图片。原清点 572 路径，其中 203 个新文件；另加入本记录。
- 本地保存步骤未改根 checkout、未更换分支、未合并 main、未推送/创建 PR、未改真实数据库/历史。用户随后另行授权远端草稿 PR 备份，见下方补充。
- 唯一既有文件删除是旧 `apps/web/e2e/ui2-channel-proposal-input-migration.spec.ts`；它在本次保存请求前已处于删除状态，本次没有额外删代码。旧版本仍可从父提交恢复。

## 已核对的最新证据

- Office local Core facts：Node 22.22.1，完整 **41/41**，0 fail/cancel/skip，exit 0。
- Office preparation：作者隔离构建，真实 SDK **115/115**，0 fail/cancel/skip，exit 0。
- Snapshot reader：此前 **12/12**，本次独立静态窄复核无剩余确认 finding。
- Office typed enum 与同步 pre-effect 合同：分别真实 RED → GREEN **5/5** 和 **3/3**；原失败日志保留。
- 本次 Daemon TypeScript build exit 0；`git diff --check` 通过。
- 上述是不同源码范围的证据，不能拼成当前全仓完整验收。当前安装 QA 包不含这些最新 U 增量；本次没有新包或 GUI 验收。

## 必须继续处理的当前 Office writer WIP

新增 fixed writer / private reservation / member ledger / Tracker 接线仅到观察层。未接 production route，未颁发 safe receipt，公开 U gate 仍关闭。

1. Member ledger 将外部替换 inode 误收编，故障清理可能删除外部文件；实际隔离文件反例已 RED。
2. 写后 member 读取使用 path `readFileSync`，缺硬预算；禁止无界读取反例已 RED。需固定 descriptor/bounded read。
3. Tracker caller `mode` 与 Core descriptor 未绑定的反例已 RED。修复已落盘，但**尚未运行该修复 GREEN**。首次该反例缺 required kind 是夹具错误，另保留纠正后的实际 RED。
4. 原 FD 的 open 后 observation/fstat 失败、close 抛错后的不重放、retained lifetime/资源清理仍须补齐。
5. 实际 `bytesWritten`、FD lifetime、完整 member finalization、纯 Core whole-file verifier、原 pair 原子封口/fan-in、精确 route 仍须实现。
6. Node path 检查不等于抵御 hostile ABA 的 descriptor-relative OS 原语，不可在验证前声称原子路径安全。

当前 writer 初始矩阵 **2/4 pass、2 fail**，不是 GREEN；新增 Tracker mode 实际反例 **0/1**。本保存提交包含这些尚未收口代码和失败测试，不能作为合并/发布候选。

## 后续执行顺序及禁止重做项

接续先处理上述已复现缺口 → 完整 Office local writer/verifier/route → live Office/Cua/Chrome receiver enforcement 与借用资源隔离 → retained restart → answer continuation/ACK/delivery/recovery/API/UI → fresh packaged macOS Computer Use 联合验收 → combined review/PR/CI/merge。

时长、H2、R03、历史 diff、Media、ordinary MCP HTTP、tracked stdio、Reviewer 已验收切片不得重复当作新进展。三种会话统一组件和原始 evidence 边界保持。总体 D0/E1–E6、U/T、Harness 目标仍 active。

## 本地证据位置

详细入口是本工作树 `output/e6-20260928/CONTINUE-HERE.md`，并参照 `U-OFFICE-LOCAL-FACTS-20261004.md`、`U-OFFICE-PREPARATION-FROZEN-20261004.md`、`U-OFFICE-TERMINAL-VERIFIER-CONTACT-20261004.md`。

`output/` 内日志、截图、打包产物等仍保留在本地，按原忽略规则**不纳入这次代码提交**。不能把此 Git 保存点称为所有本地数据/测试数据库/安装包的备份。

仓库安全扫描的 4 个命中已逐项核验为测试假值或 `Users` Unicode 正则误报：两处 getter 第二次读取 sentinel、一处顺序字符构造的脱敏测试假 key、一处 `Users` 正则。本地保存步骤未放宽扫描器或改动冻结夹具；没有把运行凭证写入提交。该历史扫描不能标为 GREEN；后续收口验证单独记录。

## 后续授权：远端 Draft PR 备份

- 原本地保存提交 `c051c30ef0d747a8046eb98807cc4f9fad3b186a` 保留，不 amend/reset。
- 用户授权推送同一实施分支并创建 Draft PR；不合并、不改 main、不改版本、不作为发布候选。
- 第一次推送被 pre-push 凭证扫描拦住，远端没有创建分支。两个命中均为测试合成值：带密码 URL 的拒绝夹具，以及 sealed snapshot/public diff 的脱敏假 key。
- 用明确的 `PLACEHOLDER`/`EXAMPLE` 假值替代，保持非空 URL 凭证拒绝和 OpenAI-shaped redaction 测试语义；不放宽扫描器、不加入 allowlist、不跳过 hook。
- 测试夹具清理只覆盖这两个测试文件。不会改变上述 Office writer 缺陷、生产 route 或 GUI 验收状态。
- Node 22.22.1 的这两个测试文件定向回归实际 **29/29**，0 fail/cancel/skip，exit 0；`git diff --check` 通过。这不是全仓门禁或最新 packaged GUI 验收。
- 推送/PR 的真实结果、完整 head hash 与 focused test 日志在本地接续入口读回记录；没有远端读回前不声称已备份。
