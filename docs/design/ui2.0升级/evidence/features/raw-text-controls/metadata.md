# T12.1c 页面级文本控件迁移证据

## Scope

- 2026-07-24 AST 清单共 `57` 个原生 `input/textarea`；其中 `38` 个可达文本控件迁入共享
  `Input/Textarea/Field`，`1` 个关闭中的 Work Thread Search 继续作为 decision-gated 清单项。
- 文件、checkbox 和 range 共 `18` 个 Web 原生控件保留其真实语义，并全部使用
  `data-ling-control-native="true"` 声明 focused owner，不为追求标签归零错误迁移。
- Conversation Header Search 的 32px shell 使用 `20px` line-height；focus 由 shell 的 inset ring 持有，
  native border、outline 和 shadow 均为零。

## Automated Evidence

- AST guard：`UI 2.0 raw controls: text reachable=0, decision-gated=1/1, native-owned=18`；已接入 Web `lint`。
- Header Search：Channel、Normal、Teammate 双主题双 viewport `8/8`。
- T12.1c focused + Form compatibility：`22/22`。
- 第二批正式截图采集：Brief、Proposal、Approval `8/8`。
- 业务回归：Profile、Settings、Approvals、MCP、Workspace、Channel `142/142`。
- Web typecheck、i18n、lint、production build 和 `git diff --check` 通过；build 仅保留既有 large-chunk warning。

## Screenshot Evidence

First wave：`first-wave/`，10 张；Second wave：`second-wave/`，6 张。全部为真实 Vite 页面，截图时关闭
animation 并隐藏 caret；Light 使用 `1440x960`，Dark 使用 `1280x800`，Dark second wave 同时覆盖 reduced motion。

```text
fb4ff7e4be7b3ca9dba9100d9051e72943c26bd5d9b0182ea29e8c51d9ead00a  first-wave/1280x800-ling-dark-activity-context-summary.png
2ef0ecceaa0273cbff294b39154c3e20a754d5a5f34a1edb8fe38ee6e7b7263f  first-wave/1280x800-ling-dark-branch-shared-input-focus.png
0afc15b79b51bf7a9da9a460e95dc383d7093deadf972fc5d5fd57d9f9b415e9  first-wave/1280x800-ling-dark-channel-terminal-input.png
a374965210403ce675c784cc211fbe65803d85142ee1f73885e54296b88a1efe  first-wave/1280x800-ling-dark-channel-topic-reply-input.png
d50c4e72d3cae62ef3d8d8f1337065948e3d279b04c31f1e430125a301f53f7d  first-wave/1280x800-ling-dark-teammate-mcp-disabled-filter.png
4cec64a3b76de851078c55d0765871063da8a115b3f846426ab60bea6f81cb8a  first-wave/1440x960-ling-light-activity-triage-failure.png
fad9735da36fe9040e9365105260a2d8a253e349214b508efefe8227b6a96a71  first-wave/1440x960-ling-light-branch-shared-input-focus.png
23ae5e57847bc4661f12d4333557564bb0cb707326f3da84d19f5bdcd0bf248f  first-wave/1440x960-ling-light-channel-create-inputs.png
ac56a049a9d07a04faf759a4e268b651f539b7de22272449ea4ea53364490f9e  first-wave/1440x960-ling-light-teammate-mcp-search-busy.png
5e5cb193d0c8ccd70b31a2630bfb9c7a4b2b725f99ed2761b9fc0d2f5e738c78  first-wave/1440x960-ling-light-workflow-shared-inputs.png
dc80100007d8212d3c33f8bbf46788091c1b647bc67ce0bb63f8fd8e43849ba7  second-wave/1280x800-ling-dark-approval-reason-focus-busy.png
3cf94a40767474676b9fa9a90199550d687a3c0411b86260d1e869c32422c8b2  second-wave/1280x800-ling-dark-channel-brief-reduced-motion.png
bae1a010ebf06c849246b95eda622ae1821cfa11dee091d915a22057412bd632  second-wave/1280x800-ling-dark-channel-proposal-inputs-reduced-motion.png
769031ac850db93a818317890255e263d5c0b6db3b9baf9a50022d014bae1c48  second-wave/1440x960-ling-light-approval-reason-focus-busy.png
7fff877e30ddf1b1bf6842694f648d2b1f5cc0a133729d477f2065a8562e9e3e  second-wave/1440x960-ling-light-channel-brief.png
bc63df2f0cdfa8afd986fcf5695bb87ecff24a8a90a518b4db66a361dbaea311  second-wave/1440x960-ling-light-channel-proposal-inputs.png
```

## Visual Review

- Input shell、Textarea 和 Field 在 focus 前后宽高不变，ring 位于边框内部，没有双层 focus chrome。
- Header Search native line-height 至少比 32px shell 小 8px，输入内容和 caret 不再视觉贴边。
- Brief、Proposal 和 Approval 的长文本只在既定控件/页面滚动边界内换行，没有 document 横向溢出。
- 1280 Dark 队友 MCP 在窄内容列下将 server identity 与 action summary 分行，不再互相覆盖；测试同时锁定
  server row 分离、tool tree containment、Header 无矩形碰撞和 checkbox 16px focused owner。
- 独立 Profile 仍保留在 AppShell 分支但当前无导航入口，因此只使用源码合同和既有 Profile 回归验证，
  不伪造实页截图。

## Residual Boundary

- Work Thread Search 仍由 `channelWorkThreadTreeVisible = false` 关闭；guard 要求该唯一例外持续存在且不得误报完成。
- `ChannelInspectorPanels.tsx` 仍为 978 行；`ChannelWorkflowProposalCards.tsx` 仍为 1,639 行，属于后续架构债。
- 本切片不改变 API、contracts、数据库、路由、业务状态、Desktop packaged evidence 或 Logo。
