# P11.3 Approvals UI 2.0 Implementation Plan

Status：`verified (Web) / packaged Desktop pending`。

## 1. Scope

实施 [Approvals UI 2.0 零决策合同](16-Approvals.md)，关闭 `APPROVAL-LIST-001` 与
`APPROVAL-DECIDE-001`。保持 API、contracts、database、risk/status/reason 规则、external action、run resume、
Review Queue category 和 AppShell route 不变。

## 2. Target Owners

```text
apps/web/src/features/approvals/
  ApprovalsPage.tsx                    composition
  useApprovalsPageController.ts
  approval-view-models.ts
  types.ts                             domain-neutral resolution re-export
  ApprovalsHeader.tsx
  ApprovalToolbar.tsx
  ReviewQueueList.tsx
  ReviewQueueRow.tsx
  ReviewQueueDetail.tsx
  ApprovalSummary.tsx
  ApprovalDecisionPanel.tsx
  ApprovalDecisionDialog.tsx
  ApprovalPermissionDelta.tsx
  ApprovalExternalActionSection.tsx
  ApprovalTechnicalDetails.tsx
  ApprovalRunRepairPanel.tsx
  InlineApprovalStrip.tsx

apps/web/src/styles/approvals/
  page.css
  toolbar-list.css
  detail.css
  decision-dialog.css
  external-action.css
  inline-strip.css
```

`useApprovalsDomain` remains the only data/mutation owner. Move `ExternalActionBusyState` out of `ApprovalCard.tsx`
so domain does not import a presentation component type.

## 3. Task Plan

| Task | Content | Dependency | Parallel | Status | Gate | Weight |
|---|---|---|---|---|---|---:|
| P11.3-A | pure queue/status/risk/action/delta projections and fixtures | none | yes | verified | unit/focused projection coverage | 12% |
| P11.3-B | page controller, search/filter/selection/race/stale | A | no | verified | retained refresh + selection race | 16% |
| P11.3-C | PageHeader/Toolbar/DataRow list + detail shell | B | yes with D | verified | loading/empty/no-result/100 rows | 18% |
| P11.3-D | Approval summary/delta/external action/technical sections | A | yes with C | verified | all action kinds/risk/status | 18% |
| P11.3-E | decision Dialog/reason/busy/failure/authority refresh | B/D | no | verified | high-risk/duplicate/expired race | 16% |
| P11.3-F | Inline Strip shared decision integration | E | yes after interface freeze | verified | no duplicate state/ARIA/Composer overlap | 8% |
| P11.3-G | CSS cleanup, i18n, E2E, evidence and global closeout | C-F | no | verified (module + U13 selector owner) | static + selected + screenshots | 12% |

总计 `100%`。C/D 可在 view-model contract 固定后用不相交文件并行；只有主 Agent 修改最终 page composition、
shared locale 和全局矩阵。

2026-07-23 closeout：P11.3 模块代码、focused/baseline/selected tests、8 图和 metadata 已关闭。随后 U13
主线程已把真实 Inbox/Card owner 收敛到 `styles/approvals/*`，Channel approval detail 收敛到
`channel-overlays.css`，并从 `components.css` / `strict-console.css` / `workspace.css` 删除旧 Approvals
selector 与无生产引用的 `inline-approval-panel/head` family。该收口只迁移视觉 owner，不改变 API、状态或决定行为。

## 4. P11.3-A/B: Projection And Controller

1. Freeze Review category (`approve_external_action/offline_local_approval/route/repair/execute_approved_action`) and
   approval status/risk mappings from current helpers.
2. Derive one row primary state/action and readable owner/timing/delta summaries in pure functions.
3. Controller owns search、Actionable/History、category/risk filters、selected id、decision draft/Dialog/focus.
4. Refresh retains data on failure and exposes stale + Retry; initial error owns full state.
5. Guard all async results by cwd + approval/action id + revision; disappeared/expired item invalidates decision submit.
6. Preserve `inlineApprovalIds` dedupe and run-scoped repair mode.

Exit：no queue/status/action priority inside JSX; stale/race/selection tests green.

## 5. P11.3-C/D: Page, List And Detail

1. Shared PageHeader, icon-only Refresh, Search Input, Select/Tabs filters.
2. DataRow list with one StatusIndicator, optional real risk Badge, category/owner/time; keyboard selection.
3. 100 rows internal scroll; long title/path/reason/payload contained.
4. Detail sections: action summary, owner/timing, permission delta/evidence, external action, decision, technical details.
5. Raw payload/artifact refs default folded; unavailable detail shows scoped repair.
6. Run-scoped repair retains Clear/Open Run/Refresh and does not masquerade as normal Inbox filter.

Exit：`APPROVAL-LIST-001` implemented across loading/empty/no-result/stale/pending/history/expired/cancelled.

## 6. P11.3-E: Decisions And External Actions

1. Ordinary pending Approve/Deny use stable buttons; no inline second-confirm pseudo panel.
2. High/critical Approve opens shared Dialog. Reason required exactly when current rule requires it; failed submit retains
   reason and context.
3. Per-approval resolving busy; duplicate submit blocked; other rows remain usable.
4. API response becomes authoritative object; subsequent refresh failure marks stale without reverting resolution.
5. External Execute/Cancel remain separate action/busy/error owner after approval.
6. Route/repair actions use existing callbacks and truthful disabled reasons; no silent default target.

Exit：`APPROVAL-DECIDE-001` implemented; Toast dismissal never removes only failure/decision evidence.

## 7. P11.3-F: Inline Strip

1. Keep highest-risk primary + folded secondary, but migrate disclosure/buttons/status/delta to shared primitives.
2. Consume same domain resolving state and open the shared full decision owner for high risk.
3. Prevent duplicate aria-live announcement between strip and Inbox.
4. Keep Composer Send/Stop reachable and stable; long copy internal wrap, no overlay beyond Composer.
5. Rapid resolve/new approval/cwd switch cannot leave stale strip or enabled action.

Exit：Inline and Inbox resolve together; channel/normal/teammate conversation regression remains green.

## 8. CSS Migration

`approvals.css` becomes imports-only. Budgets:

| File | Limit | Owner |
|---|---:|---|
| `page.css` | 120 | page/list-detail responsive shell |
| `toolbar-list.css` | 200 | search/filter/rows/scroll |
| `detail.css` | 220 | summary/delta/evidence/technical geometry |
| `decision-dialog.css` | 140 | reason/footer/body scroll only |
| `external-action.css` | 180 | external action/artifact/file evidence geometry |
| `inline-strip.css` | 180 | Composer strip/disclosure/layout |

Dedicated owner 与新 owner tests 已通过。U13 已完成 matching legacy selector 的主线程清理；当前 focused CSS
无 literal colors、`!important`、`transition:all`、Theme/Profile ID、private keyframe/duration 或
`.ling-ui-*` override。`components.css`、`strict-console.css` 和 `workspace.css` 不再拥有 Approvals selector。

## 9. Focused Tests

Add `apps/web/e2e/ui2-approvals.spec.ts` covering:

1. initial loading、empty Actionable、History、search/no-result/Escape、100 rows scroll;
2. retained refresh failure/recovery、external detail partial failure、cwd/selection race;
3. queue category action matrix and no fake Approve/Deny for route/repair/execute items;
4. pending/approved/denied/expired/cancelled, expiration during open decision;
5. low/medium immediate decision and high/critical Dialog reason/Cancel/Esc/focus/busy;
6. resolve failure retains reason, retry success, duplicate request blocked, sibling remains enabled;
7. permission scope add/remove/unchanged, long paths/raw folded;
8. external action execute/cancel independent busy/failure/result;
9. route missing/no channel/navigation, run repair/Open Run/Work Board;
10. Inline Strip highest risk/count/fold/resolve/open full, no Composer overlap or duplicate announcement;
11. Light/Dark、zh/en、1440/1280、reduced motion、keyboard、no horizontal overflow。

Keep existing `approvals.spec.ts` as baseline; add selected `runtime.spec.ts`, `channel.spec.ts`, `app.spec.ts`,
`work-board.spec.ts`, `dark-mode.spec.ts` and Settings diagnostics regression.

## 10. Evidence

Capture the eight PNGs defined in the module contract using real Vite/daemon fixture. Before each capture assert:

- console/page errors 0 except explicitly acknowledged synthetic request failure;
- document/list/detail/Dialog horizontal overflow <=1px;
- exact theme/viewport/locale;
- one active overlay, correct focus and no animation midpoint;
- selected row, durable decision/external action state and Inline Strip ownership.

Metadata includes branch/HEAD、served URL、fixture、Theme Pack、locale、viewport、SHA-256、test totals and honest
packaged Desktop gap.

## 11. Commands

```bash
git diff --check
corepack pnpm --filter @ling-stack/ui-react test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web test:e2e -- ui2-approvals.spec.ts approvals.spec.ts
corepack pnpm --filter @ling-stack/web test:e2e -- runtime.spec.ts work-board.spec.ts channel.spec.ts app.spec.ts dark-mode.spec.ts
```

Playwright suites use one server serially or distinct ports; connection refused from competing webServer is test
orchestration failure, not product evidence.

## 12. Hard Stops And Rollback

- No API/contracts/DB/policy/risk/status/reason/Review category changes.
- No optimistic durable approval/external-action/run state.
- No merge of Review and Approval semantics.
- No second domain store, Toast provider, overlay root or document Escape listener.
- Migrate by controller/list/detail/decision/inline owner; rollback each slice independently before deleting old CSS.
- Production files <800, new owners <400; `ApprovalsPage` and `ApprovalCard` must shrink, not merely delegate render while
  retaining duplicate state.

## 13. Completion Gate

Both Function IDs can be `verified` only when code, focused/baseline/selected regressions, eight original-size screenshots,
metadata/hash/console/overflow audit, Light/Dark、双 viewport、zh/en、keyboard/reduced motion are complete; Inbox and
Inline state synchronize; permission consequence remains durable; imported Theme and packaged macOS/Windows gaps are
reported separately rather than inferred from Web evidence.

2026-07-23 Web gate result：`APPROVAL-LIST-001` 与 `APPROVAL-DECIDE-001` 均为 `verified (Web)`。imported
Theme Pack、packaged macOS Retina、Windows DPI/forced-colors 和全局旧 selector 删除未由本证据推断完成。
