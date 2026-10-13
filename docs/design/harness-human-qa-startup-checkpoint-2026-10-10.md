# H09 Human QA：隔离启动与待审打包检查点

唯一实施树为 `ling-e6-continuation/ling-stack`，分支 `codex/e6-safe-continuation`，
实现前 HEAD `e70614fc`。此切片只补真实 QA 的启动接缝，不重复159/160、Provider/Pi/Expo、
R03、时长或先前已完成的 UI 设计。根 checkout 与独立 writer 文档不修改。

## 根因与实现

当前 Cua `launch_app` 支持 `additional_arguments`，不支持任意 environment/cwd/app_path。
仅把环境传给 CLI 不能证明既有 Cua service 启动的 App 获得隔离环境。
原 Main 从环境读取 Daemon URL/workspace，Ling home 是另外的路径；只传 Electron userData
不能隔离整个链路。此前直接 executable 的 GUI 启动示例已经撤回，不能执行。

新的入口 `main/entry.ts` 只静态加载 Electron/Node/QA leaf：

1. QA 包必须带 exact profile flag；普通包带 QA flag、QA 包无 flag 均拒绝。
2. 私有 owned canonical profile/children 与有界 marker 验证先于任何 Main/runtime import。
3. 清除非 OS/locale 的继承环境，固定 Ling home/workspace/userData、17928、enforce/localWS=false。
   marker 只是 scope/synthetic 声明，不是批准、人工认证或沙盒 capability。
4. userData 设置与读回成功后，才动态加载既有 `main.ts`；无 QA flag 的普通启动不改 env/path。
5. QA 参数禁止未知 Chromium/Node switches、调试、额外配置、错配/重复路径；
   私有 marker 以 no-follow FD、4097字节硬读取界、首尾 inode/stat 与 exact JSON fields 验证。

固定打包选择 `LING_DESKTOP_PACKAGE_HUMAN_QA=1`，不是任意 Builder config override。
它只选择 `com.lingstack.desktop.human-qa` / `Ling Stack Human QA` / `release/human-qa`；
保留既有 source approval、原生 publication、签名、最终 archive checks 与 `publish: never`。
QA selection 在副作用前和配置导入后复核，非法值或漂移拒绝。
普通 lane 保持原身份、配置和输出目录。

独立审阅发现真实 Office hooks 从未审 `packages/daemon/dist` import 可执行 review 常量模块；
改为已纳入清单的 authored `src/...ts`。新增回归真实 RED→GREEN，没有放松断言。
新的 QA leaf/entry 是两项明确的 non-Office-build 审阅输入：
绑定它们的源码不等于完整生成 Main 图或 renderer 全量认证。

## 当前验证

收据均在 `output/e6-20260928/`，actual exit 从执行终态收回，不只看 TAP 文本。

| 验证 | 结果 | 收据 |
|---|---|---|
| 初始缺 helper/未审 dist RED | 64pass/4fail，actual exit1 | `h09-packaging-entry-red-20261010.tap` |
| 包 lane/hooks/Office检查 Node22/24 | 各186/186，actual exit0 | `h09-packaging-entry-final-node{22,24}-20261010.tap` |
| QA leaf + 真实 emitted entry→测试 Main 顺序 Node22/24 | 各51/51，actual exit0 | `h09-qa-entry-order-node{22,24}-20261010.tap` |
| 正常/QA/single-instance/Daemon/startup联合 Node22/24 | 各292/292，actual exit0 | `h09-qa-startup-joint-node{22,24}-20261010.tap` |
| Main 完整 TypeScript 编译 Node22 / noEmit Node24 | actual exit0、无诊断 | `h09-qa-entry-main-types{-node24,}-20261010.log` |
| 当前 authored-source 窄验收 | 1/1，actual exit0 | `h09-qa-entry-source-only-node22-20261010.tap` |

entry 回归使用实际 emitted entry 与 QA leaf，Electron/Main 是显式替身：
真实 process.env 在动态 Main 评估前被核验，normal env/path 保持、QA无flag不评估Main。
不创建 GUI/Store、不作 OS 认证。Office窄验收有实际esbuild，但native/codesign仍是替身；
4021runtime inputs /1185 authored workspace inputs、九包 dist为0，旧 compiled污染不影响输出。
未执行生成 bundle，不冒真实 Office 或 App 验收。

## 真实样本准备的中断

固定一次性合成 bootstrap 已执行一次，actual exit1；保留整个 profile，不重跑/删库/换namespace。
fresh Store、synthetic source graph、deterministic rule 都已读回；源 Task done、Run/WU/Attempt
succeeded 均为明确合成事实，不代表模型或工具执行。人类/模型调用事实仍为0。
失败在 config artifact readback：copied JSON 的 null prototype 与 SQLite JSON.parse 普通
prototype 被严格比较，内容/serialized bytes/SHA/configDigest一致，尚未 createBatch/enroll。
这是 bootstrap 断言错误，不是产品API或 sealed payload 损坏。下一只从未完成步骤 same-ID续接。

固定 profile 是 `output/e6-20260928/h09-packaged-human-qa-20261010/profile/`，只供 QA；
其实际 source IDs 与 safe receipts 记录于 `bootstrap-actual-20261010.jsonl`。
任何中断先只读 inspect，不能换目录/重置 namespace 绕过历史、quota或未知结果。

### 同 ID 登记续接已完成

独立 Agent 全文审阅331行 `resume-synthetic.mjs` 与原bootstrap修正，并限定只读核验同一
SQLite、source IDs、7份sealed artifacts和config/frozen/rubric digest；无新增confirmed P1/P2。
Root另全文审阅后只执行该resume一次，实际exec `759deb`、actual exit0；不重跑原bootstrap。
收据 `h09-packaged-human-qa-20261010/resume-actual-20261010.jsonl`。

- 原source immutable digest前后均为
  `4befe8d961a6d4e12c2e1825575b1ebe1ed3d1dec705c7adbfb85299d4c8779b`，不新增source/evaluation/grade。
- 仅通过public API新增一个QA batch、一个enrollment和一个queued/revision0 evaluation task：
  `evaluation_task_cbf29ce8-0cca-4deb-b8e9-324f61f81ef3`；namespace/batch/enrollment/task各1。
- request/attempt/result/human intent/event/head/audit/model或human grade均0；不算模型或真人验收。
- retained `resume-once.claim.json` 与Store close后首次写入的 `qa-profile.json` 均0600/nlink1；
  禁止重新执行resume、bootstrap或删除claim以重试。

审阅限定合作执行者与无后台writer的专用profile；各SELECT非同一事务快照、digest非全数据库
证明、未fsync父目录、不防不受控同UID writer/ABA。dist import在脚本内仅验证路径，不冒额外
冻结字节认证。scope marker仍不代表审核批准、人工认证或packaged GUI通过。

## 审阅与真实 GUI 门槛

用户已明确：上一 display-only 样例由本人确认并完成系统认证；仅记录该具体样例。
用户另已选择：独立 Agent 审阅后，由本人批准具体 QA 审核记录。
这不是现在已批准某个 source row，也不授权正式发布。

已留真实 compiler/SDKSettings/四Node headers/Electron run-as-Node runtime 指纹，
native15与packaging1282全量 SHA 仅冻结身份；记录 `approval: null`：
`office-human-qa-frozen-pending-packet-20261010.json`，SHA
`180bebb9e7362100640536175ed76046e3157e5ed8303aad10fefe9b0ab2b86c`。
版本 probe 为 Electron44.5.1 /Node24.21.0 /uv1.52.1，不是 GUI 启动或包验收。

独立 Agent 复用 unchanged native15 审阅，全文审选定 critical-chain/QA 差量；
剩余约1250 transitive输入没有全文独审，不能把 SHA 冻结称作完整内容审核。
完整 SDK/vendor/linker/OS也不在这些指纹的证明范围。
正式 Office source row仍缺失；不生成 approved、不跳过 gate、不patch旧App/asar。
具体冻结批准范围仍须澄清并由用户最终确认，之后才可 fresh package/Cua启动与 durable人工链。

未验：新 packaged GUI、滚动/取消、真人 durable提交/纠正/撤回/固定报告恢复、真实 grader、
Office/Keychain/Mobile/native与原macOS12类联合验收。总 goal active，不能标完成。
不 push/PR/merge/发布，允许 scoped local保存且独立 writer WIP不stage。
