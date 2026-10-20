import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Select the sole open, same-repository catalog PR from a successful gh query.
 * Only an empty array means no PR; malformed or ambiguous responses fail closed.
 * @param {string} serialized GitHub CLI JSON output.
 * @param {string} branch Exact automation head branch.
 * @param {string} appSlug Expected GitHub App slug.
 * @returns {number | undefined} Existing PR number, or undefined for no match.
 */
export function selectOpenCatalogPullRequest(serialized, branch, appSlug) {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(appSlug ?? "")) {
    throw new Error("Catalog App slug is missing or invalid.");
  }
  let records;
  try {
    records = JSON.parse(serialized);
  } catch {
    throw new Error("Catalog PR query did not return valid JSON.");
  }
  if (!Array.isArray(records)) throw new Error("Catalog PR query must be an array.");
  if (records.length > 1) throw new Error("Multiple open catalog pull requests matched; refusing to choose one.");
  if (records.length === 0) return undefined;

  const record = records[0];
  if (
    !record || record.state !== "OPEN" || record.headRefName !== branch
    || record.baseRefName !== "main" || record.isCrossRepository !== false
    || record.author?.login !== `app/${appSlug}` || record.author?.is_bot !== true
    || !Number.isSafeInteger(record.number) || record.number <= 0
  ) {
    throw new Error("Unexpected catalog pull request; expected an App-authored open same-repository PR with the exact head and main base.");
  }
  return record.number;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const number = selectOpenCatalogPullRequest(readFileSync(0, "utf8"), process.argv[2], process.argv[3]);
    if (number !== undefined) console.log(number);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Catalog PR selection failed.");
    process.exitCode = 1;
  }
}
