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
// After a successful upload the script tags `<name>@<version>` and opens a GitHub release with that
// version's CHANGELOG section, matching what changesets does for the npm packages.
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

/** Whether PyPI already serves `name==version`. Anything but 200/404 is an error, not a "no". */
const onPyPI = async (name, version) => {
  const res = await fetch(`https://pypi.org/pypi/${name}/${version}/json`);
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`PyPI lookup for ${name}==${version} failed: HTTP ${res.status}`);
};

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
  if (await onPyPI(name, version)) {
    console.log(`${name}@${version}: already on PyPI, skipping`);
    continue;
  }
  if (dryRun) {
    console.log(`${name}@${version}: would build, publish and tag`);
    continue;
  }

  const outDir = join("dist", "python", name);
  run("uv", ["build", "--package", name, "--out-dir", outDir]);
  run("uv", ["publish", "--trusted-publishing", "always", join(outDir, "*")]);

  const tag = `${name}@${version}`;
  run("git", ["tag", tag]);
  run("git", ["push", "origin", tag]);
  run("gh", [
    "release",
    "create",
    tag,
    "--title",
    tag,
    "--notes",
    releaseNotes(pkgDir, version) || tag,
  ]);
  console.log(`${tag}: published`);
}
