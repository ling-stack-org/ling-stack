# E6 本地 WIP 保存点（2026-10-04）

此提交是用户要求的**代码防丢保存点**，不是可发布版本，不代表整个目标通过。

## 最新增量保存（2026-10-04）

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
