# E6 本地 WIP 保存点（2026-10-04）

此提交是用户要求的**代码防丢保存点**，不是可发布版本，不代表整个目标通过。

## 最新增量保存（2026-10-04；close-return / Host COMMIT 回归）

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

仓库安全扫描的 4 个命中已逐项核验为测试假值或 `/Users/u` 正则误报：两处 getter 第二次读取 sentinel、一处顺序字符构造的脱敏测试假 key、一处 `Users` 正则。本地保存步骤未放宽扫描器或改动冻结夹具；没有把运行凭证写入提交。该扫描不能标为 GREEN。

## 后续授权：远端 Draft PR 备份

- 原本地保存提交 `c051c30ef0d747a8046eb98807cc4f9fad3b186a` 保留，不 amend/reset。
- 用户授权推送同一实施分支并创建 Draft PR；不合并、不改 main、不改版本、不作为发布候选。
- 第一次推送被 pre-push 凭证扫描拦住，远端没有创建分支。两个命中均为测试合成值：带密码 URL 的拒绝夹具，以及 sealed snapshot/public diff 的脱敏假 key。
- 用明确的 `PLACEHOLDER`/`EXAMPLE` 假值替代，保持非空 URL 凭证拒绝和 OpenAI-shaped redaction 测试语义；不放宽扫描器、不加入 allowlist、不跳过 hook。
- 测试夹具清理只覆盖这两个测试文件。不会改变上述 Office writer 缺陷、生产 route 或 GUI 验收状态。
- Node 22.22.1 的这两个测试文件定向回归实际 **29/29**，0 fail/cancel/skip，exit 0；`git diff --check` 通过。这不是全仓门禁或最新 packaged GUI 验收。
- 推送/PR 的真实结果、完整 head hash 与 focused test 日志在本地接续入口读回记录；没有远端读回前不声称已备份。
