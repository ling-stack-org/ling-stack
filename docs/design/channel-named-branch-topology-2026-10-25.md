# Channel named-branch topology, 2026-10-25

Implements the branch mapping in conversation-surface-taxonomy and Continuity v2;
does not replace Turn-level fork semantics or copy parent transcript items.

The sidebar's named-lane creation defaults to the channel's canonical root.
The Host captures its latest committed canonical item and owning Turn, then
uses the existing context projector and branch topology store to freeze the
context boundary. Subsequent parent turns must not enter the child projection.
The branch registry, child Thread and snapshot commit or roll back together.
An archived channel cannot create a branch. Existing rooted histories are not
silently relabelled or given invented historical fork boundaries.

An entirely empty parent is a valid origin: freeze an empty snapshot with
throughItemSequence=0, no segmentId, no summaries, and only the parent Thread
source ref. It has no parentTurnId because no Turn exists. The Host verifies
absence of both Items and Turns inside the creation transaction. A nonempty
parent can never use this exception. No synthetic Turn or ContextSegment is
created to satisfy a foreign key. First child input gets its own real assignment.

Snapshot storage permits a null segment only for this empty fork boundary.
Migration190 preserves existing snapshot rows, accepted-input payload fields,
indexes and foreign keys; it does not update conversation history. Nonempty
snapshots retain a valid parent segment and committed sequence watermark.
The empty snapshot remains empty after the parent receives its first message.

Native regression uses real SQLite and the real branch collection handler;
only HTTP stream objects/registry ownership are fixtures. Cover empty/populated
origins, no cloned transcript, future-parent isolation, rollback and foreign
channel rejection. Compiler checks cover optional empty-segment consumers.
Native tests are not macOS packaged acceptance. A successor package plus
built-in Computer Use must recheck root/topic/branch scope and shared UI.
