# Ling for Chrome Privacy Disclosure Draft
This is a product and engineering draft, not an approved legal policy. Replace the placeholders,
confirm the final data flow, and obtain human legal review before publishing it as the Chrome Web
Store privacy-policy URL.

Last updated: 2026-08-17

## Scope

Ling for Chrome is an optional browser extension that connects Chrome to the Ling application
running on the same computer. It processes browser information only when the user has paired the
extension, enabled the built-in Chrome plugin, and approved a browser tool request in Ling.

## Information Processed

For an approved browser task, the extension may process:

- the title and HTTP(S) URL of a selected tab;
- bounded text visible on the page;
- labels and metadata for visible interactive elements;
- text the user directs Ling to type into a non-password field;
- a screenshot of the visible browser viewport.

The extension is not designed to read Chrome passwords, cookies, browsing-history records,
bookmarks, downloads, saved payment information, password fields, or file-input values.

## How Information Is Used

The extension sends approved task data to the Ling daemon over a loopback connection on the same
computer. Ling uses it to complete the browser action requested by the user, display the result,
and retain bounded run records according to the user's local Ling history settings.

When a browser result is used in an AI task, Ling may include bounded relevant content in a request
to the model provider configured and selected by the user. That provider processes the request
under its own terms and privacy policy. Ling for Chrome itself has no analytics, advertising, or
remote telemetry endpoint.

## Pairing And Local Storage

The extension stores the selected Ling workspace binding and a revocable pairing credential in
`chrome.storage.local`. The Ling daemon stores only a SHA-256 hash of that credential. Pairing is
scoped to the local Chrome profile and Ling workspace.

## Retention And User Control

The user can disconnect the extension or revoke Chrome access from Ling at any time. Revocation
invalidates the pairing credential. Browser task inputs and bounded results may remain in the local
Ling run history until the user deletes that history according to Ling's retention controls.

Uninstalling the extension removes its Chrome-local state according to Chrome's extension-storage
behavior. It does not automatically delete Ling run history stored separately by the local Ling
application.

## Sharing And Sale

Ling for Chrome does not sell browser data and does not use it for advertising, credit decisions,
or purposes unrelated to user-approved Ling browser tasks. Data may reach a model provider only
through the user's configured Ling task as described above.

## Security

The extension uses a revocable pairing credential, rejects unsupported browser-internal and local
URL schemes, packages all executable code with the extension, and relies on Ling's approval policy
before browser tools run.

## Contact

Support: `REQUIRED_SUPPORT_EMAIL`

Privacy policy owner: `REQUIRED_PUBLISHER_LEGAL_NAME`
