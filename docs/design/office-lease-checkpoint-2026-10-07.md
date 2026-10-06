# Original Office V2 lease checkpoint — 2026-10-07

This incremental checkpoint preserves the existing E6 work. It is not a claim
that the cumulative PR, production Office route or packaged macOS acceptance is
complete. The existing controlled-process boundary remains unchanged: Full
Access and other unrestricted same-user processes are not isolated by this work.

## Implemented in this slice

- The original composition retains exact Store/runtime/custody privately.
  Its release entry verifies the original authority, committed grant and close
  claim; callers cannot obtain the raw custody mapping.
- Runtime issues a synchronous one-use opaque permit only after the original
  closed-window proof. Registry removes exactly that protection member and
  retains private release history. Late permits, clones and foreign pairs fail.
- Real delete/history publication followed by lost JavaScript return reconciles
  against the same private history and committed Core pair. Historical retry
  after retirement performs no native-source reads or original directory closes.
- Preparation-to-first-fstat directory identity comparison now pins
  device/inode/mode/type without requiring volatile size/mtime/ctime equality.
  Full first-fstat history remains exact, and file readback identity is unchanged.

## Verification and boundaries

- Fresh Core and Daemon TypeScript builds passed with Node 22.
- New deterministic directory regression first reproduced two failures in Core
  observation and Daemon admission; the fixed identity/schema/replay run passed
  171 tests, with no skips.
- Release/composition/manifest/path-window neighborhood passed 70 tests, no skips.
- Reviewed native addon plus default original 20-source Host composition passed
  12 cases, no skips, including actual unrelated directory metadata changes.
  Real DOCX output is 8555 bytes with 15 original native effects.
- Clone/foreign/revoked/reopened-Store, synchronous reentry, coverage loss,
  retirement and real Registry history return-loss negative paths are covered.

These are local targeted tests, not the complete suite. The finite test writer
uses genuine native calls, Core gates and sealed facts but is not the production
MCP adapter. JavaScript return-loss is not HTTP/MCP acknowledgement-loss evidence.

## Remaining work and landing

Tracker V2 barriers are a separate in-progress slice. Production still needs the
bound adapter order: native closure, terminal seal, original close claim,
committed grant, lease release, Tracker local barriers, then consumer result.
Original MCP request correspondence, production factory/route and packaged
macOS acceptance remain required.

PR #507 and #509 remain unmerged. At the verified snapshot, #507's required CI
did not start because of GitHub account payment/spending-limit restrictions and
independent review was absent. #509 has real build/license failures and major
API migrations. Local targeted green results cannot replace required CI or
independent approval. No protection bypass or dependency-policy change is part
of this checkpoint.
