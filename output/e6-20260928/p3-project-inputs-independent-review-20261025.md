# P3 Node project-input 边界独立审查记录

日期：2026-10-25。审查者：真实独立子代理 `/root/c01_dependency_boundary_review`。

唯一工作树：`/Users/tianxiao/.codex/worktrees/ling-e6-continuation/ling-stack`。

审查提交：`4fdd39e12b37fe4c7d160defdcd266c008be5743`（`fix: stage source-authorized Node project module inputs`）。本次只读回读 HEAD 为 `b3c1937cd8fb5dac8515ca0d2249a23ff959a876`，上述提交是其 ancestor。

## 结论

**所选 Node project-input production/package 差量已完成独立审查，剩余已确认 finding 为 0。** 复用此前实际完成的内容审阅与独立 **8/8、exit 0** 边界测试，不重新运行已通过检查。本次只补精确报告、提交/当前字节比对及必要的定向内容/依赖接线读取。

十个 production/package 输入的当前文件与 `4fdd39e1` 内容相同：定向 `git diff --exit-code 4fdd39e1 -- <这十个路径>` 实际 exit 0、无输出。`node-command-inputs.ts` 与边界测试分别仍为既有审查回执中的 `33b4f5…`、`5cc247…`。

这不是整仓或所有所列文件的重新全文审阅；内容覆盖为新增 module 全文、该提交的全部相关变更块及必要的邻接 authority/capture/launch 调用链。未修改实现、候选构建、普通 `dist`、真实数据库、审核批准、Git index/history；未启动新的测试、编译、安装、打包或模型调用。主代理正在运行的最终全量回归不属于本报告的已通过证据，本报告不干预它。

## 实际审阅覆盖

| 文件 | 实际内容覆盖与结论 |
| --- | --- |
| `packages/contracts/src/channel-operation-bindings.ts` | 已读 scope contract、explicit path quote、binding validator 和该文件支撑校验。新增 `node_module_closure_v1` 只接受规范相对 project root、当前 local-user refs 和独立目录引用；禁止隐藏路径组件、额外字段或把脚本路径前缀当 root 引用。binding 限一个 exact Node command、明确入口，且 root 引用必须位于 command/invocation 外；原 read/write/network/environment 约束不被扩大。 |
| `packages/contracts/src/conversation-continuity-validation.ts` | 审查该提交唯一改动及邻接 `isExecutionOperation()`：`commandInputScope` 与 commandGoal 一样只能出现在 `run_command`；仍走严格 binding/exact-command/type 校验，不向 file 操作偷渡 scope。 |
| `packages/contracts/src/unified-exec.ts` | 审查新增 evidence 类型变更：derived input 保留版本化 kind、captured parent path/hash 与 project root；这是 provenance，不是新 grant 或新的执行成功判定。 |
| `packages/daemon/src/features/channels/channel-operation-bindings.ts` | 审查新增 candidate 字段、严格候选 shape、Host scope compilation 与邻接 quote/owner/input/command/fingerprint 路径。root 引用必须属于当前 operation/source item，不能仅来自命令参数、脚本前缀、历史或模型自称；Host 校验目录与 workspace 路径后才写入不可变 accepted binding，原明确 input refs/effectScope 保留。 |
| `packages/daemon/src/features/channels/context-packs.ts` | 审查新增 selector 指令所在变更块：候选模型只能提出带逐字来源的 project root，不能生成 binding/fingerprint/permission；真正 scope 仍由 Host 编译。没有把 prompt 指令本身当安全校验。 |
| `packages/daemon/src/features/runs/restricted-command-dispatch.ts` | 已读变更及实际派发函数：只把不可变 Run binding 的 `commandInputScope` 传给受控 runtime。仍核验 Run/Attempt fence、原 request snapshot、workflow operation authority、当前 workspace policy 与真实 command approval；async capture 与 atomic launch 保留既有 guard。未从工具文本接收任意额外 scope。 |
| `packages/daemon/src/runtime/sandbox/node-command-inputs.ts` | 新增 module 全文已审。仅解析已捕获 bytes，不 eval、不遍历整个目录、不 install、不读 origin fallback。literal relative JS/MJS/CJS/JSON import/export/require 递归闭包与 builtin 分开；未知 package、非 literal 或不支持的 resolver 形式显式拒绝。派生路径必须在接受的 root 内，排除隐藏/受保护组件；cycles/path 去重；每份派生 evidence 保留真实 parent hash/root-source IDs。 |
| `packages/daemon/src/runtime/sandbox/restricted-command-runtime.ts` | 审查 resolve/prepare 的全部本次变更与邻接 check、native capture、copy、sandbox compile、spawn/cleanup 路径。只对解析出的 Node command 开 module 分析；可选 package 元数据只先探测存在，所有实际 bytes 仍交同一 native directory-FD capture/owner guard；复制使用捕获快照。origin 继续位于 denied roots，网络/写入不会因 scope 增加，实际 spawn 前再次核验 authority。 |
| `packages/daemon/package.json` | 审查新增直接依赖 `acorn: 8.19.0`，用于新增 module 的 parser import；没有把全局/隐式 dev dependency 当生产依赖。 |
| `pnpm-lock.yaml` | 审查新增 Daemon importer 三行与已有 package/snapshot entry：specifier/resolved version 均为 `8.19.0`，复用原锁定包和 integrity；该提交没有新增解析版本或批量重写其他锁定内容。 |

本次必要补读用于把先前结论精确对应到以上完整 production/package 差量；没有发现需要更改实现的新问题，也没有以新读取替代未执行的运行验收。

## 关键边界与异常语义

- scope 是**本次 exact command 的输入准备范围**，不是任意 read 工具、write、network、environment grant。既有无 scope 计划仍只包含明确输入；缺失 local module 的情况在准备阶段以 `restricted_command_dependency_scope_required` 失败，不能在 origin 补读或把失败历史改成功。
- dependency facts 与用户权限分开：不能把一个 source import 当作读取外部文件的授权。仅对 Host 已接受的 root 与捕获 source 相交后派生文件；额外私有文件不随整个目录被复制。
- `.js` 必须在接受范围内找到有效 package 边界；最近 package 边界可封闭解释，不读取上层未授权 ancestor。找不到时显式 `restricted_command_dependency_package_boundary_required`，不把原 ESM 静默变成 CJS。`.mjs/.cjs` 保留明确格式。
- 256 个 captured files、16 MiB/file、64 MiB/command 上限包含直接与派生文件；JS source parser 另受 1 MiB 与 200,000 AST nodes 限制。不存在的 package 元数据不占 captured-file slot，但所有 metadata probes 共有 2,048 上限，避免无界探测。
- 链接、非文件、identity/owner 不匹配与取消仍由 native reader/authority 链拒绝，不能绕过为普通 JS 文件读。source analysis 不是针对所有 computed/obfuscated 访问的完整证明；OS sandbox 仍是最终访问边界。
- evidence 显示真实捕获的 path/hash/source refs，并以 `node_module_dependency_v1` 或 `node_package_metadata_v1` 标明 parent provenance，不伪称用户直接引用了每个派生文件。未新增 SQLite 表、未修改真实历史。
- Acorn 只是解析器，不是 Node 的完整 resolver。package-name、扩展名/目录搜索、非 literal import/require 等支持限制保持显式失败；没有宣称所有合法 Node 项目都可执行。

## 复用的独立 8/8 与原证据

此前本代理已实际完成独立 8 项、exit 0，结论已由提交内记录 `output/e6-20260928/p3-project-inputs-repair-20261024.md` 的 Actual receipts 保存。精确测试源为：

`packages/daemon/test/node-command-inputs-reviewed-boundaries.test.mjs`

SHA256：`5cc247cac3d7a37bab3d9cc97886401bbf8563ff1c46a525362c26718b893235`。

八项独立边界分别为：

1. 命令的 output-directory 参数不能变成 dependency-scope authority。
2. forged runtime scope 在任何 capture 或 metadata probe 前拒绝。
3. `.js` 缺少授权 package 边界时拒绝，而非改变 ancestor type 语义。
4. 更近的 package 边界封闭 `.js`，不向上多读。
5. absent metadata 不误占刚好用满的 file budget。
6. 已存在的额外 metadata 在 budget 满时，读取其 bytes 前拒绝。
7. 64 MiB 总量包含所有 direct inputs，并阻止下一次 capture。
8. 缺失 package metadata probes 有独立全局上限。

本次不重跑这八项，也不补造新的独立 stdout 文件。原 checkpoint 是 8/8 回执的持久证据；另有主代理原始组合日志 `project-inputs-final-delta-20261024.log` 的 65–71 行记录**当时七项** review 子集，末尾为邻接 **77/77**。不能把该较早日志本身误称为八项独立日志。

其他原实现/集成证据（不是本次新执行或本代理重复大套）：

- `output/e6-20260928/p3-project-inputs-repair-20261024.md`：binding RED→GREEN、independent boundary RED→GREEN、final pure 27/27、Contracts 95/95、Core/candidate Daemon 类型检查，以及本代理 8/8 原回执；其历史状态段不替代当前提交/包状态。
- `output/e6-20260928/project-inputs-final-delta-20261024.log`：原 adjacent binding/native-decoder/bootstrap 等组合 77/77，0 fail/cancel/skip/todo，actual exit 0。
- `output/e6-20260928/project-inputs-final-native-repaired-20261024.log`：原真实 native helper + Electron Node-mode 15/15，0 fail/cancel/skip/todo，actual exit 0。CLI 真实 import ledger，输出 `10000`，parent hash/lineage 可读回，unrelated private source 未复制、origin access denied，包含 hardlink/symlink/open package boundary/approval-owner-cancel/no-scope 边界。
- 原测试 fixture 的修正只补独立目录 source provenance；没有放松 production source-binding guard。先前失败的 native log 保留，不被绿色日志删除或伪装成未发生。
- `docs/design/restricted-command-project-inputs.md`：支持语法、权限与 capture/预算/异常边界说明；这是设计/实现契约，不单独充当运行证据。

## Acorn 接线核对与安装限制

本次只读确认：Daemon `createRequire()` 解析 `acorn/package.json` 到本工作树的 `node_modules/.pnpm/acorn@8.19.0/node_modules/acorn/package.json`，读回 version `8.19.0`。

锁文件同时具有 Daemon importer、`acorn@8.19.0` 的 resolution/integrity 与 snapshot。原 lockfile-only offline 尝试因无关 uncached keyring metadata 失败的记录仍以原 checkpoint 为准；随后只精确同步 Daemon importer。**没有运行或声称 clean install、全新缓存安装、网络依赖重解或 parser vendor 源码审计。** 本地可 resolve 只证明当前依赖存在，不替代 clean-install 可复现性验证。

## Production/package 最终 SHA-256

这些当前字节与审查提交相同；hash 并不把本报告扩大成未修改部分的整文件/全依赖审查。

```text
c6361443925a06119570d28c0f95903615a6600f2bb74e10046318f987f003ee  packages/contracts/src/channel-operation-bindings.ts
702b5e752bb7b54baf1114fca96ddf7a3fdd290dcce56449184fe37ec7820635  packages/contracts/src/conversation-continuity-validation.ts
ec30e8a96b6952947029aaa6b67657573add1a00a8a56c9228140f11cfe1dde6  packages/contracts/src/unified-exec.ts
ef1f4f9aa0143abdcc13888e1f2e66baefea93b2e38903e2c079fb11f81d5da1  packages/daemon/src/features/channels/channel-operation-bindings.ts
cf8dbd4f7b5562be89591595ae493d135c1ca190a6e6ec687454dcbd3f806d01  packages/daemon/src/features/channels/context-packs.ts
391661f65fda0e1a4d6c0383fe43d35ebeb7fdfb32f885e5dbcb11461daa7211  packages/daemon/src/features/runs/restricted-command-dispatch.ts
33b4f5acf317b04b232fdeb7194ee0ef3f878a8bc8f50cb6ea8afaf9243ce30b  packages/daemon/src/runtime/sandbox/node-command-inputs.ts
f23547fadf00274e5fed881bb1af510c7da8030e02f906891f0e435f4feb4dff  packages/daemon/src/runtime/sandbox/restricted-command-runtime.ts
ec6dd5d6e4264184ce27943d206befda3ea79be812f743978501fc9a5fe2087e  packages/daemon/package.json
610f7dec99ae3da4f04c1d0914641aaaae5b77a7c3c76dc62a09758216a1a4d1  pnpm-lock.yaml
```

## 支撑源码与既有证据 SHA-256

```text
5cc247cac3d7a37bab3d9cc97886401bbf8563ff1c46a525362c26718b893235  packages/daemon/test/node-command-inputs-reviewed-boundaries.test.mjs
7ba2b4580fc5c4a10f4a31c876f41ece7f25501a52899bea9af6d61ff47025b8  packages/daemon/test/command-project-input-binding.test.mjs
35d8cd46dd4cf612c1d8aabf2ace7180c10b77b3f15a7d8fb11bf7318e27e61d  packages/daemon/test/node-command-inputs.test.mjs
e5044ddc9fe9f2cd795dc71d1580d390cc64ac746f87e0dcd5c4a4616ef1fd60  packages/daemon/test/support/restricted-command-fixture.mjs
694ee32add525a0b8d7e3ede80526c70d890ac7b3cbf231a93d7bf470053d56d  native/sandbox/tests/restricted-command-dispatch-smoke.mjs
1b35093de0475dc4b1ea4e114ab5d094bcb385049cf42b9dd4a53e28f37e5db7  docs/design/restricted-command-project-inputs.md
f36fcf516ed46a9fcc8cfb21800b7d4f8bd5c2c4f377507ac1e8237ae1be3beb  output/e6-20260928/p3-project-inputs-repair-20261024.md
2efc0f564bccd537c51aa2f8214b2a5dd8fd5e4e786b43584486a06639a47baa  output/e6-20260928/project-inputs-final-delta-20261024.log
851dccf7e45e8feb270e934ecfaf27b61e9ab2ea181dd4b3f975ba142952ace0  output/e6-20260928/project-inputs-final-native-repaired-20261024.log
```

## 不包含的结论

- 不将 source/fixture/native CLI 通过当作新隔离 QA 包已编译、Office 审核已批准、真实 GUI C01 已验收、PR/main 已合并或正式发布。
- 不重新调查已通过 project-input 边界，不重跑大套，不改正在全量回归的候选。主代理须读取 exec65308 的真实退出回执后再报告组合测试状态。
- 不是 clean install、完整 Node resolver、第三方 Acorn 全文/供应链审计或所有同用户进程隔离证明；受控进程与 Full Access 边界保持既有约定。
- 相对 user-binding/command-cwd 语义、真实 SSE/Daemon restart、动态委派、Office/H09 与其余 E6 工作仍由各自计划/证据完成，本报告不替代。
- 若之后任一所选输入变化，需要针对实际差量重新核查，不能仅凭此报告或旧 hash 自动生成 approved。
