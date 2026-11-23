# Device Storage Settings Implementation Plan

Status: source implementation and Web E2E verified; native Desktop interaction and cross-platform acceptance pending
Owner: Core storage, daemon, Desktop browser and Web Settings
Last verified: 2026-11-23 (scanner, routes, Settings page and Web E2E; no real Desktop disk-size acceptance)
Canonical replacement: none; this plan owns the Device Storage feature until delivered
Code and test anchors: `packages/contracts/src/device-storage.ts`, `packages/core/src/storage/workspace-registry-store.ts`, `packages/daemon/src/features/settings/device-storage/`, `apps/desktop/main/browser/profile-size.ts`, `apps/web/src/features/settings/DeviceStorageSettingsPanel.tsx`, `apps/web/e2e/settings-storage-browser.spec.ts`

## Goal and visual contract

The [Device Storage concept](prototypes/settings-storage-browser/02-device-storage.png)
adds **Settings → Data and maintenance → Device Storage** to Ling Desktop. It answers:
how large are Ling-managed local files, which category contains them, and where can the
user manage that category? The concept image contains invented sample values. The
delivered page must show measured values and a measurement timestamp only.

This is an inventory and navigation feature. It does not introduce a generic
filesystem cleaner, batch conversation deletion, or permanent worktree snapshot
deletion. No server beyond the existing local daemon and Desktop process is needed.
The Web-only client hides the page because it has neither the Desktop browser
profile nor a complete local filesystem view.

## Existing ownership and counting scope

`resolveStoragePaths` selects either a repo-local `<cwd>/.ling-stack` root or a
user-data-dir workspace root under the Ling user home. The global user root also
holds plugins, provider settings, logs and the workspace registry. Managed worktrees
can live under the default runtime root or a custom absolute root; recovery
snapshots live at recorded private sibling paths. Browser profile metadata is under
Desktop `userData/browser-profiles`, while Chromium's persistent partition is
created per workspace by `desktopBrowserPartition`.

| Category | Included owned data | Excluded or separately classified |
| --- | --- | --- |
| Conversations and attachments | `sessions`, `attachments`, `artifacts` and other conversation-owned files beneath a registered workspace root | Mixed-purpose SQLite files go to Other; the category is a filesystem grouping, not a count of chat objects |
| Worktrees | Only daemon-recorded managed worktree paths and retained recovery snapshot paths, including a custom root | The canonical project checkout, arbitrary Git worktrees and user directories |
| Plugins and cache | User-level and workspace-level Ling plugin package/cache directories | Installed Desktop app binary and other applications' caches |
| Browser data | Metadata and verified persistent Electron partition storage for the selected registered workspace(s) | System Chrome, external Chrome plugin profile and files downloaded to the user's chosen folder |
| Other | Remaining files within Ling-owned user/workspace roots: databases, configuration, logs, memory, snapshots and exports | The application binary, OS caches outside Ling roots, unregistered or unverified paths |

The scope selector has **All registered workspaces** and the current workspace.
All includes Ling's user root once plus each registered workspace state root and
recorded worktree/snapshot, including archived registry entries whose owned state
root still exists. Current includes the selected workspace root, its recorded
worktrees/snapshots and browser profile; shared user-level data is excluded
from that subtotal rather than silently attributed to one project. The
registry currently has lookup methods but no enumeration method, so read-only
paged listing is a prerequisite. A removed or relocated registered path is
reported as unavailable, not rediscovered by scanning the entire drive.

## Measurement contract

V1 sums `lstat.size` for regular files. The UI calls this **Ling file sizes** and
does not claim exact allocated disk blocks: sparse files, APFS clones, compression
and filesystem snapshots can make physical space differ. Directory entries and
symlinks are not followed; symlink targets never enter the scan. A file is assigned
to exactly one category by the most specific verified owned root, so a
`user-data-dir` workspace nested inside the Ling user root is not counted twice.
On the same filesystem, repeated hard links are deduplicated by device/inode
where the platform exposes them. Totals are calculated only from classified,
deduplicated files.

The local scanner must:

- verify each candidate root against the workspace registry or server-owned
  worktree/snapshot record before traversal; resolve root identity and reject
  symlink/path escapes before and during traversal;
- walk asynchronously with bounded concurrency and a cancellation/deadline
  budget; do not block the daemon event loop or Desktop main UI thread;
- return `complete`, `scanning`, `partial` or `unavailable` per category,
  `knownBytes`, `scannedAt`, and a stable reason code for incomplete scans;
- keep a previous completed snapshot visible during a rescan, labelled with its
  original timestamp; do not replace it with a success-shaped zero;
- return only sizes, category, scope and status to Web. Paths and file names
  stay inside the trusted local scanner and diagnostic detail.

If any category is incomplete, the headline says **Measured so far** and the
segmented bar represents only measured categories; it must not imply that
unknown bytes are zero. The storage overview does not refresh continuously
while the user is editing other Settings sections. Opening it starts a scan
when its cached result is stale; Re-scan starts a new job and cancels the old
one for that scope.

## API and module boundaries

| Layer | Required change |
| --- | --- |
| Contracts | Add `DeviceStorageScope`, category/status/result types and strict parse limits. The snapshot carries `measurement: "logical_file_bytes"`, `knownBytes`, `complete`, `scannedAt` and category rows; no secret path fields. |
| Core | Add a paged, read-only registry enumeration method. Reuse runtime-path identity and recorded worktree ownership; avoid a second path registry or an on-disk scan index. |
| daemon | Add a local-only scan coordinator under `features/settings/device-storage/` for user/workspace roots and recorded worktrees/snapshots. Use bounded in-memory jobs with start/status/cancel operations, admission limits and workspace identity checks. No deletion endpoint. |
| Desktop | Add a separate read-only profile-size capability for browser metadata and the verified Electron partition path. Confirm the platform's actual partition storage path before counting; if unresolved, report Browser data unavailable instead of guessing. Keep this capability separate from conversation-scoped Browser actions. |
| Web | Add a Desktop-only section to `settings-shell-model.ts`, a controller that combines daemon and Desktop category results, and a compact Settings page using existing shared UI. Category actions navigate to Archived Items, Worktrees, Plugin Manager or a browser-data clear flow. |

The new scan API is local and read-only in effect. A suggested boundary is
`POST /device-storage/scans` with scope, `GET /device-storage/scans/:id`
for progress and `DELETE /device-storage/scans/:id` for cancellation. These
jobs are ephemeral and do not persist file inventories. The Desktop profile
result joins the same typed view model by workspace identity. If either
process is unavailable, the page becomes partial and keeps the working
categories visible.

## Category actions and data safety

- **Conversations:** open the existing chat/Archived Items surface. Permanent
  deletion stays an individual confirmed action with its current run and
  automation protections; Device Storage has no bulk-delete shortcut.
- **Worktrees:** open the Worktrees Settings page. Cleanup retains a recovery
  snapshot and therefore is not advertised as freeing space. The snapshot
  remains counted under Worktrees until a separately designed safe permanent
  deletion workflow exists.
- **Plugins:** open Plugin Manager. Uninstall and cache behavior retain their
  own ownership and verification rules.
- **Browser data:** open a choice of cookies, cache, site storage and history
  for the selected profile. Reuse Desktop native confirmation; explain that
  cookies and site storage may sign the user out. Refresh measured size only
  after that operation reports completion.

## Delivery slices and acceptance

The contract, paged registry read, bounded daemon scanner, Desktop profile-size
capability and Settings page are implemented in source. The Web test covers
measured and partial data plus navigation. Local scanner and route tests cover
symlink, hard-link, cancellation and access boundaries. A real Desktop profile
measurement and Windows run are still required before this feature is marked
native accepted. The page reports logical file bytes, not reclaimed disk space.

1. **Inventory contract:** fix category ownership and add read-only registry
   enumeration. Test repo-local, user-data-dir, shared data, archived entries,
   missing paths and custom worktree roots with temporary fixtures.
2. **Scanner:** implement root verification, non-following traversal,
   deduplication, partial results, cancellation and concurrent-request
   limits. Test symlink escape, hard link, unreadable directory, very large
   tree and interruption without relying on machine-specific disk sizes.
3. **Browser contribution:** verify Electron partition storage resolution on
   supported Desktop platforms, then add profile size reporting. Test profile
   isolation and unavailable-path behavior; downloaded user files remain out.
4. **Settings page:** connect scope, chart, measured timestamp, stale/partial
   states and category navigation. Do not place repetitive empty messages or
   raw file paths on the overview.
5. **Real validation:** run narrow Core/daemon/Desktop tests, owning
   typechecks and Web Settings E2E. In a real Desktop session, compare sampled
   file totals with the displayed logical-byte category results, verify a
   cleanup/rescan, then capture light/dark 1440×900 and 1280×800 states on
   macOS and Windows. A source test or screenshot alone is not release
   acceptance.

Follow the repository [Testing Policy](../../CONTRIBUTING.md#testing-policy)
for any added tests. New TypeScript tests must be discovered and typechecked
by the owning runner and CI gate.

## Related contracts

- [Workspace State Storage](workspace-state-storage.md)
- [Managed Worktree Lifecycle](managed-worktree-lifecycle.md)
- [Archived Items Permanent Delete](settings-archived-items-permanent-delete.md)
- [Desktop Browser Implementation Plan](desktop-browser-implementation-plan.md)
- [Settings UI 2.0](ui2.0升级/modules/settings/README.md)
