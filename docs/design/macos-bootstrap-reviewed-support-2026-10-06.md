# Reviewed macOS bootstrap support

## Scope

Protected Host staging admits only the exact reviewed Apple bootstrap source
digests. Unknown bytes remain fail-closed; a matching digest alone cannot replace
the original path, root ownership/mode, bounded FD read, identity, close, and
backend digest checks. This is source review, not kernel certification or Office
safe settlement.

## macOS 26 source provenance

The actual arm64 CI job for run `37447192095`, head
`f45c2d8d3a3791f975213e445f6caf0621dee01a`, collected the fixed OS-owned
`/System/Library/Sandbox/Profiles/dyld-support.sb`. Artifact `11403612813`
reported macOS `26.6.2`, build `25G83`, kernel `25.6.0`, uid `0`, mode `100644`,
and 2655 bytes. Independent decoding verified the exact size and SHA256:

`06215a5d32689aefe395c29710e182eb54ba22162f50df8b4842290f8a19bf1c`

The complete source was reviewed independently before adding this digest.
Filesystem grants are the five literal System Cryptex graft subpaths, their
ancestors and literal `/`, for reading/existence/executable mapping. They fit
the existing conservative `/System` reservation; device exceptions remain
covered by the existing `/dev` reservation. No filesystem-write, network,
Mach lookup, task-port, ptrace or Host-FD inheritance grant was added.

The existing dyld syscall, filesystem open/openat/fstatat/dup, getfsstat/mapping,
fcntl signature/library-validation/path and Sandbox-check privileges remain
visible. This does not claim that bootstrap has no non-filesystem privileges,
or that syscall permission itself revokes already inherited descriptors.

## Verification boundary

The production reader keeps the previous reviewed digest and adds only this
fixed reviewed variant. No diagnostic output is consumed as runtime authority;
there is no automatic enrollment of future OS versions or arbitrary hashes.
Selection tests simulate hash results only and cannot count as actual macOS 26
OS/native evidence. The unchanged real staging and native CI tests must still
pass on the actual CI Host. Full Access and uncontrolled same-UID processes
remain outside the controlled-process isolation promise.
