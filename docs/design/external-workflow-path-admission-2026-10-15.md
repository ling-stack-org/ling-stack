# A18：External workflow 路径准入与真实操作边界

状态：公开 HTTP 已真实复现，五例 4 pass / 1 fail、actual exit 1、零 cancel/skip/todo。
静态缺陷修复已由 Root fresh Core/Daemon build 后实际验证：完整路径20例＋原导入25例共45/45、
actual exit0、零fail/cancel/skip/todo；新增helper对应Desktop源码输入回归348/348。
未实施者冻结源码窄审无确认残留问题。具体回执 `output/e6-20260928/a18-20261015/root-static-validation-20261015.md`。
这些结果仅关闭已复现的静态副作用，不代表受控 OS 竞争门槛或 A18 全部完成；不冒 packaged GUI/Office 批准。
原始证据 `output/e6-20260928/a18-20261015/`。

## 确认根因

`handleExternalWorkWorkflowConfigure` → `resolveExternalWorkflowWritablePath`，
对不存在的目标先 `mkdirSync(parent, { recursive: true })`，之后才 realpath 校验。
当 workspace 内已有 `escape` 符号链接指向专用 outside fixture，
`escape/new/deep/WORKFLOW.md` 请求虽然最终返回 400，outside 已新增 `new` 和 `new/deep`。
这不是读取截图推断，不是权限泄露或文件被覆写的扩大结论。

独立正例已确认合法 nested 缺父目录仍可配置，existing 合法文件重复配置保持字节，
existing file symlink/lexical escape/directory target/missing channel 仍正确拒绝。
原五例测试 SHA `43bbd735baa1dfba8616847b66fd90816582a70c18c1e3e12011a3c040b1b622`。

## 不能以表面顺序调整宣布完整修复

最近存在祖先的 lstat/realpath 准入必须早于任何 mkdir，且不能只检查最终组件。
但把 realpath 挪到 recursive mkdir 前面，或逐层 mkdir 后再检查，仍有 OS 级祖先替换竞争窗口。
`O_NOFOLLOW` 只约束该 open 的最终组件；持有父目录 FD 也不自动证明该 inode 始终留在 channel root。
受控 Agent 仍可能并发修改其 workspace，不能把这些合法并发全部假定为 Full Access 边界之外。

现有 `captureProtectedHostStagePaths` 明确只是已存在目录的历史 FD/identity capture，
不是安全 mkdir creator。Office native 内已有逐组件 openat / mkdirat / exclusive-open 实现可供借鉴，
但现 API 的角色、审阅/哈希及原生 runtime 绑定属于 Office，不能将其权限票据或 approved 借给 workflow。
Office native README 也明确 mkdirat→openat 不能自行认证 creator-safe。

## 当前实施范围：先修已复现的静态准入副作用

原独审确认范围是无竞态前提下的预存 symlink 导致拒绝前 mkdir，未确认任意文件覆写，
也未要求隔离不受控同 UID 程序。受控进程边界保持；Full Access 和任意外部同 UID 进程不保证隔离。
原权威计划的“竞争窗口保持 fail-closed”不删除：**静态准入修复**与**受控 OS 竞争验收 pending**分列，
不能因前者 GREEN 就将 A18 整项标完成。

当前不新增 sandbox/native artifact/权限，不降低 Linux/Windows/macOS 已有支持，不伪造 Run 或借用 Office 能力。
只在新的 `features/external-work/workflow-path-admission.ts` 内聚文件准入/FD 操作，
由 `workflow.ts` 的 configure 链及原 resolver 包装使用；共享 status GET、secret handlers、Core 和 router 不改。

1. 先固定 canonical root 并作 lexical containment，再逐组件 lstat/realpath 检查已存在祖先。
   仅 lstat 的 ENOENT 可表示缺层；存在但无法 realpath 的 dangling symlink、EACCES、ENOTDIR 等拒绝，
   不得当缺失后继续创建。inside-directory/file alias 保持原成功语义，不简单禁用全部 symlink。
2. 全部已存在祖先准入后，对缺失后续层级逐层非 recursive mkdir；每次创建前重验父/root 身份，
   每次创建后立即核目录和 canonical 归属；EEXIST/identity 变化拒绝，不盲跟随或自动重放。
   不对未准入路径调用 recursive mkdir，不清理未知归属/outside 路径。失败可留下合法 inside 部分目录。
3. configure 后续只操作已准入 canonical 目标，不再用原 alias/workflowPath 调共享 reader 重新解析。
   新文件 exclusive-create；已存在 valid 文件仅只读打开并保持字节和权限；invalid 文件保持可修复行为，
   先读取，再无 truncate 地打开可写 FD、核 regular file/dev/ino/内容后才写，最终从同一 FD 观察。
   平台支持时给最终 canonical open 加 O_NOFOLLOW；该标志不被描述成祖先保护或 OS 原子操作。
4. 保留默认 WORKFLOW.md、合法 nested 缺父目录、existing valid、existing invalid repair、inside alias。
   扩原公开 HTTP 用例，并补窄 helper fault 验证非 ENOENT、独占创建冲突、FD 身份变化和错误收口。
   Root 独持 build/test/dist/真实进程与 Git；源码作者不执行这些验证。

同步 handler 仅排除同 Host JS 回调在该同步段交错；configure 当前未参加 Run channel/bound-path resource lease，
已启动的受控子进程仍可并发。逐次路径和 FD identity 核验不能证明 root/祖先 rename、symlink 替换、
打开后 inode 移出 root 或跨 root hardlink 竞争已 fail-closed。
必须另用独占 fixture、真实 actor 和 syscall 前后屏障检查 outside 全树/字节；检测到变化后的报错不冒零副作用。
若该受控竞争为 RED，保留 pending 并补完整边界，不把普通 controlled actor 静默改称 Full Access 来排除。

## 历史候选：请求级 sandbox helper（当前不实施）

候选最小完整链是此 configure 请求范围内的短命、无提权、固定操作 helper：

1. Host 验证请求的 channel/workspace 与相对路径，固定根、操作和输入；不开放任意通用写服务。
2. helper 在真实可兑现的受限进程内贯通准入、读现有目标、建父目录、写文件和最终观测，
   使用逐组件 nofollow/FD 相对操作；真实沙盒须阻止祖先移出 root 后仍产生 outside effect。
3. Host 不再在 helper 返回后用原路径做一次未受保护的写入或读取来“完成”操作，
   错误、部分结果、竞争和不确定性均结构化返回，不自动重试已可能发生的写入。
4. 需要独立 artifact/source hash/打包审核及明确平台 backend；不复制 Office 审核授权，
   不以无沙盒 fallback 宣称安全，不新增长期服务或系统用户。
5. 原静态 symlink 用例转 GREEN，还需用真实沙盒和正规竞态屏障验证祖先替换、父目录移出、
   已存文件、失败清理、有效 nested 配置。测试替身只可作逻辑证据，不能冒系统隔离成立。

此候选不作为静态 defect 的新增前置条件，也不授权跨平台退化。
实际可复用接口、platform/coverage/打包限制已另存只读准备报告；若后续需要此路线，须再明确实施边界。
没有新的提权或正式发布授权，不用本候选重开已完成的 A15/A16/A17 或旧 Office 全文独审。
