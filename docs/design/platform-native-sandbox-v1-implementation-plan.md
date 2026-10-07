# Ling 原生沙盒 V1 实施计划

2026-09-09 产品边界已确认：采用尽力终止、显式停止未确认、阻止重叠执行；不放宽文件/网络
权限。旧的「任意后代必然停止」产品承诺与「待确认」状态由[七项闭环计划](channel-seven-execution-closure-plan.md)
取代。历史实机反例保留；本决策不表示硬链接保护、执行接线或安全续接已经通过。

状态：已纳入 Typed Transcript 联合计划；T0/T1-A 切片与 T2-A macOS 基础执行已验证，T2-A 两项安全边界实机失败，完整 T0–T6 尚未完成。范围：macOS 与原生 Windows；macOS 在本机验收，Windows 交由同事进行实机验收。

2026-09-07 实施续记：用户授权的 4 个 main 提交已受控 no-commit 整合到专用恢复分支；
HEAD 仍为 284f8c3c05f468a256adb4cee64c4455da834a4b，MERGE_HEAD 与重新查询的远端 main
均为 7679003189711eaceb1f57ef39f2c8937f22a215。WIP 保留，不提交/推送，不改同事工作区。
下列导入基线是历史记录；当前新增证据见 §9.1，不将原型或握手结果当成真实隔离。

2026-09-07 导入说明：原文来自任务「确认 Ling 沙盒与 Codex 处理方式」的未提交设计；来源文件保留不动。本文保留 T0–T6 和全部平台验收范围。实施基线为 284f8c3c05f468a256adb4cee64c4455da834a4b，远端 main 44f48cf85e6218b1e07213de588222ef9a7719a8 已核验为其祖先。与问答、N03、权限和统一 UI 的接缝以[联合设计](conversation-user-input-and-sandbox-integration.md)为准；不导入同事未提交的审批 UI。下文上游源码/文档核对结论是来源任务记录，本次导入未重新联网审查 Codex。

本计划基于当前工作区源码核对，基线为 `8b259da0ff4302b97c69f9ef65e221fd108e0ee0`。工作区已有其他 UI 与审批修改；实施时使用隔离工作树，按实际合入状态重新核对接口，不覆盖这些修改。

## 1. 结论与首版范围

采用与 Codex 相同的分层原则：权限策略决定边界，操作系统负责强制执行，审批处理明确的权限扩展。Pi 继续承担 agent 循环，Ling daemon 继续拥有上下文、任务、审批、事件、产物和恢复。

首版交付内容：

- macOS：Seatbelt / `sandbox-exec` 原生执行后端。
- Windows：参照 Codex 较强的原生方案，使用受限账户、受限令牌、文件 ACL、网络控制及子进程管理；不要求安装 WSL 或 Docker。
- 统一接管模型可调用的命令与文件工具，实际权限由 daemon 生成，模型不能自行指定绕过模式。
- 复用设置页已有的权限选择，增加真实生效状态和 Windows 初始化入口。
- 两个平台都交付实现、构建和验收脚本。Windows 实机结果由同事回传，缺少结果时单独标注待验收，不用 macOS 结果代替。

用户已确认 Windows 允许一次 UAC 初始化，首版采用 Codex 较强的原生方案。这是已确认的计划约束；实际初始化在 Windows 用户显式点击并通过系统 UAC 后执行，本轮不修改账户、ACL 或防火墙。

## 2. 已有能力及实际缺口

| 当前代码 | 已有能力 | 本次复用与修改 |
| --- | --- | --- |
| [ExecutionPermissionsSettingsPanel](../../apps/web/src/features/settings/ExecutionPermissionsSettingsPanel.tsx) | 默认授权 `ask/smart/always`；沙盒设置 `read_only/workspace_write/full_access` | 保留两个独立选择，修正文案、增加生效状态 |
| [SettingsPage](../../apps/web/src/features/settings/SettingsPage.tsx) | `approval-strategy` 页面已挂载上述面板 | 不另建重复设置页 |
| [session-permissions](../../packages/core/src/session-permissions.ts) | 独立授权与访问模式、旧权限预设兼容、运行策略快照 | 增加可执行沙盒策略编译；保留显式 deny 和旧数据兼容 |
| [workspace-settings-store](../../packages/core/src/storage/sqlite/workspace-settings-store.ts) | 工作区默认权限存储与旧字段迁移 | 复用已有字段，扩展必要的命令网络默认值 |
| [platform-native](../../packages/daemon/src/runtime/sandbox/platform-native.ts) | macOS 后端检查、Seatbelt 参数生成 | 补真实执行；替代依赖配置布尔值的“已验证”判定 |
| [unified-exec](../../packages/daemon/src/features/runs/unified-exec.ts) | 命令输出、取消、超时、审计与产物 | 替换直接 spawn 的执行入口，保留上层事件契约 |
| [patch-actions](../../packages/daemon/src/features/runs/patch-actions.ts) | 补丁预览、路径检查、符号链接检查、原子文件替换、产物证据 | 保留算法和预览；文件读取与最终写入经受限 worker 执行 |
| [runtime-permissions](../../packages/core/src/runtime-permissions.ts) | 有作用域的运行时授权、审批与 continuation | 增加命令网络／执行边界扩展的类型化 scope |
| [runner-pi resource-loader](../../packages/runner-pi/src/resource-loader.ts) | 工具注册与扩展接入 | 受限模式强制使用 daemon 管理的工具，不留 Pi 原始工具回退 |

当前缺口已经由源码确认：

1. `unified-exec` 最终仍直接 spawn；Windows 命令还固定生成 Bash 调用。
2. `platform-native` 对非 macOS 返回 unsupported；现有 profile 主要允许只读工作区与产物写入，没有真正实现工作区写入档位。
3. Pi 的 sandbox binding 目前传递描述和 readiness，未实际包裹执行；打开 enabled 或 verified 标志不构成隔离。
4. 文件 mutation 扩展仍存在调用原始 Pi 文件工具的路径；只改 Bash 会留下旁路。读取、搜索和补丁预览同样需要纳入文件边界。
5. 当前 `always + workspace_write` 仍要求 Bash 审批，原因明确写为“Pi 尚未 OS 隔离”。这条限制应在真实沙盒就绪后有条件解除。
6. [当前 CI](../../.github/workflows/ci.yml) 的主质量任务运行于 Ubuntu；不能证明 macOS 或 Windows 原生隔离有效。

## 3. 与 Codex 对齐到什么程度

### 3.1 参考来源与复用方式

核对的 OpenAI 官方文档：

- [Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security)
- [Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)

本轮核对的开源提交为 `a9896da3febcaf30e1c5d7b452fb6334b1a0bc51`：

- [macOS Seatbelt 实现](https://github.com/openai/codex/blob/a9896da3febcaf30e1c5d7b452fb6334b1a0bc51/codex-rs/sandboxing/src/seatbelt.rs)
- [Windows 沙盒依赖](https://github.com/openai/codex/blob/a9896da3febcaf30e1c5d7b452fb6334b1a0bc51/codex-rs/windows-sandbox-rs/Cargo.toml)
- [Windows 统一执行入口](https://github.com/openai/codex/blob/a9896da3febcaf30e1c5d7b452fb6334b1a0bc51/codex-rs/windows-sandbox-rs/src/unified_exec/mod.rs)
- [许可证](https://github.com/openai/codex/blob/a9896da3febcaf30e1c5d7b452fb6334b1a0bc51/LICENSE)

Codex 的 Windows 模块依赖其 protocol、PTY、路径工具和 telemetry 等 workspace crate，不能当成独立 npm 包直接装入 Ling。推荐固定上游版本，抽取必要的原生执行模块，配上 Ling 自己的薄协议适配层；P0 必须先证明依赖切割可行，再展开接线。

采用 Rust 原生 helper 来承接 Windows OS API，避免直接用 PowerShell 脚本模拟安全边界。macOS 由同一执行契约调用系统 `sandbox-exec`，不要求重写 Pi，也不要求用户安装 Codex 客户端。

若复用上游源码，保留适用的 Apache-2.0 许可证、版权和 NOTICE，标记修改，记录固定提交与本地补丁。Rust 依赖也要进入许可证与漏洞检查；当前 pnpm 许可证检查不会自动覆盖 Cargo 依赖。

### 3.2 首版刻意保留的 Ling 行为

- `ask/smart/always` 继续表示 Ling 的审批策略，不改名为 Codex 的配置枚举。
- `read_only/workspace_write/full_access` 继续表示访问范围，独立于是否自动审批。
- 完整访问沿用[现有会话确认契约](conversation-session-full-access-confirmation.md)，不另加每条消息弹窗，也不转成工作区永久授权。
- 保留只读模式当前对通用 Bash 的禁止；读取与搜索工具可以通过内部受限 worker 工作。首版不顺带扩大只读工具能力。
- 不新建 Guardian 自动审批模型、不搬整个 app-server、不改变 Pi 为默认 runner。
- 现有统一执行器不支持 PTY；首版仍明确返回不支持，不在沙盒项目中同时重写交互终端。

## 4. 执行架构与模块边界

```text
工作区默认值 / 当前会话选择 / 显式策略 deny
                         |
                         v
             Ling effective policy 编译
          访问范围 + 审批规则 + 有效 grant
                         |
                         v
              不可变 execution policy
                         |
Pi 工具请求 ---> daemon 审批与执行 broker
                         |
            +------------+-------------+
            |                          |
      命令执行 adapter             文件 worker
     argv / 系统 shell       read / search / edit / patch
            |                          |
            +------------+-------------+
                         |
               平台原生执行 backend
               /                    \
     macOS Seatbelt              Windows helper
               \                    /
                结果与受限输出通道
                         |
              daemon 事件 / 产物 / 审计
```

模块建议：

| 模块 | 职责 | 约束 |
| --- | --- | --- |
| `packages/core/src/sandbox/` | 纯策略编译、模式映射、路径语义与 scope 类型 | 从已有 sandbox-types 演进并保留兼容导出；不访问 UI 或 OS |
| `packages/daemon/src/runtime/sandbox/` | 后端选择、准备、执行、文件 worker、探针与生命周期 | 不承担会话或审批存储；通过依赖注入调用现有控制面 |
| `native/sandbox/` | 固定版本的原生执行能力、Windows 初始化与退出清理 | 无模型 API、无对话逻辑、无公开远程控制接口 |
| `packages/runner-pi/src/extensions/` | 将模型工具调用送入 daemon 管理通道 | 受限模式不得执行原始 Bash、edit、write 或读取工具 |
| `packages/contracts`、API client | 设置、状态、错误及执行证据 DTO | 描述有效权限，不接收模型提供的“已验证”证明 |
| `apps/web/src/features/settings/` | 现有选择器、状态与初始化交互 | 不展示底层后端选择，不直接启动 OS helper |

当前 orchestrator 约 1951 行、approvals 约 1171 行、unified-exec 约 889 行。新增策略、进程管理和文件 worker 放进上述专门模块，这些大文件只做接线，避免继续混入平台分支。

### 4.1 策略快照

建议生成 `ExecutionSandboxPolicyV1`，至少包含：

- `runId`、`attemptId`、`policyVersion`、`policyHash`；
- 访问模式、实际 workspace root、显式额外读写 roots；
- 受保护路径、专用临时目录、命令网络模式；
- 生效的审批／grant 引用、后端身份与版本。

模型只能提出工具调用和权限申请，不能提交已生效策略。daemon 根据已验证的工作区、会话和审批记录生成策略，执行器再次验证版本、路径及后端身份。

工作区设置默认影响后续新运行；不静默修改活跃进程的权限。当前任务的提权通过现有审批与 continuation 边界创建新策略。取消、授权过期或明确撤销会阻止后续调用并停止相关执行进程。旧 attempt 的回调不得写入新 attempt 的终态。

T1 策略编译细化：新增 Core 纯模块 `sandbox/execution-policy*`，不修改设置或审批存储。
输入只能由 Host 组装：当前 EffectiveRunPolicySnapshot、捕获的 workspace/run/attempt/fence、
toolCallId/operationHash/cwd、已解析的目录、后端制品身份，以及从既有审批记录核验后投影的调用级 grant facts。
grant fact 不是新的授权记录或模型可提交参数：必须绑定完整执行身份和 operationHash，明确批准状态与有效期；
Host 仍须在实际调用前重新校验撤销、当前 fence、审批 scope 并原子消费单次许可。纯函数不能证明数据库新鲜性。

编译器按现有三档和审批决定生成深冻结策略，保留 ask、显式 deny 和 Plan Mode 禁写。
不移除当前 always/workspace_write 的 Bash 审批限制，不把旧 snapshot 变成持久权限。
明确 full_access 必须提供既有确认，输出文件/命令网络不隔离；不提供伪装成 restricted 的全盘 roots。
受限模式默认断网；单次开放只绑定一个确切 command 调用。额外读写 roots 与网络许可互不替代。

路径模块仅做跨平台规范化与词法边界验证，拒绝 root workspace、越界基础写目录、UNC/device/ADS 和
Windows 歧义路径；Host/OS 后端仍负责 realpath、symlink/junction、volume/inode/父目录身份及并发替换。
默认保护 workspace 的 .git/.agents/.codex/.ling 写入，.ling 及 Host 指定秘密/状态目录禁止读取；
普通目录/network grant 不能解除这些默认保护；protected metadata 的显式限定操作授权仍由 T1-B/T4
接入专用 scope/worker 校验，不将本切片的普通目录 grant 当作元数据写入权限。Git worktree common dir 由 Host 加入保护集合。
每次运行的专用 temp 与 workspace/保护目录分离。目录集合排序去重，hash 包含权限、调用、授权引用、
后端身份、时间与 workspace policy revision；不包含模型凭据或任意叙述。

T1-A 的编译通过仅表示策略内容形成，不是审批已消费、后端 ready 或 OS 隔离成功。
后续 T1-B/T4 才将既有授权领域和实际 broker 接线；不得从 API/UI 接收自报的 grant facts 或 verified 标志。

### 4.2 命令与文件入口

- 受限运行强制启用统一执行入口，不能通过关闭旧 feature flag 回到 Pi 原始 Bash。
- 保留 `argv` 与 `shell` 两种命令。macOS 使用受控 shell；Windows 使用明确的 PowerShell 启动契约，处理 UTF-8、空格、引号与中文路径，不能把 Bash 文本盲目传给 PowerShell。
- `read/grep/find/ls/edit/write/apply_patch` 均经受限文件 worker。补丁预览读取也遵守同一读取策略。
- daemon 保留补丁规划、审批、原文件哈希检查与证据管理；worker 执行文件读取、落盘、删除和原子替换，避免将 SQLite 或密钥存储传入 worker。
- 去除受限模式下 `originalEdit.execute`、`originalWrite.execute` 等回退。遇到不支持的操作，返回具体错误。
- 通过继承的管道传递有长度限制的结构化请求和结果。原生 helper 不暴露任意调用者可访问的命令端口；禁止从项目目录或任意 PATH 寻找替代 helper。
- helper 身份、协议版本、文件哈希和父进程关系校验失败时停止，不能改用宿主直接执行。

## 5. 三档权限、网络与审批语义

| 访问模式 | 文件权限 | 通用命令 | 命令网络 | UI 状态 |
| --- | --- | --- | --- | --- |
| 只读 | 允许策略内读取；用户项目不可写；内部临时输出单独隔离 | 保留当前禁止通用 Bash 的行为 | 默认关闭 | 原生沙盒已生效／阻塞原因 |
| 工作区写入 | 可写当前实际 workspace 和明确授权的 roots；受保护目录除外 | 通过原生沙盒执行，依授权策略决定是否询问 | 默认关闭，可单次申请开放 | 原生沙盒已生效／阻塞原因 |
| 完整访问 | 不提供工作区文件隔离 | 确认后走显式完整访问执行路径 | 不提供命令网络隔离 | 完整访问，沙盒隔离已关闭 |

受限模式默认的文件边界：

- 写入只允许实际 workspace、显式 grant roots 和该运行专用临时目录。
- 默认保护 `.git`、`.agents`、`.codex` 及 Ling 内部状态；Git worktree 的 `.git` 指针和实际 common gitdir 一并处理。
- 编译器、运行时与必要库可按真实安装位置读取；凭据目录和 Ling secrets 默认不暴露。不要把“工作区写入”描述成自动隐藏整台机器的所有文件。
- 不直接授予 worker 整个 Ling artifacts 目录的写权限。结果经专用输出目录或管道回传，由 daemon 导入并记录可信来源。
- 新增、重命名、父目录替换、符号链接／junction／reparse point、大小写差异均按操作系统真实路径处理，不能只做字符串前缀匹配。

审批语义：

- `ask` 保持现有询问行为；`smart` 保持现有风控与审批决策。
- `always + workspace_write` 只有在原生后端真实就绪时，才移除“没有 OS 隔离所以必须问”的特殊限制；显式 deny、计划模式禁写和强制审批 profile 仍优先。
- “自动授权”不等于自动扩大沙盒边界。扩大目录、网络或切换完整访问，仍是独立、明确的权限操作。
- 首版网络只实现断网和单次命令开放网络，不把 domain allowlist 文案放到未实现的代理策略上。单次开放表示该次进程树可联网，不虚构域名级保证。
- 模型 API、搜索服务、MCP、浏览器和 Computer Use 不属于命令网络开关；继续使用各自权限机制，状态页说明实际覆盖范围。
- 如果命令执行到一半触发拒绝，不自动提权重跑整条命令，避免重复安装、写入或发送。返回失败证据，再申请明确的后续操作。

## 6. macOS 后端

1. 使用固定系统路径 `/usr/bin/sandbox-exec`，根据有效策略生成 Seatbelt profile。
2. 从当前原型演进到分别支持只读和工作区写入，处理受保护子目录、真实路径、运行时依赖及专用 tmp。
3. 审批后的额外目录／网络权限只进入新执行策略，不修改持久的全局策略。
4. 保留 stdout/stderr、超时、取消、进程退出与证据回传；取消时处理整个受控进程树，验证子进程不能通过脱离父进程绕过生命周期管理。
5. 后端 readiness 包括真实允许／拒绝探针，而不是只检查可执行文件存在或配置项为 true。
6. 探针缓存按后端版本、用户、策略和路径身份失效；每条工具调用不重复完整探针。

## 7. Windows 后端

推荐基线为 Windows 11 原生执行，构建目标与 Ling Desktop 发布目标一致；Windows 10 不在没有实测时宣称同等支持。

### 7.1 初始化与卸载

- `ling-sandbox-setup.exe` 负责管理员批准的一次性初始化；日常模型任务不以管理员身份运行。
- 使用 Ling 命名空间创建专用受限账户、配置必要权限及网络控制；任何上游账户名、状态目录、管道名都必须改成 Ling 独有标识。
- 系统修改有版本化清单，支持重复执行、失败补偿、修复与卸载。只清理 Ling 明确拥有的资源，不删除 Codex 或用户已有账户／防火墙规则。
- 初始化与修复由用户显式点击触发 UAC。拒绝 UAC 时保留“未初始化”，不执行失败的任务，不默默切换完整访问。
- 账户凭据与敏感初始化材料只存 OS 保护的机器本地存储，不进入 workspace、SQLite 审计正文、命令行参数或前端。

### 7.2 日常执行

- `ling-sandbox-runner.exe` 按有效策略启动受限进程，结合 restricted token、文件 ACL、网络控制和 Job Object 管理进程树。
- 账户只提供受限基线；每次执行仍有独立权限边界。并行运行 A 的目录／网络 grant 不得因为共享账户或全局 ACL 更新泄漏给 B。
- 管道访问控制、调用方身份、消息长度、命令参数和策略版本都要验证；不能把 setup helper 变成任意本地进程可调用的提权接口。
- 处理 PowerShell 编码、空格与中文路径、junction、UNC 路径、NTFS 重解析点和不可安全隔离的目录。首版不支持的路径应清晰拒绝。
- 对已知 Everyone 可写或其他 ACL 缺陷给出阻塞诊断，不能显示“已隔离”而允许穿透。
- 参考 Codex 的 private desktop 隔离方向；现有 Computer Use 仍走自己的宿主权限通道，避免把 GUI 自动化能力混入命令沙盒。

首版不默认提供较弱的 unelevated 自动回退。OpenAI 文档明确其网络边界弱于 elevated；如必须免管理员，需要重新确定安全目标和后端，不能只更改标签。

## 8. 设置页与用户流程

复用当前“设置 → 默认授权”页面：

```text
默认授权    [ 先询问 | 智能授权 | 始终授权 ]
沙盒设置    [ 只读   | 工作区写入 | 完整访问 ]

执行保护    已生效 / 未初始化 / 不可用 / 完整访问已关闭隔离
            [检查或修复] [查看诊断]

Windows 未初始化时：
            [启用原生沙盒]  首次需要系统管理员确认
```

- 不增加与现有三档重复的“启用沙盒”全局 toggle。Windows 的启用按钮只进行后端安装初始化，不是第二套权限配置。
- 保留当前分段选择器即可；截图的下拉外观不是实现沙盒的前置条件。如现有布局拥挤，后续独立调整控件外观。
- 网络默认关闭及单次申请先显示在说明和审批卡中，不额外增加未实现的域名配置界面。
- 普通用户只看到模式、是否生效、失败原因及可执行操作。Seatbelt、ACL、helper 版本等放入诊断详情。
- 区分“已保存的偏好”“当前机器后端就绪”“本次运行实际生效模式”。保存成功不等于隔离已经有效。
- Windows 初始化中禁用重复点击；窗口关闭后仍能读取初始化结果，不能只靠组件内存表示状态。
- 工作区默认值与会话覆盖继续复用现有存储逻辑。完整访问确认只作用于已确认会话 scope，权限变化后按现有规则失效。
- API 响应返回结构化 readiness／setup／execution 错误。CLI 与 Web／Desktop 必须获得相同事实。

## 9. 实施任务与依赖

下列步骤属于一个 V1，可分多个可审查变更交付；不是把 Windows 推到 V2。

| 任务 | 主要模块 | 依赖 | 完成标准 |
| --- | --- | --- | --- |
| T0：确定原生代码复用边界 | `native/sandbox/`、参考源码与构建配置 | Windows UAC 已确认 | 固定上游依赖闭包、许可证与 helper 协议；最小原生入口可构建；输出 Windows 构建与初始化契约 |
| T1：统一策略与契约 | core sandbox、runtime permissions、contracts | T0 协议 | 三档模式、网络和额外目录 scope、policy hash、旧设置迁移与显式 deny 测试通过 |
| T2：macOS 执行后端 | daemon sandbox、native runner 接口 | T1 | 真实命令允许／拒绝与进程树取消证据齐全 |
| T3：Windows 执行后端 | native Windows helper、初始化与打包脚本 | T0、T1 | 代码、构建脚本、setup／repair／uninstall、进程管理与测试程序全部交付 |
| T4：统一工具接管与审批 | runner-pi extensions、unified-exec、patch-actions、approvals | T1，结合 T2/T3 联调 | 所有纳入范围的工具无宿主旁路；审批、取消、过期、恢复不泄漏权限 |
| T5：现有设置接线 | settings UI、API client、状态接口、i18n | T1、readiness 契约 | 三档选择持久化、生效状态与 Windows 初始化交互通过 UI 验证 |
| T6：打包、验收与移交 | CI、Desktop/CLI 发布、测试脚本和文档 | T2—T5 | macOS 本机验收；Windows 测试包交给同事；两端状态分开报告 |

实施顺序：T0 → T1 → 平台实现／工具接管／UI 接线 → T6。契约稳定后，macOS、Windows、UI 可在独立工作树推进；共享 core/contracts 的变更先串行合入，避免分叉出不同策略解释。

本次在既有 typed-transcript 恢复工作树推进，不合并来源任务旧分支。当前完整访问确认与审批 Dialog 的 WIP 不作为沙盒任务顺手重写；T5 接入时核对已合入版本。原有数据读取/迁移的保留不意味着允许旧执行旁路；新受限执行不得 fallback 到宿主工具。

不在计划阶段给“几小时实现安全沙盒”的承诺。最大不确定性是 Windows 原生模块依赖切割、初始化兼容和系统策略；T0 完成后再估算剩余工作。

### 9.1 T0 协议与本机构建切片（2026-09-07）

[native/sandbox](../../native/sandbox/README.md) 已新增独立 Rust 最小入口，没有复制 OpenAI 实现。
重新只读核对固定上游 a9896da3 的 Windows manifest、session 入口与 LICENSE；
确认其依赖 Codex workspace 的 protocol/PTY/path/string/telemetry，不能直接当独立库装入。
这不是完整 Windows privileged 模块提取证明，也不是上游全部源码安全审查。

- 私有继承管道只处理一个有界 handshake 请求，严格校验 protocol/version/parent/nonce 和
  workspace/run/workUnit/attempt/runtime/fence；重复/未知字段、非法编码和超长/截断帧拒绝。
- 固定错误码不回显输入正文；只接受 handshake，不执行命令、文件操作或平台初始化。
  `executionSupported=false`、`enforcementReady=false`、capabilities=[]，不接入 daemon readiness。
- 固定 Rust 1.97.1 与 Cargo.lock，生成本机制品/源码/锁文件哈希和 14 项依赖、28 份许可证文本。
  构建入口拒绝覆盖已有目录、不安装全局工具；未审查依赖/许可证变化阻止制品清单生成。
- manifest 是本地构建证据，尚无认证的分发来源。链接器 ad-hoc 签名不等于发行签名；
  接受项目提供的 manifest/hash 不能证明 helper 身份，后续 launcher 必须绑定受信任打包记录。

| 本次检查 | 结果与边界 |
| --- | --- |
| Rust 协议单元 | 5/5，macOS ARM64 |
| 构建脚本单元 | 19/19，含依赖闭包/许可证/既有输出保护 |
| ARM64 release 真实 helper 进程 | 19/19，只有握手，没有沙盒命令 |
| macOS ARM64 / Intel release | 均真实链接成功；Intel 未实机运行 |
| Windows x64 | cargo check 通过；未链接 .exe、未运行 Windows |
| fmt / JS syntax / diff | 通过 |
| Clippy / 漏洞审计 / 发行签名 | 未运行或未验证；本机没有 Clippy，未擅自安装 |

完整日志、manifest 路径和二进制哈希见本次交接 (`native-sandbox-t0-handoff-20260907.md`)。
仍需：Windows 提取闭包及 setup/repair/uninstall owned-manifest 契约、可信打包身份，
T1 策略编译、T2/T3 真执行和停止证明、T4 全工具接管、T5/T6 UI 与原全部平台验收。
未解除 typed command/open capability gate，不把本切片登记为 S-01–S-06 联动通过。

### 9.2 T1-A 不可变策略编译（2026-09-07）

Core 已新增独立 types、paths、validation、compiler 四个小模块，公共 index 只增加两个导出。
不修改旧 readiness、session permission resolver、审批持久化、Pi 或 Daemon 执行入口。

- 编译完整 Run/WorkUnit/Attempt/runtime/fence + toolCallId/operationHash/cwd 绑定；generation 保留十进制字符串，
  不转 Number。策略按固定字段和排序去重的目录/grants 计算 SHA-256，输出深冻结且不共享输入引用。
- 复用现有访问/审批模式，保留 explicit deny、ask、只读禁命令/写入及 Plan Mode 禁写。
  旧已知权限字段可投影；没有独立模式的 custom snapshot 明确拒绝，不猜成可写。
- full_access 复用既有显式确认，输出 filesystem=null、network=unrestricted，不假装提供隔离。
- 普通目录和单次网络 grant facts 检查批准状态、有效时间、完整执行身份、操作指纹及 cwd；
  跨调用、过期、撤销和 protected scope 均拒绝。没有消费许可或证明存储新鲜性的副作用。
- 路径只做词法边界：拒绝默认写目录越界、前缀邻居、Windows drive-relative/UNC/device/ADS/歧义名称；
  专用 temp 不能与 workspace、保护目录或可信运行时库重叠。真实 symlink/junction/inode/race 仍待 Host/OS 验证。

初始 36/36 红测 → 36/36 通过；反向测试复现 4 项路径/目录集合缺陷，修复后专项 41/41。
Core 全量 652/652；Electron 44.1.1 内嵌 Node 专项 41/41；Daemon build pass，1491 项中
1484 pass / 原 7 fail / 0 skip，与上一轮失败集合 added=[]、removed=[]。
四个新编译模块 coverage line 99.10%、branch 95.92%、function 100%，仅为纯模块覆盖，不是端到端安全证明。
详细日志见策略切片交接 (`native-sandbox-t1-policy-handoff-20260907.md`)。

T1-B 仍需从真实现行审批记录和 canonical workspace/path facts 建立投影、接入额外目录/网络/元数据 scope，
在执行准入时校验撤销/expiry/fence 并消费一次性批准，再连接 T2/T3/T4。
当前普通模型请求不能提交本切片的 grant fact，helper 仍不执行命令，不解除原 7 项 capability gate。
原 S-01–S-06、macOS GUI、Windows 实机和全部联合验收仍未通过；不能将 T1-A 写成完整 T1 完成。

### 9.3 T2-A macOS 实机后端与未通过的边界（2026-09-07）

本切片只新增 profile、Host-only command launcher 和显式测试入口，没有接入产品命令执行、
改变 readiness 或删除原 capability gate。macOS 使用系统 sandbox-exec，不经过仍不执行命令的 T0 Rust helper。

- 固定系统执行器与 dyld-support.sb，检查 root ownership、不可 group/world write、非 symlink 与内容哈希；
  backend identity 同时绑定 OS release 与 bootstrap profile hash。Apple 将该 bootstrap 声明为 private OS interface，
  因此 OS 升级必须重新验收，不能永久复用一次 verified 结果。
- deny-default 下按策略开放工作区、可信 runtime read roots 和专用私有 temp；不放开整个 /tmp 或 /System。
  默认断网，只有绑定当前调用的 network grant fact 才生成允许网络的 profile。
- argv/shell、cwd、temp 和隔离环境进入 fingerprint。shell 固定 bash --noprofile --norc，不继承真实凭据。
  准备时捕获 canonical path/dev/inode/mode，spawn 前重验；同步 authority callback 必须由后续 Host 接线提供，
  测试中的 fixture noop 不是真实审批验证。
- prepared invocation 一次性启动；进程组 signal 仅作用于当前 launcher 拥有且 leader 尚未退出的对象。
  lifecycleScope=process_group、descendantStopProof=not_available，不能签发 U2 的完整 OS quiescence receipt。

macOS 26.5.2 / 25F84：正向与选定负向实机 smoke 17/17，非原生执行 CI 单测 36/36。
Daemon 全量 1527 项：1520 pass / 原 7 fail / 0 skip，失败集合相对 T1-A added=[]、removed=[]。
纯单测 coverage line 95.73%、branch 94.20%、function 95.45%，不代表 OS 或 App 覆盖率。
真实 smoke 覆盖 echo、shell/Node 写读、越界写拒绝、protected metadata、运行期间新建硬链接拒绝、
symlink、prepare-to-spawn 目录替换、单次网络授权和普通子进程取消。

**必验边界仍失败，不得把 17/17 写成完整安全验收：**

1. Host 在测试启动前将外部哨兵硬链接进工作区，命令通过工作区路径写入时修改了外部 inode。
   预先捕获根目录身份不能消除这种别名；单次全树扫描也不能被宣称为运行时竞争防护。
2. Node detached 子进程能在父进程组取消后继续运行。只 deny setsid/setpgid 与 process-info-setcontrol 无效；
   额外 deny posix_spawn 虽阻止此创建，也让普通 Node 子命令返回 EPERM，不能直接作为通用修复。
   本机 SDK sys/event.h 明确 NOTE_TRACK/NOTE_TRACKERR/NOTE_CHILD 自 macOS 10.5 起不再受支持，
   不可假定 kqueue 自动追踪后代就是可行替代。

[macos-boundary-smoke.mjs](../../native/sandbox/tests/macos-boundary-smoke.mjs) 保留两项真正失败的安全断言，
退出码 1；不是 todo/skip，不改哨兵断言凑绿。夹具全部在独立临时目录，脱离后代自动退出并已确认 selfExpired。
没有操作真实 SQLite、用户文件、系统策略、凭据或 QA App。详见实机切片交接 (`native-sandbox-t2-macos-handoff-20260907.md`)。

下一阶段先解决 T2-B 执行边界决策：如采用独立执行副本与受控回写，必须明确普通项目语义、
文件身份/并发合入规则、开销和所有后代的生命周期所有权；不能仅以换工作目录或进程组充当隔离。
2026-09-09 用户已批准一并验证该执行结构；这是原型验证授权，不代表方案已通过。未形成可验证方案前，不连接 restricted Bash
或为 U2 提供停止证明。真实 Host 审批消费、两入口 captured fence 接线、S/U/G/K/packaged 全部原验收保留。

### 9.4 T2-B 执行副本验证（2026-09-09）

已在独立临时夹具新增 `native/sandbox/prototypes/isolated-copy.mjs` 和配套单测/真实 macOS smoke。
**这是验证原型，不是已接通的产品执行后端；后代停止仍失败，T2-B 不完成。**

- 输入按文件内容写到新 inode，不保存硬链接别名；原目录与 Host staging 不进入子进程可写 scope。
  实机对照中，修改执行副本没有改变源文件或外部硬链接哨兵。复制本身不提供输入读取授权，
  真实产品仍须处理来源不明的多链接输入，不能把任意可读路径当已获授权内容。
- 输出先冻结为变更提案，不把模型文本、退出码或新文件存在当成已发布产物。
  夹具单文件回写使用新文件替换目录项，不原地写旧 inode；源内容/身份已变化、其他提案已提交、
  proposal 被伪造或跨会话、目录被替换时拒绝。没有真实项目回写或数据库写入。
- 小型 Node 项目的模块导入、普通 Node 子命令、生成结果在真实系统 sandbox-exec 下通过。
  这不覆盖 pnpm/node_modules、内部 symlink、watch 服务或大型仓库。原型明确拒绝 symlink，
  限制 128 个文件、单文件 2 MiB、深度 16，不能把这些验证限额迁入产品功能要求。
- detached 后代在 leader 被取消后仍存活并继续写副本。测试保留真实失败断言；有限寿命夹具
  最终自行退出，只证明夹具已清理，不能当作及时取消成功、U2 停止凭据或恢复条件。

回写原型故意只演示非并发临时夹具中的单文件 replace，没有通用 publication API。
路径重验与 rename 之间仍有窗口；没有目录 FD 锚定、并发原子协议、持久 journal、跨文件恢复，
也不接收任何声称 `quiescent=true` 的模型/配置标记。缺少完整生命周期证明时产品回写保持关闭。

Codex 参考已固定到 `ce254df05a3162a93d8f3357ff4dd86582c534b7`：
`codex-rs/utils/pty/src/process_group.rs` 明确是 best-effort process-group signal，
macOS fallback 枚举并复核的仍是同一 process group；`process.rs` 的 `has_exited` 是 child exit。
不能据此推导 detached 后代全部停止。没有复制上游源码或改变本项目许可证。
本机 SDK `sys/event.h` 明文说明 NOTE_FORK 的子 PID 不传入实际 kevent，NOTE_TRACK 已不支持；
不能用轮询进程树补出不存在的内核所有权保证。

下一步仍需验证覆盖所有后代的执行所有权，再确定原生目录 FD/回写 journal 与完整项目语义。
不擅自安装虚拟化软件、创建系统服务、索取额外系统权限、回退 full_access，或解除原七项命令门禁。
原七项频道场景、U2/U3 与完整 packaged 验收保持原范围；证据见
T2-B 验证交接 (`native-sandbox-t2b-copy-validation-20260909.md`)。

## 10. 测试计划与失败处理

```text
设置／会话选择
  |-- 旧字段／非法值／显式 deny ----------> 策略单元测试
  v
有效策略 + scope + 后端状态
  |-- 未初始化／版本不符／探针失败 ------> 阻止执行，UI 显示原因
  |-- 需额外权限 ------------------------> 审批／取消／过期／恢复测试
  v
平台执行 + 文件 worker
  |-- 允许的操作 ------------------------> 成功结果与文件证据
  |-- 越界／联网／链接竞争 --------------> OS 实际拒绝证据
  |-- 取消／崩溃／大量输出 --------------> 无残留执行、有限缓冲、明确终态
  v
事件／产物／UI
  |-- 旧 attempt／重复回调 --------------> 不覆盖当前状态
  +-- 诊断／设置回读 --------------------> 不泄漏密钥、显示真实生效模式
```

| 必验情景 | 要防止的失败 | 处理与可见结果 |
| --- | --- | --- |
| 工作区内读写、构建、测试 | 沙盒过严导致正常任务不可用 | 最小 Node／Python／包管理器 fixture，记录允许路径及结果 |
| 向工作区外写入 | 子脚本绕过命令字符串检查 | OS 拒绝；外部哨兵文件哈希保持不变 |
| protected metadata 写入 | 命令改写 Git／agent 配置或 Ling 状态 | 默认拒绝；明确额外 scope 后只开放指定操作 |
| 链接、父目录替换、junction 竞争 | 检查后路径被换走 | 并发 fixture 反复验证，越界哨兵不能变化 |
| TCP／UDP／DNS、IPv4／IPv6 与子进程联网 | 顶层工具不联网但子进程外发 | 使用受控本地测试服务，不传真实数据；未授权连接全部失败 |
| 单次开放网络后继续下一次命令 | grant 变成全局联网 | 只有绑定调用成功，后续调用恢复断网 |
| 两个并行任务不同目录与权限 | 共享账户／ACL／临时目录引起权限合并 | 交叉读写与网络请求不能借用对方 grant |
| 取消、超时、helper／daemon 崩溃 | 子进程继续运行或权限资源残留 | 进程树清理、状态可恢复、后续任务重新核对 readiness |
| 审批等待后修改补丁或目录 | 旧审批被新操作复用 | 校验调用、cwd、策略与内容哈希；不匹配重新申请 |
| 部分执行后被拒绝 | 自动提权重跑导致重复副作用 | 不自动重放，展示失败阶段和已有输出 |
| Windows UAC 取消／重复初始化／卸载 | 半安装或误删其他产品资源 | 可重试、按拥有清单补偿，明确未就绪 |
| setup 请求伪造／helper 被替换 | 本地提权或执行任意二进制 | 认证与身份检查失败时拒绝并给出结构化错误 |
| 设置刷新、重启、切换会话 | UI 偏好与执行权限不同步 | 回读真实状态，按既有 scope 重新确认 |

验证层次：

- Core：Node test runner 验证策略组合、优先级、作用域、路径规范化和旧设置迁移。
- Daemon／Pi：工具不能回退、实际策略下传、取消、审批、证据与恢复集成测试。
- Native：原生 helper 的参数、协议、路径、账户与进程管理测试，继承并适配相应上游安全回归。
- macOS：在不受外层测试沙盒混淆的执行环境运行真实 Seatbelt 探针。若 Codex 外层沙盒阻止嵌套测试，记录原因并通过明确的本机测试入口验证，不能把外层拒绝当成 Ling 成功。
- Windows：交付 PowerShell 入口，自动输出结构化报告、OS／架构、helper 版本、策略哈希、允许与拒绝结果、初始化与清理记录；同事执行并回传。
- Web／Desktop：使用现有 Playwright 流程验证设置、状态、完整访问确认和 Windows 初始化状态。前端 mock 成功不代替 OS 验证。

后续实现时先运行现有相关检查：

```bash
corepack pnpm --filter @ling-stack/core build
node --test packages/core/test/sandbox-types.test.mjs packages/core/test/approval-policy.test.mjs packages/core/test/runtime-permissions.test.mjs
corepack pnpm --filter @ling-stack/daemon build
node --test packages/daemon/test/platform-native-sandbox.test.mjs packages/daemon/test/runner-hydration-run.test.mjs packages/daemon/test/runtime-permission-requests.test.mjs
corepack pnpm --filter @ling-stack/runner-pi test
corepack pnpm --filter @ling-stack/web check:i18n
```

新原生模块、工具 worker 和实机探针的命令在对应模块交付时固定，不把尚不存在的脚本描述为已经可运行。

## 11. 性能、分发与上线

- 保留统一执行器现有输出大小限制和脱敏路径；worker IPC 设置消息、文件及输出上限，大文件走受限流式读取，避免复制整个工作区到内存。
- 不在每次工具调用时做 UAC、建账户、完整环境扫描或全量 ACL 遍历。初始化单独运行，策略与探针使用有失效条件的缓存。
- 首版优先每次执行明确隔离，测量原生启动开销后再考虑 worker 复用；不得跨不同策略或不同任务直接复用高权限 worker。
- 原生 helper 必须随 Desktop 与本地 CLI 发行路径可定位、可验证、可升级；覆盖平台和架构与正式制品清单一致，缺少制品返回 unsupported。
- 构建固定 Rust 工具链、Cargo.lock、上游提交和依赖；产出哈希、许可证清单与受信任打包记录。Windows helper 纳入现有签名／分发约定，不能运行工作区提供的同名文件。
- 提供独立 macOS／Windows 构建与测试任务。Windows 实机运行由同事负责；当前会话不连接其机器、不代为确认 UAC。
- 发布回退只回退 UI／版本或阻止受限任务，不能把“受限模式”回退成宿主裸执行。
- 交付状态分别列为：实现完成、构建通过、macOS 实机通过、Windows 实机待验收／通过。两端未各自完成验收前不标记“双平台沙盒验证完成”。

## 12. 不在首版范围

- Linux 原生后端：保留统一接口，当前版本不宣称 Linux 原生隔离已就绪。
- Docker／云端沙盒：保留现有原型，不作为原生桌面默认依赖。
- 域名代理白名单、透明凭据代理：不在首版虚构细粒度联网保证。
- 完整 Pi 内核进程迁移、第三方扩展隔离、MCP server 容器化、Browser／Computer Use 的 OS 隔离：这些有独立信任边界；本计划只声明已纳入的命令与文件工具覆盖范围。
- PTY、持久交互 shell、设置整体视觉重做：与首版强制隔离分开处理。
- 全球安装、模型默认值、gstack 升级、现有 WIP 清理：与本计划无关。

## 13. 工程检查结论

- 架构：主要风险是未接通工具入口、文件工具旁路和 Windows 共享权限泄漏；分别由统一 broker、受限 worker、独立执行策略与并发隔离测试覆盖。
- 代码边界：复用权限存储与审批，新增平台模块，不把 OS 分支继续堆进 orchestrator／approvals。
- 测试：字符串 profile 和 mock readiness 测试不足以验收；增加真实 OS 拒绝、授权范围、崩溃与跨任务验证。
- 性能：控制 worker 启动与输出复制开销，缓存 readiness 但必须可失效；Windows UAC 不进入日常工具路径。
- 外部独立模型审查：未运行。本文件是可评审的新计划，不声称已完成全部交互式工程评审或平台验收。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
| --- | --- | --- | --- | --- | --- |
| Engineering planning | plan-eng-review 检查维度 | 双平台执行隔离与设置接线 | 1 | DONE，计划已交付 | 已核对现有实现、四项工程维度和平台验收；用户确认 Windows UAC 初始化 |
| Independent review | 未运行 | 后续检查权限旁路与原生 helper 信任边界 | 0 | NOT_RUN | 不宣称独立审查通过 |

**VERDICT:** macOS 与 Windows 首版计划已形成，Windows UAC 路线已确认。原生模块复用可构建性由 T0 验证，双平台安全性由实机验收证明；完整交互式工程评审未执行，不将本文件标为实现或独立审查通过。

产品决策更新（2026-09-09）：取消与 HTML 策略已由用户确认，见[七项闭环计划](channel-seven-execution-closure-plan.md)。
T2-B 的硬链接防护、受限命令接线、停止风险持久化与恢复检查仍是未完成实现，不再列为待用户选择。
不因取消采用尽力终止就解除未验证的 restricted command 门禁或签发虚假 U2 停止 receipt。
本任务原有产品范围与 Windows UAC 路线保持已确认；未取得新授权前不安装 VM/服务或扩大权限。

NO UNRESOLVED DECISIONS
