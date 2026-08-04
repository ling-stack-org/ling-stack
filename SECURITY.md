# Security Policy

Ling Stack coordinates models, local files, tools, credentials, approvals, external
services, and desktop capabilities. Please report security issues privately so they can
be investigated before public disclosure.

## Supported Versions

Ling Stack is currently a source-first alpha with no stable supported release line.

| Version | Security updates |
| --- | --- |
| Current `main` | Best effort |
| Older commits and branches | Not supported |
| Locally built or unsigned packages | Not supported as production releases |

Security fixes target the current development line. A published version support policy
will replace this table before the first stable release.

## Reporting A Vulnerability

Use GitHub's private vulnerability reporting flow:

<https://github.com/tianxiaochannel-oss88/ling-stack/security/advisories/new>

If the private reporting button is unavailable, contact a repository maintainer through
a private GitHub channel. Do not open a public issue, discussion, or pull request that
contains exploit details, credentials, private workspace data, or an unpatched proof of
concept.

Include only the information needed to reproduce and assess the issue:

- affected commit, package, platform, and configuration;
- impact and required attacker access;
- minimal reproduction steps;
- relevant logs with credentials, tokens, local paths, and personal data removed;
- whether the issue is already public or actively exploited;
- suggested mitigation, if known.

Do not access data that is not yours, disrupt other users, publish secrets, or perform
destructive testing. Use a local disposable workspace and test credentials whenever
possible.

## Response Process

Maintainers will handle reports on a best-effort basis during the alpha period. The
expected process is:

1. Confirm receipt and establish a private discussion.
2. Reproduce and classify the affected authority boundary.
3. Prepare a fix and focused regression coverage.
4. Coordinate disclosure after a fix or mitigation is available.
5. Credit the reporter when requested and appropriate.

Response and release timing depend on severity, reproducibility, platform access, and
whether signing or upstream dependencies are involved. Please do not assume that silence
authorizes public disclosure.

## High-Risk Areas

Reports are especially important when they involve:

- approval or permission bypass;
- command, prompt, workflow, or tool injection leading to unintended authority;
- path traversal or access outside the approved workspace;
- API key, token, Keychain, log, artifact, or SQLite disclosure;
- unauthenticated daemon, remote-access, WebSocket, or IPC access;
- external mutations executed without current approval or stale-target validation;
- plugin, MCP, provider, update, package, or supply-chain integrity;
- Computer Use capture/input crossing lock-screen or platform permission boundaries;
- unsafe media downloads, artifact handling, or local workflow execution.

## Security Boundaries

- The daemon is loopback-only by default and should not be exposed directly to a network.
- Skills are instructions, not authority grants.
- Provider capability labels do not grant tools or filesystem access.
- External mutations, paid generation, destructive tools, and credential changes require
  explicit policy and approval boundaries.
- Unsigned local Desktop builds are development artifacts, not production releases.

See [Approval Policy](docs/design/approval-policy.md),
[Secrets And Keychain](docs/design/secrets-keychain.md), and
[State Machines And Recovery](docs/design/state-machine-recovery.md) for current design
boundaries.
