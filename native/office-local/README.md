# Office local synchronous syscall primitive (macOS)

这是 dedicated N-API v8 addon 的本机 primitive（native protocol 2），不是完整 Office native runtime。
它不发行 sandbox manifest，不接受 caller 提交的 digest/boolean 作为保护证明，
不执行 Core admission，不生成 Core receipt 或 Host COMMIT acknowledgment。
所有 snapshot 固定为 `scopeBinding: "unbound"`、`protectedStageVerified: false`、
`coreSafe: false`、`packaged: false`。**单独调用本 addon 不能建立 creator-safe 或产品 safe 判定。**

## 边界与模块

- `src/runtime.{h,cc}`：仅同步 macOS syscalls、原 FD/resource lifetime 与 once 状态。
- `src/publication.cc`：原 installation roster 的 destination-parent-relative 只读观察。
- `src/runtime-internal.h`：共享的内部 syscall/ledger helpers，不导出 raw FD。
- `src/addon.cc`：N-API 入参校验、opaque live caps、native returned 历史事实。
- `scripts/build.mjs`：显式 build-time clang 编译；禁止下载、安装、runtime 首次编译。
- `tests/`：真实 FD/filesystem/Seatbelt actor 测试与原输入指纹；不构建其他项目模块。

Session 原样持有 staging parent 和 existing destination parent，并以
`O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC` 逐组件捕获所有祖先 FD。新增 private tree 的
每层目录均在成功 `mkdirat` 后以 `openat` 持原 FD；文件使用原 parent FD
`O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC`，后续 write/read/fsync/close 只作用于原 FD。
文件全部 fsync + explicit close、创建目录全部 fsync 且仍 retained 后，
仅一次 `renameatx_np(..., RENAME_EXCL)` 安装完整缺失 subtree。EEXIST、EXDEV、
ENOTSUP 或其他 errno 都 fail closed：不覆盖、merge、copy 或普通 rename fallback。
安装后禁止新创建/write；允许原 parent fsync、原 handle observation 与 explicit close。
primitive 不执行 link/unlink/recursive cleanup：完整文件直接在私域建好，不需要临时 leaf publication。

Opaque session/resource 对象使用 N-API type tag + native wrap。序列化/clone
只得到无 live authority 的对象，foreign session、已关闭原资源和重复 operationId
全部拒绝。`operationId` 只是 native once 标签，**不是 Core 原票或授权凭证**；
产品 adapter 必须在实际同步 Core effect gate 内调用具体函数，不能依据这个字符串
重新构造原 source、票或 cap。取消只停止新 forward effects，不能改写已执行事实。

所有原 close 都先 tombstone fd 为 `-1` / unknown，再调用一次 `close`；即使
errno=EINTR/EBADF 也不检查或重试该整数。其他原资源各 close 一次。
Explicit `closeSession` 只输出真实 close 返回值；unknown lifetime 保持 unknown。
析构仅尽力放弃尚持有 FD，不输出/补造 explicit close proof。失败残留不做路径清理。
资源记录和 syscall-return 槽都在 syscall 进入前分配；成功返回后以无抛标量赋值
绑定原 FD、返回值和 errno。Native/C++ 或 N-API 返回组装异常会留下 failure latch，
不把未知返回当作可再做的效果；已 closed 状态不会因返回组装/重复调用退回 building。

## 必须成立但本 primitive 尚未绑定的前提

`mkdirat → openat → fstat` **只有在真正受控的 Host staging namespace 内**才可
用于 creator 证明。普通同 UID actor 可换入 foreign staging inode；本 addon 的
opaque cap、随机 nonce、0700 和原 fstat 都不能弥补缺失 kernel 隔离。
尤其 install 的 source basename 仍是 name-based：若 staging 被未受控 actor
替换，可能安装 foreign tree。因此本地 unbound API 只作实现/验证 primitive，
不可发布给不可信 caller 或接入产品直接放行。未来 adapter 必须从真实 Host scope
绑定：实际生效的 actor policy/backend、stage root/全部可改名祖先、继承 FD/IPC/debug
边界、原 execution/source 与最终 native binary/app identity；不可接受序列化自证。

受控 actor 测试仅证明该次实际通过现有 Seatbelt launcher 启动的 actor。Full Access
legacy/raw/external 同 UID actor不在该隔离承诺内。本实现没有新建特权服务、提权、
entitlement、权限/ACL 调整或全局安装。

## 同步 API

```js
const native = require("/explicit/build/output/office-local.node");
const held = native.openSession("/absolute/real/staging-parent", "/absolute/existing/destination-parent");
// Validate held.success and retain every returned object before any effect.
const tree = native.createDirectory(held.session, held.stageParent, "private-tree", "original-mkdir-effect");
const nested = native.createDirectory(held.session, tree.capability, "nested", "original-nested-effect");
const file = native.createFile(held.session, nested.capability, "report.docx", "original-file-effect");
native.writeFile(held.session, file.capability, docxBuffer, "original-write-effect");
native.fsyncResource(held.session, file.capability, "original-file-sync-effect");
native.closeResource(held.session, file.capability, "original-file-close-effect");
native.fsyncResource(held.session, nested.capability, "original-nested-sync-effect");
native.fsyncResource(held.session, tree.capability, "original-tree-sync-effect");
const publication = native.installTree(held.session, tree.capability, "first-missing-component", "original-install-effect");
// publication.nativeOutcome is independent of a later Host COMMIT/ack.
native.fsyncResource(held.session, held.destinationParent, "original-destination-sync-effect");
native.fsyncResource(held.session, held.stageParent, "original-stage-sync-effect");
const observed = native.observePublication(held.session, tree.capability, docxBuffer.length + 1, "original-canonical-observation");
// Check observed.success and observed.publicationFiles; snapshot never reissues bytes.
const closes = native.closeSession(held.session);
// Every result must be checked. This example does NOT establish scope or Core safety.
```

Other functions: `observeResource(session, cap, operationId)` only fstats an original
retained handle; `inspectSession(session)` only serializes native historical state;
`cancelSession(session)` stops forward effects. Raw FD integers are never exported.
Open return facts redact the descriptor as `descriptor_acquired_redacted`, not a fake
numeric syscall return. Absolute parent paths reject every symlink component and dot segment.

### 完整原 FD identity 与有界 readback

`readFile(session, originalFileCap, expectedSizeBytes, budgetBytes, operationId)` 必须
显式传五个参数；不提供默认预算，`budgetBytes` 必须严格等于 `expectedSizeBytes + 1`。
期望 payload 上限为 **50 MiB**，额外一字节只用于实际 `pread` EOF probe。
只接受 still-retained、building、已 fsync 的原 created-file cap；cancelled、closed、
unknown、foreign/clone cap 在 fstat/pread 前拒绝。数据 Buffer 与完整有限 Call 槽在
pread 前预分配，不以 caller identity/digest/布尔值证明真实内容或原节点。

```js
const read = native.readFile(held.session, file.capability, docxBuffer.length, docxBuffer.length + 1, "original-readback-effect");
// Check read.success, read.bytes, read.readback and every actual returned fact.
// This read must occur AFTER file fsync and BEFORE its original close.
native.closeResource(held.session, file.capability, "original-close-effect");
```

Native真实 fstat 返回完整 `identity` 与保留不改写的 `initialIdentity`：dev/inode、
sizeBytes、mtime/ctime 纳秒、mode、file/directory type。大整数与纳秒使用十进制 string，
避免 JS number 丢精度；mode/type 只是观察，不改变权限。每个 syscall fact 明确
`nativeReturnState / success / returned / errno`，并记录 native monotonic clock 窗口与
I/O requestedBytes/offset；它们不是 Core wall-clock/source/票的绑定。

Readback先校验真实原 FD 的 dev/inode/type 仍为最初 acquired node，再校验真实 size
与 native bytesWritten 等于期望值；原 FD `pread` 64 KiB chunks，读满期望数据后
在 exact EOF offset 实际读一字节并要求返回 0，最后第二次原 FD fstat 身份须完全
一致（不比较会因 read 正常变化的 atime）。任何错配不输出成功 payload；errno
失败、早 EOF、没有真实 EOF 或前后身份不同均 block。发现 FD 整数变成另一节点时
立即 unknown/-1，既不 adopt、pread 也不 close 该 foreign 整数。原 fstat 实际返回
EBADF 时同样立即 unknown/-1，避免其后整数复用被 closeSession/析构误关；其他
fstat errno 只 block，不据此推断原 lifetime 已释放。

Payload预算不是执行次数预算：pread attempts 上限为
`ceil(expectedSizeBytes / 65536) + 1 EOF + 32 retry/short-read allowance`，trace 至多
`attempts + 2 fstat`。原 write 同样 64 KiB chunks，最多
`ceil(sizeBytes / 65536) + 32` attempts（既有单次 64 MiB write 上限不变）。耗尽则
停止并保留部分原生事实/原资源，不无界增长或循环。**不承诺 timeout 可以中断单次
pread/fsync。** Native Session 在读前持有 readback fact record；native/C++ 或 N-API
Buffer/result marshalling异常不会抹除已发生的原 fstat/pread facts，且停止新 forward
effects。Session snapshot不缓存/重发 payload，不根据这些事实恢复原票或重新执行。

仍要求 readback 后原 file close 完成才 install。此 slice 只证明在仍持原文件 FD 的
读回窗口内的事实，**不证明 publish 后 canonical 终态或 Core whole graph safe**。

### Publication 后原 destination-parent-relative 观察

`observePublication(session, originalTreeCap, budgetBytes, operationId)` 严格四参数。
仅在原 installation syscall 成功、原 session 仍 published、原 destination-parent FD
retained、未取消时允许一次观察；原 destinationName、created-entry roster、原父关系和
file bytesWritten 全在原安装 syscall 之前由 Session 绑定。调用方不能传新 path/name、
identity、digest 或保护 boolean。总 payload <=50 MiB、roster <=128 条，budget 必须
等于全部原文件 bytesWritten 之和 + 每个文件一次 EOF probe 字节；不接受默认预算。

每一层从原 destination-parent 或本次 held readonly-parent 以
`openat(O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK)` 捕获，目录另加 `O_DIRECTORY`。
真实 fstat 必须匹配原创建 dev/inode/type/mode；foreign node 不 pread，不赋 creator、
write、adopt 或路径 cleanup authority。新 `publication_directory/publication_file` lifetime
只形成只读 close obligation，从不导出 cap，bytesWritten 始终为 0。原 size 取安装前
真实原写计数，而不是创建时可能为 0 的 initialIdentity.sizeBytes。所有文件实际 bounded
pread + EOF + 前后完整 identity 后，再对全部原 roster 做 parent-relative
`fstatat(AT_SYMLINK_NOFOLLOW)` fence，文件核完整 after identity，目录核原节点/type/mode。
原 destination-parent 也在观察前后核原节点；成功必须实际 guarded explicit close
全部本次只读句柄。失败停止新 forward，保留原 session 与 retained read-only handles。
只读 close/abandon 若核出 actual EBADF 或 FD 整数已复用为另一节点，则 unknown/-1，
不 close foreign FD。析构仍不输出 explicit-close proof。

Installation 和 publication 的实际 return/errno/identity、monotonic clocks、bounded trace
均保存为 native facts；native/C++ 异常留下 unknown_exception 和 once claim，N-API reply
异常也不能换 operationId 重做。成功 payload 仅当前 Result 的 `publicationFiles` 持有；
Session/inspect 不缓存或重发。只声明 observationBasis
`original_destination_parent_relative`，**不证明 destination parent 上方 absolute canonical
workspace namespace，也不证明整个观察窗口原子、Host protected scope 或 Core safe**。
单次 kernel syscall 不承诺可强制中断；同进程恶意 FD close/reuse race 不在隔离承诺内。

## 显式构建与真实测试

先选择全新的 ignored output 目录；父目录必须已存在。以下路径是占位示例，
不能复用已经存在的 output（即便为空也拒绝），也不会自动安装缺失工具/headers。

```sh
/Users/example/.nvm/versions/node/v22.22.1/bin/node native/office-local/scripts/build.mjs \
  --headers /Users/example/.nvm/versions/node/v22.22.1/include/node \
  --out /absolute/worktree/output/e6-20260928/office-native-build-fresh
/Users/example/.nvm/versions/node/v22.22.1/bin/node native/office-local/tests/run-isolated.mjs \
  /absolute/worktree/output/e6-20260928/office-native-build-fresh/office-local.node \
  /absolute/worktree/output/e6-20260928/office-native-tests-fresh
# Only the new publication slice, without re-running the historical 26 tests:
/Users/example/.nvm/versions/node/v22.22.1/bin/node native/office-local/tests/run-isolated.mjs \
  /absolute/worktree/output/e6-20260928/office-native-build-fresh/office-local.node \
  /absolute/worktree/output/e6-20260928/office-native-publication-tests-fresh publication
```

本机测试依赖已存在的 `packages/{core,daemon}/dist` launcher，只读导入，不调用
任何其他模块 build。测试 runner 不自动编译 addon，不做 runtime 安装。
Native lifetime executable是测试专用：真实关闭原 FD 后让 product close 得到真实
EBADF，再让 `/dev/null` 真实复用该整数，验证 unknown lifetime 不重试且不关闭
foreign FD；另一 retained-reuse case 验原节点错配只 fstat、不 pread、不关闭 foreign。
它不是 addon export，不提供产品绕过入口。`runtime-budget-injected.test.cc` 仅链接
到独立 test executable，以修改 libc 请求次数为一字节的 wrapper 确认有限预算；
**这是注入短 I/O 行为，不是实际自发内核短读/短写或实际 EINTR 故障**，不链接 addon。
`runtime-publication.test.cc` 同样只链接独立 executable：实际只读 FD EBADF/复用、
实际 EOF 后确定性 kernel root ABA，以及明确标注的短读预算和 bad allocation 注入。
这些不是 spontaneous kernel race、真实自发 short I/O 或 N-API marshalling 故障。
测试 fixture 仅在全部已
持原资源 explicit close 后，核对原 fixture device/inode，精确删除自己的 disposable root。

## 尚未完成的产品门槛

1. Daemon dedicated adapter 从真实 protected Host scope 绑定，原 source/admission/票不可重建。
2. Core v2 directory resource、creator/window、install provenance、fixed graph replay 与原 close receipts。
3. 六个真实 writer route 的 nested-directory 原终态/unsafe recovery 验收；已有 parent overwrite/leaf ABA 是独立门槛。
4. CI/desktop native 打包、Electron N-API、目标 macOS/FS 与 x64、最终签名/hash/manifest handshake。
5. Real EXDEV/ENOTSUP、mkdir 成功后 open/fstat fault、实际 EINTR/自发短 I/O、read窗口内并发写、进程丢失与 N-API marshalling fault未实测；不以真实 EBADF、静态 guard 或 test-only exception/预算注入代替它们。

Local build evidence 不属于产品 manifest，不改变当前 packaged readiness 或 Core safe。
