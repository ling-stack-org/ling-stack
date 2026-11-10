# A01 Browser descriptor 生命周期与跨实例协调

状态：两个根因的真实隔离 RED→GREEN 与后继增量独审已完成；不是 Office 审核批准或 packaged GUI 验收。
唯一实施树为 `ling-e6-continuation/ling-stack`，原 RED 基线 `360abd58`，最终实现基线为已合并的 `c557de47` 加本组冻结修改。
延续 E6 全量独审后继 A01，不重写浏览器授权或 Native Host 协议。

## 目标与边界

用户级 `runtime-v1.json` 可以由不同 workspace 的合法 Daemon 先后发布。
关闭旧实例不能删除后继文件；关闭完成后不能有在途刷新重新发布旧端口。
不同 workspace/port 的合法服务仍可运行，不能用 workspace 单例锁阻止它们。
这是同用户受控进程间可靠性，不承诺隔离 Full Access 或其它不受限同用户程序。
不改变 descriptor JSON schema、Native Host 路径、token/version/origin 校验或权限。

## 模块职责

| 模块 | 唯一职责 |
| --- | --- |
| Browser Host 私有协调 helper | 稳定 sidecar 的跨进程临界区、异步有界锁获取、准确错误与连接释放 |
| runtime-descriptor | 在同一临界区内作 generation 比较、真实 publish/remove、权限及 owned temp 清理 |
| Daemon native-broker | 捕获每代生命周期，start/close/refresh single-flight，closing 准入与在途 drain |
| Daemon stop 接缝 | broker 清理失败时继续既有其它 drain，最后准确上抛，不因新拒绝路径泄漏资源 |
| 隔离测试 | 包装真实 owned FS/SQLite/socket 与 child IPC 时序，不新增生产 fixture API |
| Desktop 审核 inventory | 新 authored helper 必须列入；冻结与具体用户批准另行完成，不继承旧 approved |

## 私有协调合同

采用与 descriptor 路径绑定的稳定 SQLite sidecar，无业务表，无 workspace Store 耦合。
先独占创建或打开同一个文件并限制权限；不能 truncate、rename、unlink/recreate sidecar。
目录 POSIX 0700、sidecar 0600；Windows 沿用既有 current-user ACL 链，不冒真实 Windows 验收。
每操作独立连接，`PRAGMA busy_timeout=0`，`BEGIN IMMEDIATE` 获取后才进入 FS 临界区。
只对 BEGIN 的真实 SQLITE_BUSY（Node `errcode` 主码 5）异步、有界重试；不得同步等待、
重试 IO/损坏错误、重放已产生效果的 operation，或超时后退回无锁。超时不抢删文件。
不对已开始的异步 FS/ACL 用 Promise.race 后释放锁；未 settle 就仍须持锁。
finally 精确释放本连接，保留原操作与 cleanup 两种错误。SQLite rollback 不撤销 FS 效果。

startup 为显式接管；refresh 带生产 CAS `expectedGeneration`，在锁内读取现有 generation。
缺失或不符为可区分的 superseded/no-write；坏 JSON、权限、IO 等继续失败，不当 superseded。
remove 在同锁内 read/compare/rm，缺失或不属本代为 false，真实失败上抛。
只清本操作用 wx 成功创建的 temp；EEXIST 不能删除他人文件。rename 后失败不得宣称零效果，
清理已发布文件也必须在锁内或重新取得锁后校验本代，不能无条件删路径。

## Broker 与关闭合同

回调捕获 lifecycle 对象/epoch，不读取后继的 global server/descriptor 作旧代清理。
close 同步标记 closing 并停 timer，拒新 publish；drain 已进入的 start/refresh 后再删除本代文件。
重复 close 共用完成结果；并发 start 不创建两个 server；失败启动仍可在完整清理后重试。
start 在 await 后检查 closing，不能关闭后继续 listen/publish/启动 timer。
startup 失败清理不得反向等待包含自己的 start/close Promise；refresh 同理避免自等待。
TTL candidate 仅在真实发布成功且仍为本代时更新本地 descriptor。
被后继替代停止旧刷新，不关闭旧 workspace 的合法 server/transport，不抢回 descriptor。
真实 refresh/cleanup failure 保留在可观测错误链；晚失败不清后继资源，不吞掉异常冒关闭成功。
Daemon stop 延后仅这一 broker failure，继续原资源关闭；后续也失败须保留两者。

## 行为证据与退出条件

先保留原产品的可信 RED：refresh rename 前暂停后 close 可先返并复活；A read(A) 后 B
publish(B)，释放 A 后误删 B。同进程与独立 child 版本均须真实 FS/端口，不用假文件事实。
GREEN 必须观察真正 B 锁争用再释放 A，不能在 A 持锁时等 B 完成或以 timeout 充当争用。
进一步验证：同进程让出事件循环；跨进程首次创建/互斥/崩溃释放同一 sidecar；superseded
refresh；start/close/失败回调/重复关闭；写/rename/ACL/remove/锁错误的准确失败与释放；
既有 handshake/expiry/generation/启动失败重试及 Desktop authored inventory 回归。
每组保留源码/dist SHA、实际 exit、原始日志、隔离路径与 child marker，不重复累计测试。

首轮 RED 回执：`output/e6-20260928/a01-browser-descriptor-red-20261014.md`。
真实 refresh/close 场景为 1 fail，同进程与跨进程 generation 删除场景为 2 fail，
均 actual exit 1、零 cancel/skip；不是 fixture 超时失败。原始日志保持不改。

真实 Windows ACL、exact packaged/source 对应、macOS GUI 与完整 E6 均各自独立，不因本
合同或窄 GREEN 自动完成。当前无新增用户产品决策；所有实现判断仍需行为验证与增量独审。

## 本组已完成验证

最终核心五完整文件 22/22、Daemon 四完整邻近 31/31、BrowserHost 正向选取六例 6/6，
均零 fail/cancel/skip、实际 exit 0；BrowserHost/Daemon direct TS build 实际 exit 0。
Root Desktop source-only 审核输入完整回归 304/304，真实 esbuild 两新 helper 来源与
source digest 相符，九 workspace 的 dist runtime inputs 为零。native compiler/codesign
仍为明确 synthetic fixture，不冒原生 artifact 执行或正式批准。

作者冻结：`output/e6-20260928/a01-final-implementation-freeze-20261014.md`，
SHA `6ab1390f7ba14c9a168f4e10abf2b99fa2dde646f2d8ec8315d29c8c7187a807`。
Root 回归：`output/e6-20260928/a01-root-desktop-validation-20261014.md`。
未实施者最终独审：`output/e6-20260928/office-full-content-review-20261010/a01-final-incremental-independent-review-20261014.md`，
SHA `7d2943bc588135a2b16d1f86ddd40ebc31754343f9025a2b309f3015103133f1`，
判词 `PASS_SCOPED_WITH_LIMITS / approved=false`，范围内无确认残留 P1/P2。
该独审绑定本合同补充状态前 SHA `5adf2b6269e450c40da40530403bfaf5441d026465ef3071516fb3547e32c77b`；
本节仅补真实验收状态和回执，不改变上述实现合同，不把新文档字节冒作原独审输入。

真实 Node22、Windows ACL、Office 具体用户批准、新 macOS packaged GUI 与 E6 其它项仍未完成；
主 CI 保持停用，不再作为等待门。此处没有新增未解决产品选择。
