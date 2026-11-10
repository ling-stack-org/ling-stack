# Support

Ling Stack is an open-source alpha maintained on a best-effort basis. There is currently
no commercial support agreement, guaranteed response time, or stable release channel.

## Before Opening An Issue

1. Read the [Quick Start](README.md#quick-start-from-source).
2. Check [Implementation Status](docs/design/implementation-status.md) for known open or
   intentionally hidden work.
3. Search existing issues and pull requests.
4. If running from source or CLI, run `corepack pnpm ling doctor` and remove secrets and
   private paths from any output you share. Installed Desktop users do not need Node or
   pnpm just to report a problem.

Choose a form on the [New Issue page](https://github.com/ling-stack-org/ling-stack/issues/new/choose):

- Bug or UI problem: incorrect behavior, errors, and layout problems.
- Installation, startup, or update problem: installer and app lifecycle failures.
- Model, CLI, or MCP integration problem: provider and external tool connections.
- Feature request: a user problem and the desired improvement.
- Documentation or translation problem: instructions, links, and localized text.
- Usage question: help with an existing capability or workflow.

English and Chinese reports are welcome. Include the affected version or commit, relevant
environment, and smallest safe reproduction. Node version is only needed for source or
CLI use. Screenshots and logs are optional and must be redacted before upload; do not
include credentials, private endpoints, workspace data, or sensitive model content.

Ordinary users must choose a form; GitHub may still show a maintainer-only blank issue
option. The Settings template editor may not list YAML Issue Forms; the New Issue page
is the acceptance surface. Forms live in `.github/ISSUE_TEMPLATE/` and changes take effect
when merged into the default branch. They use existing issue labels and no automation
that reads or executes contributor content.

## Security

Do not report vulnerabilities, credentials, private workspace data, or unpatched exploit
details in a public issue. Use GitHub's private vulnerability reporting entry, not an
ordinary Issue form; follow [SECURITY.md](SECURITY.md).

## Scope

The current acceptance scope is the local Web and Electron desktop product. Mobile,
signed production distribution, and platform-specific Computer Use release gates remain
outside normal community support until their status changes in the maintained design and
release documents.
