# E6 本地 WIP 保存点（2026-10-04）

此提交是用户要求的**代码防丢保存点**，不是可发布版本，不代表整个目标通过。

- 实施分支：`codex/e6-safe-continuation`。
- 提交前 HEAD：`3ffd26818bb399c5bf7350ed38a14e6db0d26ed1`。
- 保存范围：该专用工作树当前全部非忽略源码、测试、设计、语言目录、锁文件及已有 tracked 证据图片。原清点 572 路径，其中 203 个新文件；另加入本记录。
- 不改根 checkout，不更换分支，不合并 main，不推送，不提交 PR，不改真实数据库/历史。
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

仓库安全扫描的 4 个命中已逐项核验为测试假值或 `/Users/u` 正则误报：两处 getter 第二次读取 sentinel、一处顺序字符构造的脱敏测试假 key、一处 `Users` 正则。这次不放宽扫描器或改动冻结夹具；没有把运行凭证写入提交。对外提交前仍应收口扫描误报。
