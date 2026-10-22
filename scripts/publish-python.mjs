#!/usr/bin/env node
// Publishes the Python packages under `python/*` to PyPI. The `changeset publish` step of the release
// workflow only knows npm, so this runs right after it and plays the same role for PyPI: whatever
// version Changesets left in a package's private `package.json` is published if PyPI does not have it
// yet. Like `changeset publish`, it is idempotent and keyed on the registry, not on what changed in
// the last commit, so a failed or re-run release simply picks up where it stopped.
//
// `0.0.0` means "not released yet" (a scaffold), and is skipped, so a package can live in the repo
// before its first changeset without anything reaching PyPI.
//
// It then tags `<name>@<version>` and opens a GitHub release with that version's CHANGELOG section,
// matching what changesets does for the npm packages. The uploaded files, the tag and the release
// are each checked on their own, so a run that stopped part way is completed by the next one.
//
//   node scripts/publish-python.mjs             # publish (CI: needs `id-token: write` + GH_TOKEN)
//   node scripts/publish-python.mjs --dry-run   # print what would be published, change nothing
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
/** Whether a read-only probe command exits 0 (its output is discarded). */
const succeeds = (cmd, args) => {
  try {
    execFileSync(cmd, args, { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/**
 * The filenames PyPI serves for `name==version`, `[]` if the version does not exist. Anything but
 * 200/404 is an error, not a "no".
 */
const filesOnPyPI = async (name, version) => {
  const res = await fetch(`https://pypi.org/pypi/${name}/${version}/json`);
  if (res.status === 404) return [];
  if (res.status !== 200) {
    throw new Error(`PyPI lookup for ${name}==${version} failed: HTTP ${res.status}`);
  }
  return (await res.json()).urls.map((file) => file.filename);
};

/** A pure-Python release is a wheel and a source distribution; with both on PyPI it is complete. */
const isComplete = (files) =>
  files.some((f) => f.endsWith(".whl")) && files.some((f) => f.endsWith(".tar.gz"));

/** The `## <version>` section of a changesets-written CHANGELOG.md, without its heading. */
const releaseNotes = (pkgDir, version) => {
  const path = join(root, pkgDir, "CHANGELOG.md");
  if (!existsSync(path)) return "";
  const sections = readFileSync(path, "utf8").split(/^## /m);
  const section = sections.find((s) => s.startsWith(`${version}\n`));
  return section ? section.slice(version.length).trim() : "";
};

const pythonRoot = join(root, "python");
const dirs = existsSync(pythonRoot)
  ? readdirSync(pythonRoot).filter((d) => existsSync(join(pythonRoot, d, "pyproject.toml")))
  : [];

for (const dir of dirs) {
  const pkgDir = `python/${dir}`;
  const { name, version } = JSON.parse(readFileSync(join(root, pkgDir, "package.json"), "utf8"));
  if (version === "0.0.0") {
    console.log(`${name}: 0.0.0 (unreleased), skipping`);
    continue;
  }
  // Files, tag and release are reconciled separately, so a run that died part way (one of the two
  // files uploaded, a failed tag push or `gh release`) is finished by the next run.
  const tag = `${name}@${version}`;
  const present = await filesOnPyPI(name, version);
  if (dryRun) {
    console.log(
      isComplete(present)
        ? `${tag}: already on PyPI; would create the tag and the GitHub release if missing`
        : present.length
          ? `${tag}: on PyPI without all its files (${present.join(", ")}); would upload the rest and tag`
          : `${tag}: would build, publish and tag`,
    );
    continue;
  }

  if (isComplete(present)) {
    console.log(`${tag}: already on PyPI, skipping the upload`);
  } else {
    const outDir = join("dist", "python", name);
    run("uv", ["build", "--package", name, "--out-dir", outDir]);
    const missing = readdirSync(join(root, outDir)).filter(
      (f) => (f.endsWith(".whl") || f.endsWith(".tar.gz")) && !present.includes(f),
    );
    if (missing.length) {
      // --check-url also skips a file PyPI has but its JSON API did not list yet.
      run("uv", [
        "publish",
        "--trusted-publishing",
        "always",
        "--check-url",
        "https://pypi.org/simple/",
        ...missing.map((f) => join(outDir, f)),
      ]);
    }
  }

  // An existing tag is never moved: it already points at the commit that was published.
  if (succeeds("git", ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`])) {
    console.log(`${tag}: tag exists`);
  } else {
    if (!succeeds("git", ["rev-parse", "--quiet", "--verify", `refs/tags/${tag}`])) {
      run("git", ["tag", tag]);
    }
    run("git", ["push", "origin", `refs/tags/${tag}`]);
  }

  if (succeeds("gh", ["release", "view", tag])) {
    console.log(`${tag}: GitHub release exists`);
  } else {
    run("gh", [
      "release",
      "create",
      tag,
      "--title",
      tag,
      "--notes",
      releaseNotes(pkgDir, version) || tag,
    ]);
  }
  console.log(`${tag}: published`);
}
