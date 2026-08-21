# Ling for Chrome Privacy Policy

Last updated: August 21, 2026

Ling for Chrome is an optional browser extension that connects Chrome to the Ling application
running on the same computer. This policy explains the information the extension processes, why it
is needed, where it goes, and how users can remove access.

## Scope And User Control

The extension processes browser information only after the user installs it, enables the built-in
Chrome plugin in Ling, and approves a browser tool request in Ling. The extension automatically
connects to the Ling application running on the same computer through Chrome Native Messaging.
Users can pause the extension, disable the plugin, or revoke Chrome access at any time.

## Information Processed

For an approved browser task, the extension may process:

- the title and HTTP(S) URL of a selected tab;
- bounded text, links, images, and other content visible on the selected page;
- labels and metadata for visible interactive elements;
- text the user directs Ling to type into a non-password field;
- a screenshot of the visible browser viewport; and
- personal communications visible on a selected page when the user explicitly directs Ling to
  work with that page.

The extension stores only its paused state in `chrome.storage.local`. Version `0.1.1` may briefly
read a workspace binding, loopback daemon address, and revocable pairing credential left by version
`0.1.0` to complete a one-time local migration. Those legacy values are deleted after the first
successful Native Messaging connection and are never created for new connections.

The extension does not request or read Chrome passwords, cookies, browsing-history records,
bookmarks, downloads, saved payment information, password-field values, or file-input values. It
does not monitor browsing in the background and has no persistent content script.

## How Information Is Used

Approved task data is sent through the installed Ling Browser Host to a private loopback connection
owned by the Ling daemon running on the same computer. The Host only forwards bounded protocol
messages; it does not select a workspace, contact a cloud service, or make browser-task decisions.
Ling uses the data only to perform the browser action requested by the user, display the result, and
maintain bounded local run records.

When an approved browser result is used in an AI task, Ling may include bounded relevant content in
a request to the model provider configured and selected by the user. That provider processes the
request under its own terms and privacy policy. Ling for Chrome does not contain analytics,
advertising, or remote telemetry endpoints.

## Retention And Deletion

The paused state remains until the user resumes, clears extension storage, or uninstalls the
extension. Legacy version `0.1.0` connection values remain only until migration, revocation, storage
clearing, or uninstall. Ling stores only a SHA-256 hash of a legacy raw pairing credential and
revokes it when Native Messaging migration succeeds.

Approved browser task inputs and bounded results may remain in Ling's local run history until the
user deletes that history through Ling's local data controls. Uninstalling the extension removes
its Chrome-local state according to Chrome's extension-storage behavior, but it does not
automatically delete Ling data stored separately on the user's computer.

## Sharing And Sale

Ling for Chrome does not sell user data. It does not use or transfer user data for advertising,
credit decisions, lending decisions, or purposes unrelated to user-approved Ling browser tasks.
Data may reach a user-selected model provider only through the Ling task described above.

## Security

The extension uses Chrome Native Messaging with the allowlisted `com.lingstack.browser` Host, which
authenticates to a private loopback broker using a short-lived startup token stored in a user-only
runtime descriptor. It accepts only reviewed Ling protocols, rejects browser-internal and local URL
schemes, packages all extension code in the submitted ZIP, and relies on Ling's approval policy
before browser tools run.

## Contact

For privacy, support, or security questions, use the verified publisher contact displayed on the
Ling for Chrome listing in the Chrome Web Store. Do not include private workspace data,
credentials, or other secrets. Prefix security-related messages with `Security` so they can be
handled appropriately.
