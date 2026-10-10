# H09 人工评估 160：实施与验收检查点

唯一实施树：`ling-e6-continuation/ling-stack`，分支 `codex/e6-safe-continuation`。
基线提交 `fd7e6655`。本切片只有本地保存授权，不推送、创建 PR、合并或发布。
设计合同见 [QA producer](harness-evaluation-qa-producer-detailed-design.md)。

## 已实现的完整内部链路

- migration 160：一次性 intent、当前 head、append-only event；不改 137 grade、159 请求额度、
  原 Run/Attempt 或 promotion 样本。严格来源为已登记 QA 与脱敏审阅 artifact pins。
- Host 冻结 evaluation、五项 pins、sealed config/rubric、当前 head 和七项 authority binding；
  digest 为 UTF-8 `JSON.stringify(payload)` 的 SHA256，不是任意重新排序后的 JSON。
- intent 消费、head CAS、纠正/撤回事件、durable control-plane audit 在同一 own transaction。
  审计或最终同步 authority 检查失败全部回滚；拒绝异步检查和 DTO 重入改写。
- private loopback Main ingress；随机 confirmation key 仅在 Main/Daemon 私有内存；逐 payload
  native 确认后才产生 HMAC。独立于 Computer Use、锁屏控制开关和 active Run。
- Main exact owner webContents/mainFrame/已知 app URL；preload 仅公开 submit/cancel/inspect。
  Renderer 不能提交 authenticated、adjudicator、secret 或任意 Host 路径。
- 每项单独 native invocation；完整冻结 payload 可滚动显示后再执行系统用户认证。
  before/after 检查 session/user/lock/epoch/expiry；取消、超时或缺 helper 不退化为 token 认证。
- abort/error/timeout 只请求终止 native child，实际 close 前不释放 busy；shutdown 等真正 drain。
- 失响应不重发；最多32个私有 unknown intent 可通过 inspect 只读核对 consumed/pending。
- 有界 revision 分页，返回实际最新 headEvent；报告引用固定 `{taskId,eventId,revision}`，
  纠正/撤回后判 stale，不修改旧引用。这是读回能力，不是已接通的完整报告 producer。
- 固定 resources helper 路径、realpath/symlink/X_OK 验证及 macOS package entry 已接线。
  Office fixed authored inventory 已包括五个 Core、四个 Daemon runtime leaves、type-only contract
  和 native build/source；不伪造正式 source-review approval。

## 本轮真正复现并修复的边界

1. 私有 HTTP writer 调用公共 `writeJson` 后重新加 CORS：改私有 writer，真实 HTTP 回归验证无 CORS。
2. Undici Main fetch 自带 `sec-fetch-mode:cors`：不能仅凭它拒绝可信 Main；仍拒 Origin/sec-fetch-site。
3. 大页读回预算：100条合法中文事件超过65KiB；最坏 JSON 转义的4000 code-unit rationale
   使合法页超过2MiB。snapshot 改独立4MiB UTF-8 byte cap，mutation仍65,536 bytes；
   实际 Main client→HTTP→101真实 SQLite events 验证完整分页，超过4MiB拒绝并取消响应读取。
4. postcommit/revoke 清理期间窗口/epoch变化：新增4个 controlled RED（0/4），修为 cleanup 后
   current fence 与 IPC 返回前 exact-owner 检查。失效只撤回复权限，已 COMMIT 事实不回滚；
   保存 exact unknownIntent，后续只读核对，不再认证或提交。

OS 变化和已进入服务端事务的提交没有跨进程物理原子性。Main abort HTTP 不证明服务端回滚；
上述 unknown/readback 正是这个边界的处理方式，不能宣称锁屏会抹掉已经提交的事实。

## 真实收据与尚未完成的验收

收据位于 `output/e6-20260928/`；失败、中间和最终日志分开保留。

- Core focused Node22/24各107/107、最终 full2823/2823，actual exit0。
- Daemon作者最终最坏转义 Node22/24各21/21，actual exit0；真实 Main client/HTTP/SQLite，
  不是 OS 身份或模型验收。索引 `h09-human-daemon-verification-receipt-20261010.md`。
- Desktop最终 focused Node22含source-only371/371；Node24不含该source-only135/135；
  actual bundled preload 独立双Node各6/6。最终 full2144pass/3Windows-onlyskip，actual exit0。
- workspace最终 `typecheck:ci` actual exit0；Main tsc与实际 preload esbuild exit0。
- Office source-only236/236，actual exit0；native/codesign调用为测试替身，不等于正式 approval。
- 真实 Swift helper最终编译及 session probe通过：`h09-human-native-final-build-20261010.json`。
- Daemon首 full4036pass/1cancel/0fail，actual exit1：旧媒体 `submission-precommit` 命中8000ms
  timeout。原日志 `h09-human-daemon-isolated-full-20261010.tap`保留，不算全绿；不改断言或超时。
  同文件隔离串行24/24、exit0；完整串行复验进行中，终态须另外读回后更新此记录。
- 46份 source/test SHA manifest：`h09-human-final-source-20261010.sha256`，逐项check OK。
- 一次 preload tsc误生成的10个旁路 `.js` 已移动到专用临时归档，不 stage，不当源码；
  后续 preload tsc只用 `--noEmit`，实际 CJS由esbuild生成。

真实 native 长内容 UI尝试因 Computer Use/auth 未可用，owned timeout实际结束 child；未取得
可验证滚动/取消截图、真人身份认证或 durable 人工样本。失败日志保留，不计 OS/UI通过。
真实 grader completion仍0。可见 QA 表单、独立报告 producer、正式Office approval/隔离Keychain、
Mobile native，以及 owned macOS12类验收仍未完成。不能标整个 H09 或总目标完成。

## 下一切片：可见 QA 与 report-only 接线

不重做160、159、Provider/Pi/Expo、R03、时长或旧 Codex研究。复用现有模块：

1. Core窄的 enrolled-task只读分页：按 canonical namespace/enrollment JOIN 后再 LIMIT，
   包含 completed/unknown，不借只返回queued的worker selector，不枚举普通会话。
2. 私有 Main capability返回最小QA元数据；在现有启动与诊断设置中放独立QA panel/controller，
   不把人工表单塞进运行时间线，不公开批量授权。
3. 单项 adjudicate/correct/revoke；exact head event、重复提交禁用、unknown先inspect；
   native最终确认仍显示完整Host冻结对象，表单不是人类身份认证。
4. 独立QA human报告 producer：固定 enrollment/event/revision/intent/audit/pins/config/rubric，
   report-only，不伪造137humanGrade、不加入promotion统计阈值；读回缺失或漂移显式unavailable。
5. 可见报告保留immutable引用；旧报告只标stale，用户显式生成新报告。覆盖scope切换、分页、
   correction/revoke、失响应读回、真实 packaged UI，再做预算内真实模型核验。

本切片无新的用户政策待选。H10根预算仍独立未答，不能套用H09预算或D1 A，dynamic children不开启。
总目标保持active；独立writer文档不改、不stage，根checkout不改。
