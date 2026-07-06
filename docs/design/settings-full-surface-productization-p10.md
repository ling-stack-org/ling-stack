# Settings Full-Surface Productization P10

## Related Docs

- [Settings Visual Density Follow-up](settings-visual-density-followup.md)
- [Settings Diagnostic Density P8](settings-diagnostic-density-p8.md)
- [Settings Interaction Depth P9](settings-interaction-depth-p9.md)
- [P10 Implementation Plan](settings-full-surface-productization-p10-implementation-plan.md)

## Summary

P8 and P9 reduced parts of Settings, but the screenshot review shows that many
deep states still read like raw diagnostics or independent app pages. P10 makes
the screenshot evidence the source of truth: every reported screen has an
explicit target design, navigation boundary, and acceptance check.

Settings is a management workspace. It must not silently switch into the main
application shell unless the user chooses `Back to app` or a button explicitly
named `Open ... in app`.

## Screenshot Evidence Matrix

| Evidence | Settings surface | Problem | Target design |
| --- | --- | --- | --- |
| Fig. 1 | Council Workspace / Channel access | Empty copy wraps vertically, the blank panel is too large, and channel access looks broken. | Horizontal compact empty state, clear select/attach/open-channel grouping, and no oversized blank diagnostic frame. |
| Fig. 2 | Council Workspace / Council settings | Large form, low-signal copy, and action stacking make Settings feel like a full standalone workspace. | Summary-first settings tab with name, description, status, save as the primary action, and clone/archive in a low-frequency action row. |
| Fig. 3 | Work Board | List plus right inspector is dense, and `Open run` risks switching to the main shell. | Row selection stays in Settings; run opens embedded diagnostics; task/channel/approval exits only through explicit `Open ... in app` buttons. |
| Fig. 4 | Default authorization / Tool permission policy | Preset cards are oversized, advanced policy is exposed, and technical preview copy dominates. | Compact preset chooser, concise effective summary, tool decisions and write paths collapsed by default. |
| Fig. 5 | Default authorization / Execution runners | Raw runner ids, fallback values, and readiness internals are visible by default; rows are too tall. | Runner rows show enabled state, display name, readiness summary, and a details disclosure for ids/blockers. |
| Fig. 6 | Skill library / Source sync | Source path, health evidence, and preview space still form a diagnostic wall. | Top layer shows sync status and primary actions; paths, checksums, diffs, and context findings stay in details. |
| Fig. 7 | Skill library / Review queue | Large empty panels and repeated health/review frames make the empty state heavy. | Compact empty states, one queue summary, and candidate details only when work exists. |
| Fig. 8 | Archived items | Restore/delete rule text was easy to miss at the bottom, rows could stretch the page, and action icons could drift from labels. | A single muted hint sits under the title, each archived category has an internal scroll boundary, and row actions keep icon/text centered. |
| Fig. 9 | Startup and diagnostics | The page still has technical diagnostic copy and a weak task hierarchy. | Startup status, blockers, refresh, and run diagnostics entry only; startup phases and diagnostic evidence collapsed. |
| Fig. 10 | Run Diagnostics after opening from Settings | Settings opens the main app shell and shows the primary `Ling Stack navigation`. | Run diagnostics is embedded in Settings; Settings navigation remains visible and raw diagnostics are folded. |

## Settings Shell Boundary

- `Settings sections` must remain visible for Settings-owned management and
  diagnostics.
- `Ling Stack navigation` must not appear inside Settings-owned flows.
- `Back to app` is the normal exit.
- `Open ... in app` is the only allowed contextual exit for true work objects
  such as channel, task, approval, and private chat.
- Runs opened from Settings are diagnostics, not workspace navigation, so they
  stay embedded inside Settings.

## Screenshot-Specific Design Notes

### Fig. 1 Council Workspace / Channel Access

Default layer:
- Left list keeps `Create council` and `Refresh councils`.
- Channel tab shows channel selector, attached-council state, attach action,
  and a compact empty state in one horizontal flow.
- Empty copy must not use narrow columns or oversized empty cards.

Details layer:
- Attached council health and preferred/default state stay in the row.
- Channel opening is a contextual exit only.

Buttons:
- `Attach selected council`: stay in Settings.
- `Open channel in app`: leave Settings explicitly.

Acceptance:
- `.council-channel-empty` does not render vertical text.
- `Open channel` without `in app` is not visible in Settings mode.

### Fig. 2 Council Workspace / Council Settings

Default layer:
- Settings tab shows source/status chips, name, description, pinned state, and
  `Save council settings`.
- Built-in council edit blockers are short status text, not long explanations.

Details layer:
- Boundaries, reference collection, clone, pause/resume, and archive are in
  low-frequency disclosures.

Buttons:
- Save/pause/resume/archive stay in Settings.
- Teammate management uses `Manage teammates` near member context, not top page
  chrome.

Acceptance:
- Settings mode does not render the standalone `Council Workspace` H1/description.
- Clone/archive are not part of the default form scan path.

### Fig. 3 Settings / Work Board

Default layer:
- Row click selects detail only.
- Right detail focuses on status, next action, owner/claim, and related objects.

Details layer:
- Run evidence opens Settings diagnostics.
- Task/channel/approval navigation is labeled as leaving Settings.

Buttons:
- `Open run diagnostics`: stay in Settings.
- `Open task in app`, `Open channel in app`, `Open approval in app`: leave
  Settings explicitly.

Acceptance:
- Clicking a row does not show `Ling Stack navigation`.
- Clicking a run action shows `.settings-run-diagnostics-panel`.

### Fig. 4 Default Authorization / Tool Permission Policy

Default layer:
- Presets are compact choices.
- Effective permissions summary is the visible preview.

Details layer:
- Advanced workspace policy, write paths, raw tool decision lists, and policy
  preview details are collapsed by default.

Buttons:
- Preset selection and save stay in Settings.

Acceptance:
- First screen does not show workspace raw ids or full policy internals.

### Fig. 5 Default Authorization / Execution Runners

Default layer:
- Runner rows show display name, enabled state, readiness summary, and primary
  action.

Details layer:
- Raw runner id, fallback choice, readiness blockers, and runner metadata live
  under runner details.

Buttons:
- Enable/disable/check/save stay in Settings.

Acceptance:
- Runner ids and fallback internals are not visible until details expands.

### Fig. 6 Skill Library / Source Sync

Default layer:
- Source sync shows sync status, selected count, preview/publish actions, and
  compact records.

Details layer:
- Root path, detected roots, checksums, drift diff, context findings, and health
  diagnostics are folded.

Buttons:
- Preview/publish/archive/rollback stay in Settings.

Acceptance:
- Source path and checksum do not dominate the first screen.

### Fig. 7 Skill Library / Review Queue

Default layer:
- Review queue shows pending counts and candidate rows only when there is work.
- Empty states are compact and do not reserve large blank panels.

Details layer:
- Health findings, candidate evidence, cluster ids, playbook details, and import
  evidence are folded.

Buttons:
- Approve/reject/create draft/publish stay in Settings.

Acceptance:
- Health/review evidence is accessible but not fully expanded by default.

### Fig. 8 Archived Items

Default layer:
- A single muted hint sits below the page title:
  `Restored items return to their lists; channel and branch delete is permanent.`
- Archived rows show object name, type, archived time, and restore action.
- Conversations, AI teammates, channels, and branches each own a bounded list
  with internal vertical scrolling.

Details layer:
- Destructive delete copy appears close to confirmation.

Buttons:
- Restore/delete stay in Settings.

Acceptance:
- Restore/delete rules do not sit at the page footer or become a separate
  disclosure/card.
- Long archived lists scroll inside their own group instead of stretching the
  Settings page.
- Restore/delete action icons and labels are vertically centered.

### Fig. 9 Startup And Diagnostics

Default layer:
- Startup readiness, blockers, refresh, and `Open Run Diagnostics` are visible.

Details layer:
- Startup phases, warmup notes, and technical diagnostic explanations are folded
  or below the summary.

Buttons:
- Refresh and run diagnostics stay in Settings.

Acceptance:
- Startup page reads as status plus action, not as documentation.

### Fig. 10 Run Diagnostics Embedded From Settings

Default layer:
- Run diagnostics renders as a Settings panel with recent runs, selected run,
  status summary, and next step.

Details layer:
- Raw run id, work unit id, event log, task/channel ids, and support evidence
  are collapsed.

Buttons:
- Refresh/select/close stay in Settings.
- Closing returns to Startup and diagnostics.

Acceptance:
- `Settings sections` remains visible.
- `Ling Stack navigation` count is `0`.
- `.run-history-layout` is not visible for this Settings-owned flow.

## Interaction Semantics

- `stay-settings`: refresh, save, check, sync, create, edit, filter, select,
  tab change, details expansion, and local inspector selection.
- `open-settings-tool`: Model Workbench, Teammate Management, Council Workspace,
  Work Board, and Default authorization switching.
- `open-settings-diagnostic`: run diagnostics, run evidence, provider repair
  evidence, startup evidence.
- `open-in-app-explicit`: channel, task, approval, and teammate chat navigation
  when the label says it leaves Settings.

## Page Design Contracts

- Council Workspace keeps a compact list/detail surface in Settings. Channel
  access empty states must never collapse into vertical text. Channel opening is
  an explicit app-context action.
- Work Board uses Settings selection and inspector behavior. Run evidence opens
  embedded diagnostics. Work-object navigation is explicit.
- Default authorization keeps presets and summaries visible while advanced
  policies, write paths, runner ids, fallback internals, and blockers are
  folded.
- Skill library Source sync and Review queue are summary-first. Raw source
  evidence remains reachable but never fills the first screen by default.
- Archived items removes default policy copy from the first screen.
- Startup and diagnostics shows readiness and blockers first, then offers
  embedded run diagnostics.

## Acceptance Criteria

- All ten screenshot rows above have implemented and tested responses.
- Opening run diagnostics from Settings keeps `Settings sections` visible and
  keeps `Ling Stack navigation` absent.
- Settings-owned buttons do not leave Settings unless their label explicitly
  includes `in app`.
- No screenshoted surface has vertical empty-state text, oversized blank
  diagnostic panels, default raw ids/paths/status walls, or repeated gray copy.
- Desktop `1440x960` and `1280x800` have no horizontal overflow or button
  crowding on the affected pages.

## Assumptions

- Desktop Web is the acceptance target.
- Diagnostics are preserved and moved to the right disclosure layer.
- P10 does not change daemon APIs, contracts, database schema, or main IA.
