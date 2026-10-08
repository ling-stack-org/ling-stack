// Identity, certificate, Keychain and notarization inputs consumed by the fixed
// macOS Builder lane. Ordinary build environment (including PATH) is not fenced.
const signingEnvironmentKeys = Object.freeze([
  "CSC_LINK", "CSC_KEY_PASSWORD", "CSC_INSTALLER_LINK", "CSC_INSTALLER_KEY_PASSWORD",
  "CSC_KEYCHAIN", "CSC_NAME", "CSC_FOR_PULL_REQUEST", "CSC_IDENTITY_AUTO_DISCOVERY",
  "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID", "APPLE_API_KEY",
  "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_KEYCHAIN", "APPLE_KEYCHAIN_PROFILE",
]);
const signingConfigFields = Object.freeze(["cscLink", "cscKeyPassword"]);
const macSigningConfigFields = Object.freeze([
  ...signingConfigFields, "cscInstallerLink", "cscInstallerKeyPassword",
]);

/**
 * Reject explicit signing inputs, including empty values, without reading or
 * clearing their values. Builder can import certificates before resolving the
 * fixed ad-hoc identity, so identity "-" alone is not this admission boundary.
 *
 * This validates one boundary snapshot, not unrelated process.env writers or a
 * complete vendor/toolchain sandbox. Errors expose only fixed field names.
 * @param {Record<string, string | undefined>} environment Raw or derived env.
 * @returns {void}
 */
export function assertPackagedOfficeSigningEnvironment(environment) {
  for (const key of signingEnvironmentKeys) {
    if (Object.hasOwn(environment, key)) rejectSigningInput(key);
  }
}

/**
 * Keep the fresh fixed config in the unsigned_dev default ad-hoc lane. Config
 * credential fields are forbidden by presence, not truthiness. Undefined or
 * false notarization remains allowed; explicit opt-in is another contract.
 * @param {Record<string, unknown> & {mac: Record<string, unknown>}} config Fresh fixed config.
 * @returns {void}
 */
export function assertPackagedOfficeSigningConfig(config) {
  for (const field of signingConfigFields) {
    if (Object.hasOwn(config, field)) rejectSigningInput(`config.${field}`);
  }
  for (const field of macSigningConfigFields) {
    if (Object.hasOwn(config.mac, field)) rejectSigningInput(`mac.${field}`);
  }
  if (config.mac.notarize !== undefined && config.mac.notarize !== false) {
    rejectSigningInput("mac.notarize");
  }
}

/** @param {string} field Fixed input name only; never pass a credential value. */
function rejectSigningInput(field) {
  throw new Error(`packaged_office_native_signing_inputs_unsupported:${field}`);
}
