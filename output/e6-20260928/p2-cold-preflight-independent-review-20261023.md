# P2 冷资源 preflight 差量独立审阅

日期：2026-10-23。审阅者：`/root/p2_cold_preflight_review`（未参与本差量实现的 Codex 子 Agent；不声称独立模型）。

结论：**本次选定差量 0 项未解决 finding**。先前发现的失败后准入测试缺口已关闭：当前测试在真实正常实现上通过，在仅内存移除停止条件的 mutation 上确定失败。此结论不是用户批准记录，不授权发布，也不代表整个 packaged 冷启动或 GUI 验收完成。

## 范围与精确输入

唯一工作树：`/Users/tianxiao/.codex/worktrees/ling-e6-continuation/ling-stack`。

基准 HEAD：`78f0f9abe701a17e949a49194fc5a7652098cb36`。只审阅以下两个文件相对该 HEAD 的差量，并定向阅读原 verifier 与调用链：

| 输入 | SHA256 |
| --- | --- |
| `packages/core/src/bundled-skill-source.ts` | `897f55f83b565ce7e736ffd2f65d7b5f4426202344133c44d8a59050722b53d6` |
| `packages/core/test/bundled-skill-source.test.mjs` | `4461f60a162f87a972e4f0fbffe2e81247b68840c602564187c798959567363b` |
| 测试实际导入的既有 `packages/core/dist/bundled-skill-source.js` | `41cc964907bcc83cdae9f1debdadbd14832f9d875df952863bca2e5a5b37aefb` |

完成验证后重新读回上述三项哈希，均未改变。未重编译或修改 dist。

## 核验结果

1. **并发有界**：源码第 7、154–168 行最多启动 8 个 worker，共享取项游标；不是对完整 manifest 无界建立文件任务。
2. **原准入守卫未放松**：第 61–114 行保留 root/manifest identity、技能及完整文件 inventory 校验；第 115–148 行原 verifier 保留路径/符号链接、inode/dev、声明大小、完整 SHA256、读取前后 stat 校验。preflight 仍传入 `retainBytes=false`，使用原 64 KiB 流缓冲，不把整个资源保存在内存。
3. **失败先停准入、再等待排空**：第 158–167 行在 worker 捕获拒绝后设置共享失败标志，后续循环不再取新文件；所有 worker 结束后才向调用者抛错。第 145–147 行原 `finally` 销毁 stream 并等待 handle.close；没有 fail-fast 返回同时留下兄弟读取运行的改动。
4. **lazy read 不变**：第 169–179 行仍在每次 `readSkill/readResource` 时调用同一个 verifier 并保留实际字节，未新增绕过校验的缓存。
5. **调用链仍等待完整准入**：定向阅读 `bundled-startup.ts`、`packaged-startup.ts`、`packaged-history.ts`；发布技能、保留 generation 和安装 runtime 的前置 verifier await 没有被本差量取消。
6. **成功测试保护并发和完整性**：测试第 78–92 行验证实际并发大于 1、不超过 8、最后 0 个打开 handle，并比较 canonical root 下全部 manifest 文件的打开清单。macOS `/var` 与 `/private/var` 的 fixture 预期问题已用 `realpath` 修正。
7. **失败测试保护停止和排空**：第 95–129 行对 LICENSE 作同长度字节篡改，保证真的进入打开/哈希路径；LICENSE 首次 stat 等首轮 8 个 handle 全部打开，另 7 个 handle.stat 被显式 promise gate 阻塞。断言失败处理期间仍有 7 个 handle 且外层未 settled，释放后确认全部关闭、不发布 source，并最终断言总打开数仍为 8。最终断言不依赖一次 `setImmediate` 是否足以完成后续文件 I/O。

## 实际执行证据

正常验证命令：

```sh
node --test packages/core/test/bundled-skill-source.test.mjs packages/core/test/bundled-skill-browser.test.mjs
```

实际退出码 **0**：`tests 28 / pass 28 / fail 0 / cancelled 0 / skipped 0`。覆盖现有 manifest 限额、路径/符号链接、缺失及额外文件、哈希篡改、不可变 identity、lazy 等长度篡改等相邻回归。

反向验证只在内存将已构建模块的唯一 `while (!failed)` 改成 `while (true)`，经 `data:` 模块导入当前测试，不写回源码、dist 或测试文件；仅选中失败测试。实际退出码 **1**：`tests 1 / pass 0 / fail 1`，失败断言位于当前测试第 125 行：

```text
AssertionError [ERR_ASSERTION]: draining siblings must not resume admission after failure
28 !== 8
actual: 28
expected: 8
```

该 mutation 在最初版本测试及只检查中途打开数的版本均曾通过；本次最终断言已使相同回归被真实检测，不把旧版本测试的通过冒充当前证据。

## 限制与未授权事项

- 未复测大资源实际冷启动耗时、未启动 App、未调用模型、未运行 GUI 案例。本报告不声称 8-worker 本身已解决 Desktop 的 20 秒启动期限。
- 没有审阅后续拟新增的 bootstrap/fd4 阶段或其权限协议；它们需要另行冻结差量和审阅。
- 未重新阅读此前已完成审阅的全部打包依赖输入，也未重跑全套 Core/Daemon/Office 测试。
- 本次只新增本报告；没有修改实现、测试、数据库、批准 manifest 或 approved 字段；没有提交、推送、合并或发布。
