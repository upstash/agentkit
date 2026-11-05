// The `[project]` name and version of a Python package, read from its pyproject.toml. Node has no
// TOML parser and these two keys are plain strings, so a line match inside `[project]` is enough.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** @returns {{ name: string, version: string }} */
export const pyprojectOf = (pkgDir) => {
  const toml = readFileSync(join(pkgDir, "pyproject.toml"), "utf8");
  const project = toml.split(/^\[/m).find((section) => section.startsWith("project]"));
  const key = (k) => project?.match(new RegExp(`^${k} = "([^"]+)"$`, "m"))?.[1];
  const name = key("name");
  const version = key("version");
  if (!name || !version)
    throw new Error(`${pkgDir}/pyproject.toml: [project] name/version not found`);
  return { name, version };
};
