# R02 packaged 双 SSE 断线恢复验收 — 2026-10-26

结论：本次新案例的真实断线、自动终态恢复、无重放、草稿/焦点/折叠保留通过。
不是全部 P3、H09 或 E6 完成；未测量 scroll anchor，不将其写成通过。

## 冻结输入与方法

- 产品源码 checkpoint `23e7e7ac`；QA 工具保存前基线 `1335660d`。
- 当前 ASAR `4db75650e50300c45fdc033f715ef231fa41dc1db0d670eaf1f34c1dfeb70c35`。
- 原正式 builder exit0；strict codesign、资源/模块及完整 Web 618 文件字节匹配通过。
- 仅原隔离 QA profile/workspace；relay 17928，受控后台 17930。实际 GUI Main 66400、
  backend 66373，归属 supervisor 66369。不是 Main-owned shutdown 验证拓扑。
- 使用 Codex 内置 Computer Use 提交唯一新任务 `E6-R02-RECOVERY-20261026-0310`，
  真实点一次 approve_once；不重发旧失败 nonce，不使用 CDP 或 cua-driver。
- QA supervisor 原继承 `ELECTRON_RUN_AS_NODE=1`，导致 GUI flags 被 Node 拒绝。
  实际 Main spawn 现在克隆 env 且仅移除此字段；原错误命令与 RED 保留，native GREEN 6/6，
  差量独审无未解决 finding。没有因此重打已匹配的产品包。

## 本次真实结果

- 运行 `run_4a41868f-67f4-4f8a-9919-c6bef11d6d07`，一个 Turn/Run/Attempt/action。
- 19:17:59.700Z 同时切断已有且收到数据的 control #61 与 execution #215。
  两条流都有真实 close；不是仅 DevTools Offline、reload 或新 GET 失败。
- Host 于断线期间 19:18:19.666Z 收到 command settled，19:18:23.347Z Run succeeded。
  marker 为同 PID 66565 的 start + 24 ticks + done 共 26 行。
- 19:18:32.650Z 恢复。control #672 以 afterSeq 816 续接，收到 817–833 和
  complete replay_ready。execution POST 只有一次，没有重发执行请求。
- 恢复后内置 CUA 真实截图/完整 AX 自动显示最终中文回复、一个 assistant copy，
  无 network error、无残留 running；草稿仍为“R02 未发送草稿 · 保留焦点”，焦点仍在输入框，
  执行区保持折叠。没有手工 reload/resend 来取得这个结果。
- 014（断线期间已终态）与 015（恢复后）Run 101 events、nextSeq 102、action revision、
  marker 字节全部不变；prepared/settled/tool_start/tool_end/result 均各一个。
- 后续只读 GET 已物化唯一 generation1 TerminalReport/result item，lineage/fingerprint 精确对应。
  report 是 deterministic fallback，含模型校验失败码，不能称为有效模型结构化报告。

## 证据与限制

本地完整证据目录：`output/e6-20260928/r02-recovery-successor-20261026/`。

- `.qa-evidence/003–005`：包、完整资源/Web 读回。
- `.qa-evidence/006–011`：QA GUI env 根因、保留的 RED/反例与 GREEN。
- `.qa-evidence/012–015`：未提交基线、审批中、断线期间、恢复后 Host 状态。
- `gui-{before,during,after}.png`、对应 AX 与 `gui-after-full-ax.txt`：真实客户端证据。
- `../r02-dual-stream-transport-20261026/topology-xIIqTR/001–005`：真实启动/切断/恢复回执。
- `assert-saved-recovery.mjs`：仅离线断言，不触发 API、工具、模型或数据库修改。

原 R02 失败目录保持原 verdict/截图不变。本记录是新的后继案例，不覆写失败历史。
command settled 的 descendants 仍为 `unverified`；不将 exit0 当整树 containment、
fan-in 或安全取消证明。此拓扑不替代 Daemon restart、动态协作联合与 Main-owned shutdown。
本次未测量滚动偏移、没有执行新复制操作；不替代既有 R03 真实复制验收。
Office pending packet 保持 false/null，不伪造新的个人认证；仅隔离 QA，不发布。
