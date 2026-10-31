# Optional Memory Derivatives

Status: implemented source contract; native adapter remains opt-in
Owner: memory runtime maintainers
Last verified: 2026-10-30
Document type: behavior contract

SQLite memory objects, review state, owner lineage and health remain authoritative.
Neither a vector hit nor a generated Wiki page grants access, establishes truth, changes
permissions or activates knowledge. Local FTS/lexical recall works without either derivative.

## Semantic retrieval

`GET/PUT /memory/semantic-policy?cwd=…` reads/updates a revision-checked policy. It defaults
to `off`. Enabling `lancedb` requires an enabled existing OpenAI-compatible provider preset,
embedding model, dimensions (1–8192), and an explicitly calibrated cosine `maxDistance`
(0–2). The service calls `/embeddings`, with bounded input/output and no tools, redirects
or hidden retries. The whole query, including embedding and native search, has a configurable
1–1,000 ms deadline. Remote service use requires `allowRemote`; private sensitivity,
teammate-owned memory and private-chat queries additionally require `allowPrivateRemote`.
Changing the data policy, endpoint, model or dimensions cannot reuse the old vector space.

The optional adapter targets `@lancedb/lancedb@0.40.0`. It is loaded lazily, outside daemon
startup dependencies. For a source/developer installation, install the pinned module in a
separate directory, then set `LING_MEMORY_LANCEDB_MODULE` to the absolute installed package
path before starting the daemon. For example:

```sh
npm install --prefix "$HOME/.ling-memory-lancedb" --no-audit --no-fund @lancedb/lancedb@0.40.0
export LING_MEMORY_LANCEDB_MODULE="$HOME/.ling-memory-lancedb/node_modules/@lancedb/lancedb"
```

This is an explicit operator opt-in, not a default dependency or model download. The host
loads executable native code from that operator-selected path. Packaged distribution needs
separate native binary/architecture acceptance before this adapter can enter default bundles.
Missing modules return `unavailable` and leave local recall operational.

The exact owner and expiry are filtered inside LanceDB before top-k. Each hit stores only
id, scope, content hash and qualification revision; SQLite checks all of these again before
use. All five daemon recall paths use the same async boundary and resolve ownership again
after waiting. Exact id/tag matches retain priority. Reciprocal rank fusion (`k=60`) combines
rank positions without adding incomparable lexical and vector scores.

Migration 187 adds policy/generation records, qualification revisions and a coalesced
transactional outbox. Usage timestamps do not trigger embeddings. A keyset full scan persists
completed pages and then catches up on the outbox. Generation and policy CAS fence old
builders. Transient failure backs off 30 seconds to 5 minutes; restart resumes the stored
scan cursor rather than re-embedding completed pages. Source mutations during embedding are
rechecked before writing; stale hits are rejected even before native removal completes.
Before the first scan checkpoint, retry can create a missing native table. Creation is
idempotent when an earlier process already created it, preserving any indexed rows.
Policy changes conservatively rebuild. Existing retired native handles close after active
queries drain. Shutdown aborts embedding requests and drains native work before closing.

States are `not_configured`, `rebuilding`, `ready`, `degraded`, `unavailable`. Status reports
local index/configuration observations; it does not probe the embedding server. A successful
query can recover degraded query status. Background synchronization alone never claims an
unreachable embedding endpoint has recovered.

Settings → Skills → AI evolution → Experience review contains the optional retrieval form.
Users select the model/dimensions/threshold explicitly and can disable it there. Scope and
review eligibility are always enforced by the daemon, independently of UI settings.

## Wiki projection

`GET /memory/wiki`, `POST /memory/wiki/compile`, `GET /memory/wiki/export` and
`PUT /memory/wiki/human` take `cwd`, an exact `scopeType`, and `ownerId`. The default is the
workspace owner. Each partition has independent pages, topics, sources, links, reports,
generation and human notes. A private owner never contributes to another partition's
links, counts, search or reports. Archived/unknown owners are rejected.

Inputs are active/enabled non-secret memory and local-user-confirmed active channel
decisions. Legacy synthetic manual provenance is reported as missing evidence and does not
produce a page. Expired/replaced memory appears only in the corresponding owner report.
Explicit `conflict`, `contradiction` and `矛盾` tags produce marked-conflict reports; there is
no automatic semantic contradiction detection. No repository, whole-chat or web crawler runs.

Each conclusion includes source id/type/version, scope, evidence pointer, confidence label,
content timestamp and same-scope related ids. Approved memories are labelled
`reviewed_unscored`, decisions `user_confirmed`; no numeric confidence is invented. Original
memory provenance remains inspectable through its owning memory object. Arbitrary historical
sourceRef labels/ids are not expanded into cross-owner backlink indexes. Related pages share
a tag; that relationship does not assert that their conclusions agree.

Migration 188 stores requested/published generations and human blocks. Compilation builds
an immutable generation in a mode-0700 staging directory under the workspace state directory,
writes a manifest and mode-0600 Markdown pages, then atomically renames the directory. SQLite
publishes its pointer only after a second source fingerprint check and current-generation
CAS. Old concurrent compilers cannot overwrite newer publications. Interrupted/orphaned
staging or retired generations are inert and can be rebuilt; they are not authoritative.

Reading validates the manifest and its exact owner/content digest, then checks sources again
after disk I/O. Source changes, revocation or expiry produce `stale` with empty pages, indexes
and reports; export requires `ready`. Tampered/missing files report `unavailable`. There is no
Wiki prompt injection path or implicit automatic prompt summary. The browser searches only
the freshly validated selected partition. A fresh HTTP read/export always revalidates; an
already rendered browser view is a snapshot until refreshed/rebuilt.

Human notes are separate revision-checked SQLite records, not editable generated blocks.
Rebuild/deleting derivative files preserves them. Notes and manual changes to generated files
do not write active memory. Importing knowledge continues through normal memory review.
The browser keeps unsaved notes across parent result refreshes and rebuilds. Notes remain
disabled until the initial partition read completes; a revision conflict retains the draft
for the user to resolve rather than replacing it with the server's text.
The existing Experience review disclosure provides read-only browsing, topic/search/source
indexes, reports, human notes and Markdown export. It does not restore the removed teammate
Settings Memory tab or create a new global review center.

## Verification and operating limits

Focused contracts are exercised by core `memory-derivatives.test.mjs` and daemon
`memory-embedding`, `memory-lancedb-native`, `memory-semantic-service`, `memory-wiki`, and
`memory-derivative-api` tests. Native cases require `LING_TEST_LANCEDB_MODULE`; a skip is not
native acceptance. `packages/daemon/test/memory-semantic-quality.mjs` is a separate explicit
local real-provider harness with a frozen authored calibration/evaluation fixture. It records
Recall@6, MRR, unrelated hits, exact ids, latency, index size and cost; its small sample cannot
establish general retrieval quality or a universal threshold. Runtime/browser/package/model
quality are separate evidence categories.

Actual Electron developer-CLI acceptance has exercised Chinese FTS retrieval beyond 500
newer same-scope records, missing-native lexical fallback, offline native retrieval and
provider fault/deadline/off/shutdown/restart behavior on their named frozen artifacts.
Evidence for different CLI hashes is reported separately. This does not certify a later
bundle, an installed `.app`, DMG/ZIP, Windows, or formal Office/native distribution.

Real daemon/SQLite browser acceptance with authored sources additionally exercised
workspace compilation, search/topic/source/report browsing, saved notes surviving
rebuild and scope reload, and a downloaded Markdown file read back with its source
and notes. Channel and teammate partitions excluded the workspace and each other's
pages and notes. Disabling the authored workspace source produced an empty `stale`
view with export disabled; rebuilding recovered `ready` without restoring the disabled
page or losing notes. This verifies the development-runtime integration, not packaged
platform behavior or real-user knowledge quality.

A consistent historical database backup copy has passed upgrade and restoration checks.
Populated-memory rehearsal used explicitly authored memory and skill rows in a disposable
copy of that historical schema; it is not evidence from a populated real-user memory corpus.
An earlier historical-schema diagnostic copy was rejected by migration 147 for an automation
foreign-key orphan. That finding does not diagnose the current task's default developer
database: the latter already contains this branch's old, unpublished feature migrations
177–181 for channel sessions, before main reserved 177/178 and the feature migrations moved to 184–188. That
development-only numbering collision is distinct from an upgrade of released main schema178;
a genuine mainline178-to188 fixture preserves its settings, sources and existing history.
Neither diagnostic changes the released migration ledger or requires repairing live user
data as part of this feature. The live source database was not modified during rehearsal.
