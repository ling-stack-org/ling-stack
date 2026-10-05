# Protected Host：实际进程入口接线账本

日期：2026-10-05。状态：部分原入口已接线并验证，**全覆盖、实际保护 scope、产品 safe 尚未成立**。

本表记录已完成的源码追踪，恢复上下文时直接从第一个未完成 gate 继续，不重新调查已经核实的相同入口。
用户边界是受控进程保护；不受限的 Full Access/manual UI/external 同 UID 不承诺隔离，不新增特权服务，不承诺路径/元数据隐藏。raw 只是启动方式，普通受控会话也可能使用它，不能据此授予 Full Access 豁免。
分类取决于实际生产来源，不由名字、模型标志或可替换 config 决定。

## 当前静态清单与真正的物理入口

表内路径均相对仓库根。`D/` 为 `packages/daemon/src/`，`C/` 为 `packages/core/src/`。

| 原入口 | 已核实的物理启动点 | 本轮状态 / 下一门槛 |
| --- | --- | --- |
| macos_native_command | D/runtime/sandbox/macos-native-command.ts，prepared.spawn → sandbox-exec | 已接 immutable entry、私有单次 launch record、exact original actor/prepared；继续沿用原 certified 域，不授别的 launcher 该 actor |
| unified_exec_raw | D/features/runs/unified-exec.ts，spawnCommand | 尚未接 exact 原入口；prepared 分支沿用上一行。普通 legacy 和 Full Access 都可能走 raw，undefined dispatch 不是授权；必须从持久化原 policy/source 分流，未认证受控来源不得借权 |
| native_input_capture | D/runtime/sandbox/native-input-capture.ts，spawnHelper | 已接原 effect guard 内 entry；unknown 保留。后续独立 input-read profile，原 certified 域拒原 workspace，不能借它 |
| mcp_host_stdio | D/features/mcp/host-stdio-transport.ts，OwnedStdioTransport.start | 已接原 connection effect 内 actual spawn；unknown 保留，后续独立 stdio profile |
| mcp_sdk_stdio | D/features/mcp/stdio-launcher.ts，private SDK original.start | 已接 public facade/private SDK object，constructor inert，metadata Client.connect 同 deferred gate；unknown 保留 |
| workspace_changes_git | D/features/previews/workspace-changes.ts，boundedGitDiff / 共享 numstat git | 已接 bounded spawn 原entry；共享 status/numstat 走下一行entry。repo read profile未认证；禁 ext-diff 不等于禁 textconv |
| managed_worktrees_git | D/features/workspaces/managed-worktrees.ts，git → execFileAsync | 已接共享原entry；read 和 worktree add/remove仍待分开profile，不把整槽称只读 |
| action_classifier_git | D/features/runs/action-classifier.ts，sync git | 已接原同步entry及私有拒绝来源标记；两层catch重抛原physical前拒绝，普通Git错误保持旧降级；profile未认证 |
| workspace_terminal | D/features/workspace-directory/terminal-runner.ts，默认 spawn | 已接原默认 producer；当前唯一来源 POST /workspace-terminal/commands，无 Run/Attempt，明确 manual raw。不是 human-gesture proof |
| workspace_directory_picker | D/features/workspace-directory/directory-picker.ts，默认 execFilePromise | 原18槽漏项，本轮新增第19槽并接原默认 producer；POST /workspace-directory/select，manual UI/raw，不运行原生dialog测试 |
| external_work_scheduler | C/external-work-scheduler.ts，runShellCommand，shell:true | 未接；afterCreate/beforeRun 位于 run attempt 前，须 workflow/lease source 与 hook profile，不能伪造 run actor |
| official_skill_git | C/managed-official-skill-source.ts，defaultGit.run | 未接；clone/fetch网络、checkout/clean cache写入，需独立同步 profile，URL固定不等于可信OS启动 |
| workspace_file_launch | D/features/previews/workspace-file-actions.ts，spawnDetachedProcess | 已接原file-open生产entry，仍raw/external。未来caller变动须重新核来源，不证明human gesture |
| local_path_open | D/shared/local-path-open.ts，spawnDetached | 已接当前channels workspace POST open生产entry，仍raw/external，不证明human gesture |
| workspace_file_probe | D/features/previews/workspace-file-actions.ts，open -Ra 与 which/where | 已接原probe entry；固定OS probe/PATH resolver不称trusted bootstrap，profile未认证，unknown保持 |
| workspace_icon_probe | D/features/previews/workspace-file-open-icons.ts，defaultRuntime.execFile/safeExec | 已接默认original entry；私有拒绝来源穿safeExec/convert，普通失败/缓存/注入runtime不变。mdfind/plutil/sips处理用户可变plist/icon并写temp，bounded icon profile未认证 |
| keychain_security | D/features/providers/keychain-secret-store.ts，四个固定security同步点 | 未接；独立Host/system身份核验，自定义注入不能继承默认source proof |
| packaged_codesign | D/runtime/sandbox/packaged-restricted-command-bootstrap.ts，verifyFinalMacosBundle | 未接；Supervisor前固定codesign身份，测试callback不是真实coverage |
| docker_probe | D/runtime/sandbox/docker.ts，runDockerCommand | 未接；尚未查到Daemon生产caller；config binary/PATH/plugins/socket不能靠readiness认证，激活需明确endpoint/argv/profile |

这19类仍是本次源码追踪范围，**不能仅凭槽数宣称任意未来/仓库外 producer 都覆盖**。静态
`protected-host-original-entry-manifest.ts` 保持空 sentinel；不把 partial entries 或 fixture19槽填成全量verified。
Core两个 producer 必须用依赖倒置的原 hook 接线，不反向 import Daemon。

## 已验证切片及证据限制

- Daemon构建 `office-original-entry-hooks-20261005-02.build.log`：实际工具 terminal exit0。01失败是SDK onmessage签名，原日志保留；已按当前SDK单参数透传，原start用Reflect.apply。
- focused `office-original-entry-hooks-20261005-02.focused.log`：**26/26 exit0**，其中真实SQLite/Tracker14、manual UI2、source-hooks staged8+parent1+portable1。fail/cancel/skip/todo0，2681个Core dist/Daemon source/dist/test输入前后SHA一致。
- source-hooks使用观察到的mock spawn，仅验证原入口/拒绝发生位置，不是新kernel/profile/descendants proof。manual terminal另有真实shell执行；目录选择器不打开dialog。
- 五个存在的相邻源测试实际 **87/87 exit0**；原命令还含一个不存在的restricted-command-runtime测试名，被Node忽略，所以不宣称这个不存在套件已执行。正确restricted dispatch及input-post-spawn-failure另外实际 **6/6 exit0**。前后manifest一致，最终2681个输入check exit0。
- Tracker首轮3/14是新测试 matcher 漏完整领域前缀，01日志保留；改为精确Core/Tracker/Group三域code，不变更拒绝语义，14项在上述fresh组合通过。
- 新Git/file-open六entry切片：Root Daemon tsc **exit0**；`office-git-file-entry-hooks-20261005-01.focused.log` **11/11 exit0**，fail/cancel/skip/todo0，完整Core dist/Daemon source/dist/test before/after SHA manifest匹配。Git8 children+parent、file UI2，均以原公共caller触达；mock producer只证明physical前门位置、catch语义与raw UI分类，不证明真实Git/probe保护域或descendants。
- 同一输入下四个存在的相邻文件（channel-workspace、host-capability-input、workspace-change-recovery、workspace-file-open-icons）实际 **241/241 exit0**，fail/cancel/skip/todo0；日志 `office-git-file-entry-hooks-20261005-01.adjacent.log`，结束后完整输入 `shasum -c` exit0。
- Icon默认producer切片：旧dist的公开loader在active stage仍进入原mock exec，mdfind路径3次、plutil路径2次，两个placement断言真RED；原Node24工具收据保留，缺export的4个临时skip未计为通过，最终test已全部移除该skip。Root Node22 fresh Daemon build **exit0**，最终 **11/11** 和四相邻 **237/237 exit0**，fail/cancel/skip/todo0；完整 **3244** Core/Daemon source/dist/test before/after及final check一致。日志 `office-icon-source-hooks-20261005-01.{red,focused,adjacent}.log` 及build receipt。私有original refusal对象+私有defaultRuntime身份重抛，普通工具错误保持旧fallback；public sips late-attach只证明其原finally真实mkdtemp/rm与unknown保留，不证明前序Supervisor保护域。
- 实际无stage公开loader读取本机VS Code应用图标，原plutil/sips及Promise适配器未替换，返回真实3479-byte PNG并验证cache返回同一对象，Node22 **exit0**、simulation=false。日志 `office-icon-source-hooks-20261005-02.actual-installed.log`；不是GUI/packaged/kernel/descendants验收。01实际运行有exec observer丢失custom promisify适配器，作为有扰动的诊断保留，不用作未改生产语义的验收证据。独立审查最终source SHA一致，无新增confirmed finding。静态manifest依旧空sentinel，未认证profile的unknown不清零。

## 后续固定顺序与不可省略的生命周期门槛

当前第一项只读根因核对已完成，不重查：`createRestrictedCommandDispatch` 的
undefined 来源是 workflow legacy，包含正常普通/私聊 Run。Full Access 必须核对
持久化 workspaceAccessMode、effective policy 和有效 permissionConfirmation；
authorizationMode 可以是 ask/smart/always。Harness snapshot 不能代替 SQLite
最后的原 source/fence/policy 校验。原 Host journal 的同步只读 launch 窗口支持
已有 read-snapshot 机制，不另开 BEGIN。raw gate 拒绝前不能设 spawnEntered；
真实 producer 已进入后的异常仍保留 unknown。本次备份尚未修改该执行入口。

1. 接其余确切 original physical hooks，raw/external来源不能借字符串豁免。
2. 逐族核新 input/stdio/Git/worktree/hooks/official-sync/icon profile，保留独立原source/caps；仅公用机械实现。
3. unknown进程历史不能因leader exit、pipe close、kill、deadline或计数阈值退休；同步或Promise返回也不自动证明未知descendants已闭合。
4. 目前永久unknown gate保守正确，但日常无stage Git/probe若仍raw启动，会使同Host后续Office scope一直不可发行。**不是清零tombstone解决**；需要认证其真实保护域，或具备完整原descendants closure事实后才能安全退休。保持普通无stage行为，未知scope failclosed。
5. 真正完整静态manifest、同Supervisor原issuer、bootstrap异常原stage FD cleanup、原factory/reservation固定adapter接线后，才能进入scope成功发行验收。

未决用户选择：无。本账本不授权新特权或Full Access语义变化。未决实施证据为新profile/descendants、SDK实际artifact、Core原hook、Host/system binary与Docker启用来源；延后任何一项，相关Office capability仍不safe，U gate不开放。
