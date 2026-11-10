# Protected Host：实际进程入口接线账本

日期：2026-10-05。状态：部分原入口已接线并验证，**全覆盖、实际保护 scope、产品 safe 尚未成立**。

本表记录已完成的源码追踪，恢复上下文时直接从第一个未完成 gate 继续，不重新调查已经核实的相同入口。
用户边界是受控进程保护；不受限的 Full Access/manual UI/external 同 UID 不承诺隔离，不新增特权服务，不承诺路径/元数据隐藏。raw 只是启动方式，普通受控会话也可能使用它，不能据此授予 Full Access 豁免。
分类取决于实际生产来源，不由名字、模型标志或可替换 config 决定。

### 当前增量（2026-10-06；source-owned foundation）

Original Host issuer14文件已受控应用，private fresh build receipt与lexical publication、
canonical consumed-record issuer、永久App/ancestor custody/预算/unknown已接通。
Root首tsc类型未窄化通过真实prepared/retained校验修正，freshbuild02 exit0；机制
13/13、publication6/6、相邻134/134均exit0。ordinary/required实际bundler均exit0，
新literal/helper/manifest/19source pins精确读回一致。收据：
`output/e6-20260928/PACKAGED-CODESIGN-ISSUER-ACCEPTANCE-20261006.md`。
随后新issuer physical harness真实通过：default/one-shot/两registry/finally10个原FD
custody/latebind全passed，build/copy-sign/run均exit0，3647inputs unchanged；无FS/spawn/
native/versions mock。详 `output/e6-20260928/PACKAGED-CODESIGN-ISSUER-PHYSICAL-20261006.md`。
这只闭合codesign槽，不能据此称全Host scope、Office正例或packaged GUI通过。
直接推进Office fixed adapter/其余原family profile，不重跑新physical或旧copy/native，
不拿静态manifest/hash或工具文本发证。

联合 native fault/actual 与 Host 固定 helper 接线已落地。freshbuild03 实际 exit0：
Rust26passed+2ignored；原handshake19、input10、framing18全通过。随后显式实际能力
对照 **2/2 exit0、0ignored**：registered三槽继承/count0真通信、threeNULL不通信；
FD3 baseline真实pread/mmap/sharedwrite，CLOEXEC严格EBADF，父原identity/bytes读回。
19source pins/binary/observer/rlib最终实核匹配。新Host协议精确19keys、immutableframe、
35s outerwatchdog及helper/inner/error分轴接通，fresh Daemon tsc exit0；模拟focused
117/117、相邻110/110均exit0。编译阶段两处test-only类型错误最小修正，原失败保留。
详 `output/e6-20260928/CODESIGN-NATIVE-JOINT-HOST-20261006.md`，不重复本片测试。
临时 App 副本随后真实无参 public default 与独立 canonical one-shot source 均通过，
copy.actual02 exit0，无 spawnSync mock/override，原安装实例未改、inputs SHA前后不变。
原 unsigned-helper 构造失败日志保留；显式签副本helper再签/验App后通过。证据
`packaged-codesign-public-native-20261006-02.actual.log`；仍 candidate/非证书/无GUI。
这些结果不代表 sourceissuer/custody、全inventory或GUI完成；私有
issuer须在已有受信Host/build链内固定绑定reviewclosure/产物，不以普通manifest或helper
自报铸证，也不额外引入防FullAccess/同UID篡改的新服务/PKI/权限门槛。原Office genuine
nested positive 的 v1 mkdir/post-lstat 缺口仍须 production native-v2 接线处理。

最新native真实RED已闭合：旧helper将DEBUG/RESOURCE查询当作新child必须为空，DEBUG
返回自有SEND|RECEIVE、RESOURCE getter条件不支持，导致fixedleaf主路径拒绝。独立2src
修正删除无效getter-null gate，保留HOST/ACCESS校验；Completed改明确static no-parent-copy
facts，不假装actual empty。freshbuild02 Rust11/handshake19/input10/framing18均exit0，
14inputs/binary匹配。唯一QA actual03 **3case exit0**：真实codesign0、helper关闭额外FD3且
父4096bytes原identity读回不变、wronginode exactrefusal；ownedfixturecleanup通过。
详`output/e6-20260928/CODESIGN-NATIVE-LEAF-ACTUAL-20261006.md`。它不证明下游FD3
EBADF/registered IPC清理，也不替代原Host source/issuer/全inventory；cert仍未发。

固定 native codesign leaf 已由 Root 全文审读、受控 apply，8个目标逐字匹配冻结expected；
独立静态审查无确定源码阻塞。fresh pinned/offline build01实际exit0，Rust11/11、原
handshake19/19、原input-read10/10、新framing18/18、build-evidence19/19均通过。
固定角色直接Darwin posix_spawn、实际额外FD关闭/精确三pipe、registered三NULL、完整
exception mask及bootstrap NULL；普通OS host type3与fixedprivilegedtaskgated身份gate。
上述只证明编译、parser与原mode回归，不证明实际Mach/FD闭包。原Host public source尚
未接新helper；outerwatchdog/OS与fulltuple绑定、真实正负及故障证据仍未完成。
manifest仍未认证/未ready；不凭helper返回字段或OS服务名称授证。
证据：`output/e6-20260928/codesign-native-leaf-20261006-build01/`。
旧TASK_ACCESS审查第42行结论越界已另稿澄清，原冻结文件不改；后续同时引用
`codesign-native-task-access-origin-20261006.clarification.md`。

已应用5src foundation：实际 codesign source 自持固定 singleton、私有单次 invocation、
captured producer 与 exact native tuple；bootstrap 重导出同一对象。pure backend reader/Error
机械拆分保持同一 runtime class。未知 dyld 只有完整原身份、FD、backend hash及成功 close
之后的 fresh private unsupported provenance 才能继续 **candidate**；identity/cleanup失败
不降级。没有 Host cert/第四resolver/unknown历史退休。独立静态审查无确定阻塞，fresh tsc
exit0。首轮相邻102/104的唯一机制子项失败为旧夹具跨test缓存source observer（及parent），
精准loader resolve已修，原13断言不改；新增14机制与原13合计27/27、完整六文件相邻
118/118均exit0，fail/cancel/skip/todo0，3282 inputs前后及最终check相同。01失败日志保留，
这不是新增输入全仓、实际Mach闭包或认证完成。

完整 Daemon snapshot已终态3208/3209、exit1，3278 inputs前后相同。唯一Office nested
正例直接走v1 mkdir/post-lstat creator guard，不经过codesign；source认证不能替代其
生产native-v2 writer、canonical/scope及原pair结算接线。保留原正例及失败记录。

下一原生实现复用现有fixed helper的codesign role；direct Darwin posix_spawn、精确FD/Mach
继承清理、原source/build/协议绑定及真实正反证据。既有 Mach/Crashpad审计只记录一次，
不新增服务、系统用户或权限，不把代码编译/版本pin/handshake字段当认证。
Root新实际slot probe确认：当前普通SIP下Host/TaskAccess NULL的setter均返回0，但真正
spawn返回22；Bootstrap NULL正常spawn0。baseline/等待/query right释放均0，Host实际
type3、TaskAccess实际user-port类型未定。不能以一条必失败的清空路径永久关闭能力，
也不吞错误/关SIP；需在原生leaf对OS host/service capability给出受审核约束或可用替代。
仅创建output诊断程序/新true子进程，不涉及当前Host/真实DB/GUI，不构成protected cert。

## 当前静态清单与真正的物理入口

表内路径均相对仓库根。`D/` 为 `packages/daemon/src/`，`C/` 为 `packages/core/src/`。

| 原入口 | 已核实的物理启动点 | 本轮状态 / 下一门槛 |
| --- | --- | --- |
| macos_native_command | D/runtime/sandbox/macos-native-command.ts，prepared.spawn → sandbox-exec | 已接 immutable entry、私有单次 launch record、exact original actor/prepared；继续沿用原 certified 域，不授别的 launcher 该 actor |
| unified_exec_raw | D/features/runs/unified-exec-raw-source.ts，spawnOwnedRaw → 原 spawn | 已接 exact 原入口；普通 legacy 为 controlled。持久化 source/fence/policy/Plan/Skill/审批 lineage + 完整 normalized request 双重重验、Core preclaim 只读门禁、私有单次 token；prepared 分支独立，未认证受控来源不得借权 |
| unified_exec_full_access | 同上，独立私有 token 的原 spawn | 新增第二十槽 user_external；只接受真实持久化 Full Access selection/effective policy/有效 confirmation/当前审批，不把 undefined dispatch 或 raw 当授权；不保证隔离 |
| native_input_capture | D/runtime/sandbox/native-input-capture.ts，spawnHelper | 已接原 effect guard 内 entry；unknown 保留。后续独立 input-read profile，原 certified 域拒原 workspace，不能借它 |
| mcp_host_stdio | D/features/mcp/host-stdio-transport.ts，OwnedStdioTransport.start | 已接原 connection effect 内 actual spawn；unknown 保留，后续独立 stdio profile |
| mcp_sdk_stdio | D/features/mcp/stdio-launcher.ts，private SDK original.start | 已接 public facade/private SDK object，constructor inert，metadata Client.connect 同 deferred gate；unknown 保留 |
| workspace_changes_git | D/features/previews/workspace-changes.ts，boundedGitDiff / 共享 numstat git | 已接 bounded spawn 原entry；共享 status/numstat 走下一行entry。repo read profile未认证；禁 ext-diff 不等于禁 textconv |
| managed_worktrees_git | D/features/workspaces/managed-worktrees.ts，git → execFileAsync | 已接共享原entry；read 和 worktree add/remove仍待分开profile，不把整槽称只读 |
| action_classifier_git | D/features/runs/action-classifier.ts，sync git | 已接原同步entry及私有拒绝来源标记；两层catch重抛原physical前拒绝，普通Git错误保持旧降级；profile未认证 |
| workspace_terminal | D/features/workspace-directory/terminal-runner.ts，默认 spawn | 已接原默认 producer；当前唯一来源 POST /workspace-terminal/commands，无 Run/Attempt，明确 manual raw。不是 human-gesture proof |
| workspace_directory_picker | D/features/workspace-directory/directory-picker.ts，默认 execFilePromise | 原18槽漏项，本轮新增第19槽并接原默认 producer；POST /workspace-directory/select，manual UI/raw，不运行原生dialog测试 |
| external_work_scheduler | C/external-work-scheduler.ts，runShellCommand，shell:true | 已接 Core-owned private record/original producer + Daemon同步guard；直接Core public poll不绕过；beforeRun在run attempt前，独立workflow/lease profile仍未认证 |
| official_skill_git | C/managed-official-skill-source.ts，defaultGit.run | 已接 Core-owned private record/original producer + Daemon同步guard；原拒绝穿catch/自定义Git不继承proof；同步profile仍未认证，URL固定不等于可信OS启动 |
| workspace_file_launch | D/features/previews/workspace-file-actions.ts，spawnDetachedProcess | 已接原file-open生产entry，仍raw/external。未来caller变动须重新核来源，不证明human gesture |
| local_path_open | D/shared/local-path-open.ts，spawnDetached | 已接当前channels workspace POST open生产entry，仍raw/external，不证明human gesture |
| workspace_file_probe | D/features/previews/workspace-file-actions.ts，open -Ra 与 which/where | 已接原probe entry；固定OS probe/PATH resolver不称trusted bootstrap，profile未认证，unknown保持 |
| workspace_icon_probe | D/features/previews/workspace-file-open-icons.ts，defaultRuntime.execFile/safeExec | 已接默认original entry；私有拒绝来源穿safeExec/convert，普通失败/缓存/注入runtime不变。mdfind/plutil/sips处理用户可变plist/icon并写temp，bounded icon profile未认证 |
| keychain_security | D/features/providers/keychain-secret-store.ts，四个固定security同步点 | 已接original entry/private单次record/真实gate provenance；未认证先controlled，四catch保留原gate错误，自定义store不继承default proof；Host/system profile仍待认证 |
| packaged_codesign | D/runtime/sandbox/packaged-restricted-command-bootstrap.ts，verifyFinalMacosBundle | 已接original entry/private单次record和实际默认Host候选profile；真实Electron public默认verify已成功。candidate未认证，Supervisor前历史后绑定仍sticky；custom verifyBundle不借proof，kernel/issuer仍待接通 |
| docker_probe | D/runtime/sandbox/docker.ts，runDockerCommand | 未接；尚未查到Daemon生产caller；config binary/PATH/plugins/socket不能靠readiness认证，激活需明确endpoint/argv/profile |

这20类仍是本次源码追踪范围，**不能仅凭槽数宣称任意未来/仓库外 producer 都覆盖**。静态
`protected-host-original-entry-manifest.ts` 保持空 sentinel；不把 partial entries 或 fixture20槽填成全量verified。
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

2026-10-06：unified raw 根因修复已实现，不再仅是只读审计。原 undefined dispatch
包含正常普通/私聊 Run，故普通 raw 与真实 Full Access 必须独立 source。完整 normalized
request 在 capture/末次 SQLite check 重算比较，允许真实 input.cwd 的合法子目录；
current owner、workspace policy、Thread Plan、selected Skill profile、delegated requirement、
exact approval/rule lineage 均重验。Full Access 的 ask/smart/always 都可合法，但缺/伪/未来
confirmation、policy drift 不得降级普通 raw。Core journal 原 BEGIN IMMEDIATE 内同步
只读 preflight 先于两条 claim；真实 producer 进入后无 child 的 throw 仍写 observed/unknown，
前门拒绝才 no-start。旧 untracked settlement 的兼容行为未改，不声称所有内部误用已被禁止。

Root fresh Core build exit0，focused28/28、相邻186/186、全套2251/2251 exit0；Daemon
final build08 exit0，focused61/61、14相邻215/215 exit0，fail/cancel/skip/todo0。
原 RED、首轮夹具失败和预取消失败日志保留，最终 fixture 修正未放宽产品授权。
final source/normalizer/unified-exec 冻结输入只读审查无新 confirmed finding，cwd/shell/approvalId
factory 缺口已闭合。Daemon 全套已 terminal **3121/3123、exit1**：原 genuine nested writer
正例仍失败，另有审批恢复 QA fan-in 超时，窄同输入 **0/1 exit1**。隔离诊断确认旧
正向 fixture 缺生产必备 teammateId/delegatedRequirement；只补 canonical step 来源后
原窄 **1/1**、完整 workflow evidence **72/72 exit0**，不加长等待/不放宽 gate/fan-in/不跳过。
3264项最终 before/after cmp 和 SHA check 均 exit0；fixture随后变更是新输入，不能借旧full标绿；日志统一为
`output/e6-20260928/unified-raw-source-20261006-{01,02}.*`。这些源码/SQLite 回归不是
kernel/profile/descendant/packaged 认证，固定 manifest 仍空、U gate 不开放。

### Core-owned hook 当前实现与验证边界（2026-10-06）

根因已经核实：Core 的私有 defaultGit.run / runShellCommand 原来直接到 native producer，
业务 caller 的 options 检查会漏直接 Core 调用和异步物理点。下述 source/bridge 链已经应用，
不是 profile/kernel/descendants 认证，也不发行完整 coverage：

- Core 自持 immutable original entry、私有 opaque 单次 record 和创建时捕获的原 producer；
  record 绑定 native 参数，不公开 capture/ungated invokeOriginal 给调用者。不 import Daemon。
- Daemon 只对两个真实 Core export 的 exact identity 安装一次同步 guard bridge；guard 只做
  gate/entered 通知，不接收可替换 launch callback。直接 Core invoke 同样走 guard；拒绝 clones、
  同名伪 source、重复安装、async/thenable/非 undefined 回调和借用 prepared actor。
- 安装前已进入原 producer 的 sticky unknown 不能清零；每次 registry bind 都检查它，后绑定
  也要关闭 coverage。多个 registry 共用同一 bridge，任一 active stage 拒绝即不得 native entry。
- Official Git 的原 catch 仅对真实 guard refusal identity 重抛原对象，普通 Git 失败保持原
  unavailable 包装。自定义 git 不触发默认 source，不把 single-flight 的同一 Promise 当来源证明。
- Scheduler guard 位于原 spawn 前。内部 catch 不把前门拒绝写成 retry_wait/成功 artifact；
  原 lease finally 仍释放。后台 timer 必须消费失败并明确记录/停止，不产生 unhandled rejection。
  此处在 Run/Attempt 之前，不能伪造 Run actor；后续 profile 必须来自真实 workflow/lease 身份。
- 新测试区分实际 SQLite stage + mock native placement 与无 stage 真实本地 shell 正例；
  不连接 Git 网络，不借此宣称 kernel/profile/descendants 已认证，不填空 manifest。

两registry guard先全部只读检查，只有全部允许进入原producer才写native history/coverage unknown。
原inactive-first/active-second拒绝不能污染前registry；两个顺序的回归在关闭原stage后对原两个
registry重新register/close，不reset或重建。prebinding或已进入的history不因后来成功而清零。
Root Core/Daemon fresh构建均exit0；Core原相邻32/32、新source suite03 **30/30 exit0**、
Core full **2251/2251 exit0**、Daemon十一相邻 **216/216 exit0**，fail/cancel/skip/todo0。
原 prebridge **13/30 exit1** 保留；fresh02 **27/30 exit1** 中两child的递归Node runner环境
已独立诊断，删除子env `NODE_TEST_CONTEXT` 后固定TAP/真实执行统计，未削弱安全断言。
这不是17个独立产品缺陷或kernel测试。final03 Daemon full **3152/3153 exit1**，唯一原Office
nested writer正例仍失败（731行），未删/skip/改为blocked；3271项before/after cmp与finalcheck
均exit0。所有运行句柄已收terminal，不再等待或重跑旧input。证据 `core-original-hooks-20261006-{01,02,03}.*`。
独立source和测试段审查无新confirmedfinding，manifest仍空sentinel，U gate保持关闭。

### Keychain/codesign 原入口与 generic 两阶段验证（2026-10-06）

上述两个source现已接通；未认证的system标签不授豁免，暂为controlled+stickyunknown。
自定义secret store/verifyBundle不继承默认sourceproof；CLI在Supervisor前的codesign原历史
在后绑定仍保留。source私有WeakMap中的frozen opaque record先单次consume，再全registry
readonly gate；无效record/consumer错误不污染coverage、不制造本entry真实拒绝来源。
只有exact entry实际gatecatch加入私有WeakSet；consumer、entered通知或原producer复用旧
Error均撤旧标签；原native Promise的identity保留，ordinary thenable getter不执行。
私有record和consumer不作为public factory依赖参数，不公开任意argv或native callback。

Root旧dist public suite **3/27 exit1**，明确四keychain/codesign active stage仍进入原observer；
其余连带/缺export不宣称独立缺陷。apply后的build02 exit0、focused **49/51 exit1**：
27source通过，额外通知抛旧Error反例失败。Root仅把通知纳入原producertry/catch，不清sticky；
fresh build03 exit0，最终三套 **81/81 exit0**（27source/24inventory/30Core hooks）与十一相邻
**218/218 exit0**，fail/cancel/skip/todo0。完整3273项before/after cmp/final SHA check exit0，
actual delta独立审查无新confirmedfinding。证据 `bootstrap-original-hooks-20261006-{01,02,03}.*`。
旧full **3152/3153** 为新Keychain/codesign前快照；未跑此增量下的新全仓/GUI验收。
这里所有security/codesign均为原producer observer，没有读真实keychain或运行真实签名工具，
dummy App配置不是trust/profile/kernel/descendant认证；不能据81+218发行scope或Core safe。

### Packaged codesign 实际候选增量（2026-10-06）

新 source 从原 Host 模块加载时的 Electron/executable/pid/epoch 捕获；原默认 public
bootstrap 才走固定 sandbox-exec/codesign profile，注入 dependencies/custom verifier
不借此身份。真实 App 与 ancestor/file FD、系统 executable/dyld 原 bytes 都在物理入口
前重验。首个 acquired seal mismatch 仍关闭刚取得的自有 FD；后续 foreign reuse/EBADF
保留 unknown，close failure 不重试整数。独立审查修订草稿 `86e351d8…` 无新 confirmed finding。

Root apply 与 fresh Daemon build01 exit0。实际已安装 QA Electron44.1.1/Node24.19.0
加载最新 dist，无 dependencies override 的 public bootstrap，经新 profile 验签成功
exit0。bootstrap/inventory 相邻 **51/51**、packaged/native/staging **67/67 exit0**，
fail/cancel/skip/todo0；五个候选源码/dist/patch 输入 SHA 检查一致。证据：
`output/e6-20260928/packaged-codesign-host-profile-20261006-01.*`。

这里只确认真实 original source/profile 能完成固定验签；没有访问真实 Keychain、启动
Desktop/Host、写真实 DB 或新包 GUI 验收。仍 `candidate_unverified`，不借 Run actor，
prebinding history 仍 unknown。新 source 机制模拟 **13/13 exit0**；loader仅提供两个精确
compiled JS原bytes，App/OS/native仍虚拟，不作为认证。首次loader/依赖缺失日志保留。

实际新 kernel02 **exit0**：原默认public tuple/source一致、实际native PID/status0；
三个布局各五真实进程（fork/exec及doublefork/setsid均发生）。原pipe布局40项、额外
FD3压力40项路径/IPC/SIGCONT均EPERM；原pipe五个Host文件FD均EBADF。
**额外FD3实际可read/mmap RO/RW并写入**，不能声称profile撤销既有FD权限；认证
必须固定原pipe、不传Host私有FD/port，跨record不能借proof。task_for_pid无沙盒
控制同样被拒，结论inconclusive、不新增权限。unsigned dummy签名校验真实exit1，
不把失败变为default签名成功。cleanup errors=[]，仅新临时SQLite/目录被创建和删除。
kernel01 Ruby Gem预载被/Library EPERM阻断；仅probe加`--disable-gems`，生产profile/
options未改。证据 `packaged-codesign-host-profile-20261006-{01,02}.kernel.log` 与
`05.mechanism.log`，候选五输入check仍全匹配；不是GUI或完整scope证据。

下个gate是原Host issuer/epoch/private record/domain held-FD custody。审核固定OS/
renderer/producer规则、动态绑定actualApp，不静态pin旧QA全tuple。原certified历史需
保留App/ancestor capability，不靠JSON、返回/exit计数退休；已有unknown不清。Node/
libuv FD继承、fallback、App路径编码仍需静态审。CLI无catch，未知审核版本仅关保护
能力，不能导致正常packaged Host全体启动失败；identity/tampering/genuinegate不得
fallback。源码未接issuer，U与完整manifest仍关闭，不凭本有界矩阵发行证书。

下一gate为逐族实际profile/descendants与原native adapter。Docker尚无生产caller，不为
完整槽位凭空启用。固定manifest仍空sentinel，不拿当前source GREEN证明逐族profile/closure。

1. 接其余确切 original physical hooks，raw/external来源不能借字符串豁免。
2. 逐族核新 input/stdio/Git/worktree/hooks/official-sync/icon profile，保留独立原source/caps；仅公用机械实现。
3. unknown进程历史不能因leader exit、pipe close、kill、deadline或计数阈值退休；同步或Promise返回也不自动证明未知descendants已闭合。
4. 目前永久unknown gate保守正确，但日常无stage Git/probe若仍raw启动，会使同Host后续Office scope一直不可发行。**不是清零tombstone解决**；需要认证其真实保护域，或具备完整原descendants closure事实后才能安全退休。保持普通无stage行为，未知scope failclosed。
5. 真正完整静态manifest、同Supervisor原issuer、bootstrap异常原stage FD cleanup、原factory/reservation固定adapter接线后，才能进入scope成功发行验收。

未决用户选择：无。本账本不授权新特权或Full Access语义变化。未决实施证据为新profile/descendants、SDK实际artifact、Core原hook、Host/system binary与Docker启用来源；延后任何一项，相关Office capability仍不safe，U gate不开放。
