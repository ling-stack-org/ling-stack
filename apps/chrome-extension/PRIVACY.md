# Ling for Chrome Privacy Policy

Last updated: August 18, 2026

Ling for Chrome is an optional browser extension that connects Chrome to the Ling application
running on the same computer. This policy explains the information the extension processes, why it
is needed, where it goes, and how users can remove access.

## Scope And User Control

The extension processes browser information only after the user pairs it with a local Ling
workspace, enables the built-in Chrome plugin, and approves a browser tool request in Ling. Users
can disconnect the extension or revoke Chrome access from Ling at any time.

## Information Processed

For an approved browser task, the extension may process:

- the title and HTTP(S) URL of a selected tab;
- bounded text, links, images, and other content visible on the selected page;
- labels and metadata for visible interactive elements;
- text the user directs Ling to type into a non-password field;
- a screenshot of the visible browser viewport; and
- personal communications visible on a selected page when the user explicitly directs Ling to
  work with that page.

The extension stores a local Ling workspace binding, loopback daemon address, and revocable pairing
credential in `chrome.storage.local` so it can reconnect to the user's local Ling daemon.

The extension does not request or read Chrome passwords, cookies, browsing-history records,
bookmarks, downloads, saved payment information, password-field values, or file-input values. It
does not monitor browsing in the background and has no persistent content script.

## How Information Is Used

Approved task data is sent over a loopback connection to the Ling daemon running on the same
computer. Ling uses it only to perform the browser action requested by the user, display the result,
and maintain bounded local run records.

When an approved browser result is used in an AI task, Ling may include bounded relevant content in
a request to the model provider configured and selected by the user. That provider processes the
request under its own terms and privacy policy. Ling for Chrome does not contain analytics,
advertising, or remote telemetry endpoints.

## Retention And Deletion

The Chrome-local workspace binding and pairing credential remain until the user disconnects,
revokes access, clears extension storage, or uninstalls the extension. Revocation invalidates the
credential. The Ling daemon stores only a SHA-256 hash of the raw pairing credential.

Approved browser task inputs and bounded results may remain in Ling's local run history until the
user deletes that history through Ling's local data controls. Uninstalling the extension removes
its Chrome-local state according to Chrome's extension-storage behavior, but it does not
automatically delete Ling data stored separately on the user's computer.

## Sharing And Sale

Ling for Chrome does not sell user data. It does not use or transfer user data for advertising,
credit decisions, lending decisions, or purposes unrelated to user-approved Ling browser tasks.
Data may reach a user-selected model provider only through the Ling task described above.

## Security

The extension uses a revocable pairing credential, accepts only the reviewed Ling protocol over a
loopback connection, rejects browser-internal and local URL schemes, packages all executable code
with the extension, and relies on Ling's approval policy before browser tools run.

## Contact

For privacy questions or support, open a
[GitHub issue](https://github.com/tianxiaochannel-oss88/ling-stack/issues). Do not include private
workspace data, credentials, or security vulnerabilities in a public issue. Report security issues
through [GitHub private vulnerability reporting](https://github.com/tianxiaochannel-oss88/ling-stack/security/advisories/new).
