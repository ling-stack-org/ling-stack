# Office T2 — original readonly descriptor closure observations

## Scope and authority

`ProtectedHostStagePaths.readTerminalClosureFacts()` is an immutable snapshot
of the original directory descriptor capture and close slots. It is not a
live custody capability, mkdir creator proof, continuous canonical window,
Core certificate, journal settlement or permission to delete a path.

The reader performs no filesystem I/O. It never exposes an FD integer,
reopens a pathname, stats a potentially reused descriptor or adopts another
inode. Original uid/mode come from the first successfully matched acquired
descriptor, rather than a post-close observation.

| Observation | Meaning |
|---|---|
| `acquisition: returned`, `firstIdentity: matched` | Original open returned and its first fstat matched the captured directory identity. |
| `state: retained`, `close: not_entered` | Historical slot still holds its original descriptor; this is not a current-path check. |
| `state: unknown`, `close: unknown` | The original close was entered and tombstoned before the call; its return is not confirmed. |
| `state: closed`, `close: returned` | That original close returned normally. |
| `state: unknown`, `close: not_entered` | Original descriptor loss/reuse was detected before close; no close was issued against the foreign integer. |

Every snapshot and row is frozen. Later close operations do not mutate an
earlier snapshot. An unknown outcome stays unknown; reading or repeating
cleanup cannot change it to returned. Original close order, tombstoning,
partial-capture cleanup and all existing pathname/source/native guards remain
unchanged.

## Necessary remaining T2 work

The fixed original Supervisor/cache/runtime/scope bridge must bind to the
original Core V2 ticket. It must verify actual actor inventory, source,
canonical destination and protection coverage, independently of replaceable
fixture methods. The bridge must separate closing original readonly FDs from
releasing the controlled-process protection lease.

The intended settlement order remains:

1. Original parent/producer tickets and required child roster are ready.
2. Lock forward admission; verify original retained custody in the owning
   Core readonly transaction window.
3. Close original Host FDs once, retaining the protection map as
   `closed_pending`.
4. Independently verify and commit the V2 certificate and atomic journal pair.
5. Read back that same original committed pair before releasing protection.

The closure facts added here support step 3; they cannot implement steps 2,
4 or 5 by themselves. The Core safe-unavailable stub and current native-only
`coreSafe: false` outcomes remain in force. No product MCP route is enabled by
this change.

Full Access or another unrestricted same-UID program is outside the controlled
process isolation promise. This change does not expand that boundary.

## Verification recorded on 2026-10-06

- Test-only baseline: five new cases failed because the reader was absent.
- Fresh Daemon TypeScript build passed with Node 22.22.1.
- Five new real-FD cases passed, covering immutable no-I/O snapshots, actual
  close return loss/foreign reuse, actual EBADF/reused inode and path displacement.
- A sixth focused case passed at the synchronous close-entry boundary:
  reentrant reads see unknown before the syscall returns, never premature closed.
- Eight existing original-descriptor cleanup regression cases passed.
- All selected cases had zero failures and zero skips. These are local
  descriptor lifecycle tests, not full Office product, macOS 26 kernel,
  continuous-window, hosted CI or packaged GUI acceptance.

Raw logs remain in the isolated ignored QA output; no database, private content,
credentials or descriptor integers are published in the evidence API.
