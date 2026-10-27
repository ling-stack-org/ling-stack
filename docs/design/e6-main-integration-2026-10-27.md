# E6 main 整合检查点 — 2026-10-27

这是源码整合记录，不是总目标完成、正式发布或 packaged GUI 验收结论。

## 固定输入与保留原则

- E6 输入：`f1357986fa273e809b495c7753517f9527ecbbbb`。
- main 输入：`d507c0480e95a47b5fe40e354c48eb7110c8c351`。
- 共同基线：`b3403df97c50e0cf54ea22765e0ebda64219e6d6`。
- 使用普通 merge，保留 E6 的 111 个和 main 的 32 个独有提交，不重写历史。
- main 的既有 CI 文件随输入保留；未启用、手工触发或新增本项目 CI 改造。

## 组合差量

1. AppShell 同时保留 message thread 和 branch root thread 参数。
2. 频道控制器保留 E6 observation epoch、暂停与 no-replay 边界，组合 main 的
   单一错误归属以及 workspace/branch 隔离。
3. 私聊保留 observation-owned publication，持久 assistant reply 拥有其错误，
   不额外显示重复的 workspace banner。
4. Daemon 同时保留 Harness 实际收尾和非 loopback 监听的 token 准入。
5. 55 个 catalog 逐 key 三方合并并由原工具重建 revision，未整份选 ours/theirs。

构建暴露 panel feedback 缺必填 workspace identity，现使用读请求捕获的 cwd。
组合回归还确定性复现：已收到终态 Host 业务错误后，typed transport loss 与暂停
分支会吞掉该错误。现先保留终态事实及其原错误 owner，再处理观察丢失；暂停时
不补读、不重发。原 RED 与最终 GREEN 日志均保留。

## 当前证据

| 检查 | 实际结果 |
| --- | --- |
| Frozen install、受影响依赖包编译 | exit 0；锁文件未重新生成 |
| Web tsc/Vite build；最终修改后 typecheck | exit 0 |
| 最终 Web 单测 | 1005/1005，无失败、取消、跳过 |
| Daemon continuity、收尾、监听、通知及 IM 组合 | 65/65 |
| Office＋诊断 | 15/15 |
| HTML preview＋marketplace | 7/7 |
| Desktop 原生 notice＋secret-worker 包装契约 | 7/7 |
| notification/HTML contracts | 6/6 |
| Localization 单测＋catalog audit | 20/20；55 catalogs、6890 keys |

详细命令、结果和原始失败日志位于本地
`output/e6-20260928/main-integration-progress-20261027.md` 及该目录的同前缀日志。
上述测试范围不同；不是全仓库全量重跑，也不是模型或客户端验收。

## 明确未完成

- 当前已运行的 QA App 仍绑定 f1357986 和原 ASAR，不覆盖此 main 整合组合。
  macOS 锁屏阻塞内置 Computer Use；未绕过锁屏、重启该实例或伪造截图。
- “只补 Node 依赖范围、续接冻结操作”的实现与 capture013 模型规划已通过，
  但客户端真实问题/回答、命令仅执行一次、正常 Quit 仍待原专用案例验收。
- main 改动了原生依赖、Office/打包输入；需新的差量独审、审核输入绑定和组合包，
  不能将旧 Office 审核记录直接视为覆盖新字节。
- P3 剩余真实客户端矩阵、H09 硬输出预算与本人认证、P5 最终 PR/main 核验仍开放。
- CI 继续按用户要求不处理；不正式发布、不做 Windows、不升级全局 gstack。

接续以本地 `output/e6-20260928/CONTINUE-HERE.md` 顶部最新覆盖为准。
