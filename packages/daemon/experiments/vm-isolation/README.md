# Standalone VM isolation research (C05)

This macOS arm64 experiment is disabled by default. It is not imported by the
Daemon, Runner or Tool Broker. It boots a fixed RAM-only Alpine guest with one
CPU, 512 MiB, no network/storage/socket device, one read-only input share and one
writable output share. No user credentials or user project are mounted.

Prerequisites: Xcode command-line tools, Virtualization.framework, and these
exact recorded Alpine 3.23 aarch64 netboot inputs from
`https://dl-cdn.alpinelinux.org/alpine/v3.23/releases/aarch64/netboot/`:

| File | SHA-256 |
| --- | --- |
| vmlinuz-virt | d1876369b061ef3bc33314f490240efcd32b031393cb34c6f81134fa862fe472 |
| initramfs-virt | a3519770a2210762adab97556b8e710db76e2d4d31ddf554a951801ca475f873 |

These hashes record the TLS-downloaded inputs used in this experiment; they
are not a claim of upstream signature verification. Images are not committed.
From `packages/daemon`:

```sh
node experiments/vm-isolation/run-probe.mjs --run-isolated-probe /absolute/path/vmlinuz-virt /absolute/path/initramfs-virt
```

The script validates the pins, extracts the Linux EFI zboot payload, creates a
minimal initramfs, compiles and ad hoc signs only its temporary Swift probe with
the virtualization entitlement, then runs two guests sequentially. The first
checks allowed input, denied input writes, an unshared canary, absence of a
network device, output export and normal poweroff. The second verifies an actual
stopped callback after cancellation. Export accepts fixed names and verifies
regular files, no symlink, link count and size. Evidence and failures remain in
the printed temporary directory; successful guest output is acknowledged before
poweroff so process exit cannot substitute for reading the result.

This is a fixed guest/console protocol, not production Host RPC or admission.
There is no network allowlist, crash/restart persistence, production tool
compatibility, signed distribution acceptance, guest RSS measurement or native
sandbox comparison. Two tiny guest launches are not a product startup benchmark.
Production integration requires a separate reviewed design preserving Run,
Attempt, Broker, cancellation, recovery and artifact authority.
