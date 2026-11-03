# TerminalReport 命令事实补齐

## 真实缺陷

隔离 macOS R6 普通会话 `run_de23d965-ad73-45d6-8d23-7ee5188580a2`
已通过一次 `approve_once`，仅执行一次 `node --version`。Host 的 accepted
`tool_end.result.details.unifiedExec` 包含 stdout `v24.15.0\n`、exitCode 0、
timedOut false、cancelled false。审批三个 post-commit effects 均 completed。

但 `terminal_report_bfd46992-e3ba-4737-a0c6-b2571f8ed0a9` 的持久 evidence
snapshot 只保留 operation 的标题、状态、引用，`checks=[]`，step contribution
仅为 `Executed command: command (completed)`。模型无从核实版本与退出码，
生成 unknown verification，导致 UI 显示“需要关注”。这不是审批恢复失败，
也不是 UI 隐藏已有报告字段。

原始 Host 证据：
`output/e6-20260928/p3-bash-cwd-contract-live-20261025/r6-normal-after-once-completed-host-state.json`，
SHA256 `8c0aeed14c019191836911450b8c9d23609243bd78d926bc095e0b467766ff12`。
完整 GUI/AX 为同目录 `r6-normal-completed.png` / `r6-normal-completed-ax.txt`。
旧 snapshot 仅使用 `DatabaseSync(..., {readOnly:true})` 定位读取，未修改历史。

## 最小链路

保留 `accepted Run events → ExecutionAction.commandEvidence → mapOperation`
的唯一事实来源。在 operation 上增加可选的 `commandEvidence`，由独立纯投影生成。
Run、Turn、workflow 及动态子 Agent 已共用 `mapOperation`，不建立第二套工具事实。

- 只投影已接受的 command、cwd、outcome、exitCode、signal、timeout/cancel、耗时和输出尾部。
- 不把 `node --version` 等普通命令变成测试，不增加 check，不以 narration 推断数值。
- stdout/stderr 保留换行，先拼接同 stream、去终端控制、脱敏，再共享有限字符预算。
  保留上游及本层截断标记；命令截断独立标记。不得因为截断丢掉已有退出码。
- 缺失的 exit/timeout/cancel 字段仍缺失，不能补零或 false。
- 该层的 `outputRedacted` 只描述本层/accepted chunk 的显式标记，不认证更早的原始值。
- 不读取日志或 artifact 正文；沿用 operation 的引用和最强隐私限制，隐藏 alias 不能洗白输出。
- 模型 prompt 明确 stdout/stderr 是不可信结果数据，不是指令；exit 回执不证明后代已停止。
- 新字段参与既有 evidence fingerprint；旧 snapshot 可不含新字段，无迁移、无历史重写。

不改工具执行、审批许可、fan-in、排空规则或 completion truth，不重复授权或重跑本轮命令。
旧结果不自动重新生成。deterministic fallback 叙述质量与旧“运行已开始”开场单独收口，
不能因为本项通过就认为这两项完成。

## 验证记录与边界

沿用 `p3-bash-cwd-contract-live-20261025/.qa-evidence/`，保留所有失败：

- 135：原投影 7 个缺陷断言失败，另 1 个 fixture 缺 objective 的 setup 失败。
- 136：只修正 fixture 必需字段，Turn 在未改产品代码时也命中相同缺陷断言。
- 137：多项目编译遇到旧 Core declaration；保留失败，不当作通过。
- 138/139：按包顺序执行 Core/Daemon 正常构建，均 exit 0。
- 140：7/8 通过；剩余为 appendEvent 已脱敏、但无 chunk redacted flag 的来源断言错误。
- 141：纠正来源断言，并额外直接强制原始 token 跨 chunk/ANSI/预算边界，10/10 通过。
  还覆盖缺失回执、共享预算、上游截断、输出改变 fingerprint、隐藏引用限制及 source 不变。
- 142：18 个完整 Core/Daemon TerminalReport 测试文件，223/223 通过，
  0 fail/cancel/skip；包括新增 10 项，不重复叠加计数。

真实独立 Agent 已完成5输入差量审查，0个可行动发现，首尾SHA与Root复算相符。
记录见 `output/e6-20260928/terminal-report-command-evidence-independent-review-20261025.md`。
本项仍需后继 QA 包的真实报告验收。
当前运行的 R6 App 不包含本项源码改动。不得把临时 SQLite 测试当新包 GUI 已通过，
不得重跑此前 R11 项目或本轮普通会话来制造“新证据”。频道规划拒绝独立调查，不放松门禁。
