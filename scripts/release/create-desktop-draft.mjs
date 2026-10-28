import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { fileRecord, readCandidate, verifyTargetInputs } from "./desktop-release.mjs";

/** Recheck downloaded bytes immediately before any GitHub mutation. */
export async function verifyAssembledRelease({ candidate, outputRoot }) {
  const { manifests, expectedFiles } = await verifyTargetInputs({ candidate, inputRoot: outputRoot });
  const manifest = JSON.parse(await readFile(join(outputRoot, "release-manifest.json"), "utf8"));
  if (!isDeepStrictEqual(manifest, { ...candidate, targets: manifests })) throw new Error("Assembled source identity changed");
  const checksums = await Promise.all([...expectedFiles].sort().map(name => fileRecord(join(outputRoot, name))));
  if (await readFile(join(outputRoot, "checksums.txt"), "utf8") !== checksums.map(file => `${file.sha256}  ${file.name}\n`).join("")) {
    throw new Error("Assembled checksum index changed");
  }
  for (const name of ["checksums.txt", "release-manifest.json", "release-notes.md"]) expectedFiles.add(name);
  const names = (await readdir(outputRoot)).sort();
  if (names.length !== expectedFiles.size || names.some(name => !expectedFiles.has(name))) throw new Error("Unexpected release directory contents");
  return Promise.all(names.map(name => fileRecord(join(outputRoot, name))));
}

function defaultGh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
}

/** Creates only a new, unpublished Draft. Failure never deletes or overwrites it. */
export async function createDesktopDraft({ candidate, outputRoot, repository, gh = defaultGh }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "")) throw new Error("Missing GitHub repository");
  const assets = await verifyAssembledRelease({ candidate, outputRoot });
  const api = async path => JSON.parse(await gh(["api", path]));
  // Prefix lookup returns [] for an unused tag, while authentication/network
  // errors still fail. Treating any gh failure as a 404 would be unsafe.
  const tagRefs = () => api(`repos/${repository}/git/matching-refs/tags/${candidate.tag}`);
  if ((await tagRefs()).some(ref => ref.ref === `refs/tags/${candidate.tag}`)) throw new Error("Tag already exists; nothing was replaced");
  const releases = JSON.parse(await gh(["api", `repos/${repository}/releases?per_page=100`, "--paginate", "--slurp"])).flat();
  if (releases.some(release => release.tag_name === candidate.tag)) throw new Error("A Release already uses this tag; nothing was replaced");
  let created = false;
  try {
    await gh(["release", "create", candidate.tag, "--repo", repository, "--target", candidate.sourceSha,
      "--draft", "--title", `Ling Stack ${candidate.tag}`, "--notes-file", join(outputRoot, "release-notes.md")]);
    created = true;
    await gh(["release", "upload", candidate.tag, "--repo", repository, ...assets.map(file => join(outputRoot, file.name))]);
    const release = JSON.parse(await gh(["release", "view", candidate.tag, "--repo", repository,
      "--json", "isDraft,isPrerelease,targetCommitish,assets,url"]));
    if (!release.isDraft || release.isPrerelease !== false || release.targetCommitish !== candidate.sourceSha
      || release.assets.length !== assets.length) throw new Error("Draft identity or uploaded asset count mismatch");
    for (const file of assets) {
      const remote = release.assets.find(asset => asset.name === file.name);
      const assetId = /^https:\/\/api\.github\.com\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/assets\/(\d+)$/u.exec(remote?.apiUrl ?? "")?.[1];
      if (!assetId) throw new Error(`Missing uploaded asset: ${file.name}`);
      const uploaded = await api(`repos/${repository}/releases/assets/${assetId}`);
      if (uploaded.state !== "uploaded" || uploaded.size !== file.sizeBytes || uploaded.digest !== `sha256:${file.sha256}`) {
        throw new Error(`Draft upload verification failed: ${file.name}`);
      }
    }
    // A concurrent tag must still resolve to the selected source. Drafts need
    // not create a Git tag until publication, so absence here is valid.
    if ((await tagRefs()).some(ref => ref.ref === `refs/tags/${candidate.tag}`)) {
      const commit = await api(`repos/${repository}/commits/${candidate.tag}`);
      if (commit.sha !== candidate.sourceSha) throw new Error("Concurrent tag no longer matches the Draft source");
    }
    // Recheck local files as well; a successful upload cannot excuse mutation.
    if (!isDeepStrictEqual(assets, await verifyAssembledRelease({ candidate, outputRoot }))) throw new Error("Release files changed during upload");
    return { url: release.url, status: "verified_draft", published: false, sourceSha: candidate.sourceSha, assetCount: assets.length };
  } catch (cause) {
    if (created) throw new Error(`Draft ${candidate.tag} remains unpublished and may be incomplete; inspect it before any retry. No existing assets were replaced.`, { cause });
    throw cause;
  }
}

async function main() {
  const candidate = await readCandidate({ sha: process.env.DESKTOP_SOURCE_SHA,
    tag: process.env.DESKTOP_RELEASE_TAG, requireMain: true });
  const result = await createDesktopDraft({ candidate, outputRoot: resolve(process.env.DESKTOP_OUTPUT_ROOT), repository: process.env.GITHUB_REPOSITORY });
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
