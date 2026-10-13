# E6 与 main 的受控整合记录

日期：2026-10-13。唯一实施树为 `ling-e6-continuation/ling-stack`，分支 `codex/e6-safe-continuation`；不修改根 checkout。

## 目标与边界

用户要求 E6 与 Dependabot 两边处理，未通过的 PR 不合并。本次是已保存 A09 HEAD `af786bdbc99eb575203a5915b2f5bf1d30fbab7a` 与远端 main `dfb61aca41dfb1ab9e91df028debb2c5f732c433` 的本地非快进整合，不是把 E6 合入 GitHub main。

main 后继三提交：#528 的 Electron/Playwright/Vite/plugin-react 开发依赖和打包断言；#536 的入门/社区文档；#537 的 OfficeParser8/docx/diff 兼容改动及依赖更新策略。合入对应源码与测试，不能仅修改锁。

## 冲突解析与保全

实际 merge 唯一冲突为 `pnpm-lock.yaml`。只读候选内存批量选 ours 会生成重复 YAML key；整份 theirs 会回退 E6 Pi/Mobile/MCP 和安全补丁，因此都不采用。

用已提交 E6 原锁作 seed，原样应用 #528 的开发依赖锁增量，再由 pnpm 按最终自动合并 manifests 重解析。离线缓存只认识 Electron44.6，首次失败日志保留；在线 metadata 解析 actual exit0。最终锁唯一键合法，145 项依赖声明匹配全部20 importer，较A09锁151新增/142删除；frozen/ignore-scripts/force/side-effects-cache=false 真重import1302包，actual exit0，不修改配置、不绕hook、不清理真实数据。

保留 Pi双1.1、SDK57/React19.2.3/RN0.86.3、MCP1.32.1、directUndici7.30、全部安全 patches 和 Radix dismissal精准override；纳入 Electron44.7、Playwright1.64、Vite8.3.4/plugin-react6.1.2及OfficeParser8.1.1/docx9.9/diff9。E6 Radix其他minor锁定版本保留，不声称完全照搬 #537 每项升级。

main 自带的 Office/codesign 审核记录保持上游来源，不由此次 merge 自动批准新 E6 输入。A09 16输入仍与冻结一致。另一writer `harness-delegation-storage-checkpoint-2026-10-09.md` 未改、未stage，diff SHA仍312530d527ff7d209c8c281de4bc17e27261bfb7d15358a9006a281dc59e43db。

## 本次实际验证

原始日志位于 `output/e6-20260928/main-dfb-*-20261013.log`。所有产品测试入口清空继承环境，使用 `/tmp/ling-e6-main-dfb.SqnVln/user` 和独立 default workspace；直接 Node 集成还从独立 workspace 启动，不接日常数据库或真实 Provider。

- Daemon 与其 Core/Runner/公共依赖全链 build：actual exit0。
- Web/ui/conversation packages 及 Vite8.3.4 build：actual exit0；原有 chunk/dynamic-import警告保留，不标作性能验收。
- 十个完整 Node 文件：218/218、fail/cancel/skip0、actual exit0。包括实际 Office SDK bytes、共享原子settlement/取消、OfficeParser三格式、Pi1.1压缩/审批恢复、实际loopback Node fetch、共享overlay singleton、打包配置与Dependabot政策。
- 安全三组16/16＋2/2＋24/24，合计42、fail/skip0、actual exit0；验证实际安装的cache、图片解析、Forge、Braces、sprintf及消费边。
- Mobile typecheck actual exit0；Expo57配套离线check exit0，仅bundled/offline映射，CLI明确提示离线验证有限，不冒fresh远程依赖数据库或真机。
- 未实施者限定静态复核：PASS_SCOPED_WITH_LIMITS、approved=false；详见ignored `main-dfb-static-integration-review-20261013.md`。审阅者不冒领Root运行结果。
- 新增文档链接检查340文件、许可证检查1212依赖版本/23许可族均actual exit0。fresh源码公开扫描首次RED2为A21新测试合成凭据未明确标test；仅改两行样例字面，保产品凭据拒绝和原断言、扫描器/allowlist不改。完整该文件40/40、fail/cancel/skip0、actual exit0，fresh源码扫描4593文件actual exit0。原RED保留；二行增量由未参与改动者窄审通过，approved=false。A21旧整文件冻结不覆盖该test新SHA，后继记录为`main-dfb-fixture-credential-review-20261013.md`，不冒全历史secret scan通过。
- Playwright1.64匹配headless1248/ffmpeg1013安装actual exit0，不删除旧浏览器。八个完整spec的新矩阵25/25、零fail/skip、actual exit0（23浏览器案例＋2组件出口/viewport逻辑案例）；包括main改过的共享会话包边界、菜单/焦点/外点、Dialog忙碌/主题、Popover/Toast、Settings及三种会话反馈。Vite53129、API17891被mock、reuse0/retries0/traceon，fresh双隔离`/tmp/ling-e6-main-dfb-dom.6sgnih`；Vite实际defaultWorkspace变量与mock workspace一致、继承环境清空。日志`main-dfb-dom-20261013.log`与ignored trace目录保留，不改源码截图目录。不是旧1243或旧21例代签、真实模型或packaged macOS验收。

## 尚未完成与准入

这是draft备份范围，不是完整E6、Office原生执行、macOS新包或正式发布验收。安装ignore-scripts不证明新Electron binary已下载/运行。解析的既有Pi/OpenAI Undici peer提示未隐藏，实际directUndici loopback和Pi合约通过不扩大为全部真实Provider兼容认证。

#533仍需当前head适用CI、完整验收及审查；主CI停用/空checks不是通过。当前开放#533/#538–543均HOLD；后继只读队列复核已经完成，记录`main-dfb-pr-queue-review-20261013.md`：#539 React peer不满足、#540 SDK57/58混用、#541 Pi混版本闭包未适配；#538无确认静态缺陷但未验、#542 Undici major交界需实测、#543纯文档无确认缺陷但仅Windows packaging证据/作者要求未合并。全部exact-head checks/reviews为空，不代签通过、不关闭PR。#527关闭、#528–531/#537外部合并是既有事实，不重放或冒本轮合并。

后继继续A11上层API/IPv6、相关新增依赖的Office增量内容审阅与具体用户批准、fresh macOS联合矩阵及总计划其余具名项。没有新增产品设计选择；Office批准与适用CI/完整验收门未解除。最终本地merge/push/PR head及冲突状态以接续入口和live读回为准。
