# Windows upstream self-test package exclusion review

[Hosted run 40028538469](https://github.com/ling-stack-org/ling-stack/actions/runs/40028538469)
produced the native Windows x64 inputs from source
`4fd4cc349fa000d7e19db32e458cb0e38778c698`. The independent review admits only
private-staging exclusion of `@anthropic-ai/claude-agent-sdk@0.2.117` and
`@anthropic-ai/claude-agent-sdk-win32-x64@0.2.117` under the exact new catalog.
Its SHA-256 is `8d19700627d67c09b46e9eae5159abd720116aa5e87d43691cf0f85514a02896`.

The Windows source manifest is
`sha256:25e50f1790d789b85d7c99f808a41726f922029b5f8a92874383c9912fc0a384`.
All 3,714 fixed sources and the 29 Agent SDK marker references match the reviewed
source census and classifications. All 57 skill bodies remain unchanged. The
native receipt is `sha256:28c2c0e3be05b31e7ba56c7c199496af0a6bc3cc30828d675b3db860b70fa5cb`.
The actual Windows Bun 1.4.4 compiler is independently bound to
`sha256:cb1d8e6564e655e49d30cead359750a1cbbd12f42651caa4b62244d7bd93c244`.

The five Windows import scopes were independently recomputed from their input
records and cross-checked against the Windows resource inventory. Their counts
are 274, 416, 81, 982 and 4; none imports either excluded package. The graph
checksums happen to equal the Mac graphs, but no Mac compiler or target approval
was reused. Both package metadata hashes are bound separately, including the
Windows native SDK metadata. Recompilation after exclusion must reproduce all
five graph checksums before staging is published.

The two excluded roots contain 782 files and 255,075,252 bytes. The separate
`@anthropic-ai/sdk@0.78.0` remains available with all 743 files, including the
52 client-graph inputs. `bun-types@1.4.2` retains all 368 files. SDK-only selection
does not enable build-only type-package pruning. Other native targets remain
unreviewed and retain their complete upstream dependencies.

The downloaded diagnostic collection verified 27 of 28 listed files; the sole
missing file was the 465-byte hidden workspace-policy marker. All required
source, native, compiler, graph, SDK metadata and inventory evidence was present.
The evidence uploader now includes hidden diagnostic files within its existing
generated-output directory. Windows checkout line-ending differences in three
text inputs without fixed LF attributes exactly reproduce the recorded adaptation revisions;
they were not treated as unexplained source changes.

This review does not clear the other eight dependency-audit observations or
grant complete dynamic-resource, compiled-artifact, installed-client,
redistribution or production-release acceptance. The original private-staging,
target, source, compiler, graph, metadata and deletion-time checks remain in
force. Final candidate construction and distribution-material review are
separate required gates.
