# Channel-authorized command inputs

Status: approved scope, source implementation and targeted verification complete.
New packaged-client acceptance remains open.

## Decision and precedence

This supersedes the requirement in `restricted-command-project-inputs.md` that
every new Node closure needs a separately quoted user directory. Channel workspace
binding is a location, not permission. Host may prepare dependencies only when the
current channel and participant allow read, the actual effective read decision is
allow, and the execution root is ready and verified. Existing permission presets
are not changed. An ask/deny decision is not implicit read permission.

Explicit task constraints narrow this upper bound: an explicit projectInputRoot
keeps its original local-user provenance; direct-input-only and ask-first requests
cannot acquire an automatic scope. The model identifies semantic constraints in
quoted instructions; a conservative Host guard also blocks automatic inheritance
for explicit single-file/ask-first restrictions. This is not a claim that regexes
prove arbitrary natural-language intent. Ambiguity is clarified, not expanded.

An explicit prohibition on asking for broader scope is not an ask-first
request. In particular, “执行前…不要询问扩大授权” must keep an accompanying
single-file limit instead of creating a project-root question. The Host guard
masks explicitly negated question verbs only for its positive ask-first check;
the original source still supplies all file restrictions and provenance.
Missing dependencies then remain capability/scope blockers, not permission to
expand or a reason to repeatedly request a directory.

Only newly bound operations may receive policy scope. Existing accepted plans,
pending drafts, Runs and Attempts are never retroactively enlarged. A recovered
pending draft still accepts only its named slot patch, not a replacement graph.

## Serialized scope, issuer and identity

Keep `node_module_closure_v1` and direct `effectScope.readPaths` unchanged. Add an
optional `policyAuthority` to commandInputScope. User-root scope retains its exact
existing representation; policy scope uses sourceRefs=[] and a separately typed
`channel_effective_policy_v1` authority. Never synthesize a local-user quote.

The authority binds channelId, workspaceId, participantId, operationId,
sourceItemId/revision, canonical workspaceCwd/executionCwd, directory device/inode
identities, channelUpdatedAt, workspacePolicyUpdatedAt and a SHA256 content
fingerprint. Timestamps are not monotonic revisions; the fingerprint represents
current policy contents, not a history of settings changed away and back.

The Host computes this from the owning Store, current channel/workspace binding,
canonical user item, active participant profile/allowedTools, and actual resolved
read decision. HTTP/model candidate schemas reject policyAuthority and bound
scope fields. Contracts validate shape, not issuer authenticity; dispatch must
recompute authority from canonical Host facts and compare it, including owner,
operation and source identity. No serialized boolean is permission.

For policy scope only, projectRoot="." means the verified channel execution
root, not filesystem root. Hidden/protected components remain excluded. For an
explicit user directory, that narrower root remains authoritative. Full Access
does not make the whole filesystem a closure root.

## Admission and continuation

The new-plan binder has a Host-only scope compiler, invoked only after command,
entrypoint, owner and user constraints are bound. It does not invent operations,
file paths, commands or participants. A missing separately named directory is not
itself a reason to clarify. Prompt instructions distinguish ordinary automatic
preparation from explicit ask-first/direct-only and project-location ambiguity.

If a model supplies a complete pendingDraft solely for projectInputRoot and the
Host can safely bind policy scope for every slot, admit that already-bound graph
through the same normal publication path rather than ask a redundant question.
If the user explicitly says to ask, freeze the original graph without inherited
scope and preserve the existing structured question/answer protocol. An old
pending draft cannot take this shortcut.

## Preparation and revalidation

Reuse the native reader, immutable operation snapshot, Run/Attempt fence, Host
journal, approval resume and restricted runtime. Policy inheritance is not bash
approval. Immediately before preparation, require the final Run read decision to
be allow and recompute the frozen channel authority. Recheck at metadata probes,
each native capture boundary, after awaited work and before atomic launch. Any
permission/source/root/owner change stops preparation with not_started semantics;
no partial closure, raw spawn, or broader regenerated scope is a fallback.

Read only the parser-derived closure and necessary package metadata. Retain all
existing budgets, parent hashes, symlink/hardlink/native identity checks,
origin/network denial, cleanup and unknown-effect behavior. Derived evidence
records policy authority separately from source item provenance.

## User-facing outcomes

| Condition | Result |
| --- | --- |
| Actual dependency is inside inherited allowed root | Prepare only that dependency; continue original command approval/execution |
| Project/entrypoint cannot be identified | Ask for project location; do not guess it |
| User requested ask-first | Preserve original structured scope question |
| User limited to direct inputs | No closure expansion; report exact missing dependency if needed |
| Dependency is outside scope or permission was revoked | Structured path/permission blocker; no helper read or command launch |
| Unsupported bare package, dynamic/nonliteral import or resolution form | Capability limitation; do not repeatedly ask for authorization |

The existing parser is not full npm/pnpm resolution. No installs, lockfile walks,
bare package support or extension/directory searching are included in this change.

## Acceptance

1. Native regressions before repair: new policy scope accepted without fake quote;
   model injection, cross-owner/source/workspace, malformed authority rejected.
2. New ordinary plan stages supported local dependencies without a scope question;
   explicit root, single-file restriction and ask-first keep narrower behavior.
3. Capture supports workspace-root package metadata without `./` path ambiguity;
   out-of-root, hidden paths, symlink/hardlink and resource limits still reject.
4. Same-timestamp policy edits, channel/participant read removal, source edit,
   root replacement, changes during capture/approval and final read=ask/deny
   stop before further reads or launch. Widening does not enlarge frozen scope.
5. Legacy no-scope plans and existing pending drafts remain byte-for-byte scoped;
   restart resumes the same frozen operation and never executes it twice.
6. Final source independent review, then reviewed QA-only package and new real
   client cases. Unit/fixture results are not packaged UI acceptance.

No new table or true-history mutation is required. Total E6 acceptance remains open.

## Implementation checkpoint (2026-10-27)

The Contracts/Core/Daemon chain is implemented. The rebuilt affected/adjacent
Daemon combination passed 132/132; trusted dependency diagnostics passed 9/9
and adjacent execution/output cases 22/22, all actual exit 0. Prior Contracts
120/120 and Core pending 33/33 remain attributed to the executing slice, whose
record lacks a separately persisted full raw TAP artifact; they are not claimed
as independent reruns. Native production-helper/Seatbelt conformance initially
passed 7/8: the helper safely rejected the symlink but the new test expected a
different error name. That exact test's corrected narrow recheck passed 1/1;
the initial failure is retained, not rewritten as an all-green full invocation.

Separate reviewers covered the slices they did not implement. Their reports
have no remaining confirmed finding in their selected scopes, not an approval
of the whole E6 plan. Evidence, source hashes and limitations are recorded in
`output/e6-20260928/channel-policy-command-inputs-implementation-20261027.md`
and the two adjacent independent-review reports.

The current running QA App is still the prior package. Its earlier normal
App/Host restart case does not verify this change, crash recovery, or in-flight
effects. A successor reviewed-input QA package must include this checkpoint and
the separately requested shared execution-detail ownership adjustment. Real
automatic-preparation, explicit ask-first/restriction, drift and duplicate-free
recovery cases remain open. Node module resolution and descendant-containment
limitations described above are unchanged; no release is authorized.
