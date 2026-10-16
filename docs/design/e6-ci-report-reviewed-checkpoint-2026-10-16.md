# E6：B009 / B010 已审本地检查点

日期：2026-10-16。parent：`043e02df01c4d2ec43367bfa90f5878b51616acb`。

仅保存以下八个 owned 输入与本记录，不纳入另一 writer 的 delegation 文档、B011–B013
后继设计或输出日志。正常本地提交，不自动推送、建 PR、合并或发布；主 CI 不查询、不启用。

## 冻结输入 SHA-256

| 输入 | SHA-256 |
| --- | --- |
| packages/core/src/external-work-ci-triage.ts | `e6d24cc9cfb91ca7c45b1559e7b3d8b894cbef8d81200048753371908c599688` |
| packages/core/src/terminal-report-fallback.ts | `de219153c37c116a5d0e7a840d6cb6257f5f194c9cf0fbae63d7cb454a5aa3f8` |
| docs/design/external-work-ci-check-redaction-2026-10-16.md | `4eca5c39352e1ef9f4eeae1b3fd949d2c98d10903f7ea23c9254b1ef9f736c43` |
| docs/design/task-terminal-participant-fallback-2026-10-16.md | `289176dd9ec2b2dadf8ac1545e44682586d6a12b430ed80e13b6320b03d8679f` |
| packages/daemon/test/external-work-ci-redaction.test.mjs | `483dc723b9f85c862769b5b992decaab4b701aa77d65969866b480772799b804` |
| packages/daemon/test/support/task-terminal-empty-contribution-fixture.mjs | `6117027ab0b1d63ad10211381529dda53eff2a43c4d4a08b2cd4d52d78d663be` |
| packages/daemon/test/task-terminal-participant-fallback.test.mjs | `41682d811459fe27303da25805ff9ddd0cf4d25e1d63396145b4bd38e94c363d` |
| apps/web/test/task-terminal-participant-fallback.test.mjs | `3fa3a44838f6da4aefa2b4b7f73f640419e736fda1d9601dbb47aebf5ef38e9e` |

## 实际验证与独审

- B009 有效首 RED：1 pass / 8 fail，actual exit 1；fresh Core build actual exit 0；
  专用 9/9、四完整文件邻近 82/82，actual exit 0，零 fail/cancel/skip/todo。
- B010 最早 SQL NULL/DTO undefined setup 失败保留，不算产品 RED；修 fixture 后有效 RED
  10 pass / 16 fail、actual exit 1。fresh Core build actual exit 0；11 完整文件 159/159，
  actual exit 0，零 fail/cancel/skip/todo。
- 当前字节 Desktop source-input 412/412，actual exit 0；真实 esbuild，native/compiler/signing
  synthetic、fixtureOnly=true、artifactExecuted=false，不是实际 QA 包或 GUI 验收。
- B009 未实施者窄审：`output/e6-20260928/b009-a09-independent-narrow-review-20261016.md`，
  SHA `b618f673b2849aa453b19d56544bcc57bc498edd56d49fa4f133f8379c4d3639`。
- B010 未实施者窄审：`output/e6-20260928/b010-task-fallback-independent-review-20261016.md`，
  SHA `284a8b3daf887870f46570d1db29e914a091a41379732a37ce623b632d5e3f10`。
  两者均 scoped 无确认残留、approved=false；Root 已全文读与核 hash。设计随后仅同步状态。

实际日志位于 `output/e6-20260928/` 的 `b009-*20261016.log`、`b010-*20261016.log`
及 `b009-b010-desktop-inputs-final-20261016.log`。重叠测试组不累加作为唯一数量。

## 保留边界与剩余

B009 不迁移历史，旧 duplicate 可能原样复用旧行；不能声称历史凭据泄漏已清洗。
B010 只纠正空贡献的 deterministic 文案，不改变 Host status、sourceRefs、已有贡献或普通/私聊
typed-action 摘要；copy 函数测试不冒称本轮真实剪贴板。没有扩增大 coordinator 文件职责。

B011–B013、其余 B/C、公开 required 问答完整链、H10/H11、Office 具体用户批准、新 QA 包与
12 类真实 macOS 验收仍独立未完，总目标保持 active。根预算 D1/R1 未答不默认；A18 工具安全
拒绝不绕过。不生成 Office approved、不批准正式发布、不操作用户日常数据库或真实密钥。

另一 writer 文档 `docs/design/harness-delegation-storage-checkpoint-2026-10-09.md`
SHA `8acef2d140ed10724ab3a583533ec11b7cff4c3fabd45727c2159668e6e34044`，未编辑、未 stage。

本检查点无新增用户决策；上述既有预算和最终审核决策仍保留，不视为已解决。
