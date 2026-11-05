import re
import tomllib
from importlib.metadata import version
from pathlib import Path

from upstash_hermes_memory import VERSION

PACKAGE_DIR = Path(__file__).parents[1]


def test_version_matches_pyproject():
    # pyproject.toml is the source; sync-version.mjs copies it into _version.py and plugin.yaml.
    pyproject = tomllib.loads((PACKAGE_DIR / "pyproject.toml").read_text())
    assert VERSION == pyproject["project"]["version"]


def test_no_package_json_in_the_plugin_directory():
    # Hermes reads a package.json in a plugin directory as Node dependencies and asks to `npm ci`
    # them ("Skipped Node deps" when declined), so the version lives in pyproject.toml only.
    assert not (PACKAGE_DIR / "package.json").exists()


def test_version_matches_plugin_manifest():
    # Catalog installs read plugin.yaml, not pyproject.toml; sync-version.mjs copies the version.
    manifest = (PACKAGE_DIR / "plugin.yaml").read_text()
    assert re.search(r'^version: "(.*)"$', manifest, re.MULTILINE).group(1) == VERSION


def test_version_is_plain_semver():
    # Plain semver round-trips through PEP 440 unchanged, so the tag, PyPI and plugin.yaml agree.
    assert re.fullmatch(r"\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?", VERSION)


def test_installed_metadata_matches():
    # Catches a stale `uv sync`: the environment must carry the version the source declares.
    assert version("upstash-hermes-memory") == VERSION
