import json
import re
import tomllib
from importlib.metadata import version
from pathlib import Path

from upstash_hermes_memory import VERSION

PACKAGE_DIR = Path(__file__).parents[1]


def test_version_matches_pyproject():
    # The telemetry constant and the published version must agree; sync-version.mjs keeps them so.
    pyproject = tomllib.loads((PACKAGE_DIR / "pyproject.toml").read_text())
    assert VERSION == pyproject["project"]["version"]


def test_version_matches_package_json():
    # Changesets bumps the private package.json; that is the source the other two are copied from.
    package_json = json.loads((PACKAGE_DIR / "package.json").read_text())
    assert VERSION == package_json["version"]


def test_package_json_names_the_distribution():
    # sync-version.mjs derives the module path from this name, and publish-python.mjs queries PyPI
    # with it, so it has to be the PyPI project name exactly.
    package_json = json.loads((PACKAGE_DIR / "package.json").read_text())
    pyproject = tomllib.loads((PACKAGE_DIR / "pyproject.toml").read_text())
    assert package_json["name"] == pyproject["project"]["name"]
    assert package_json["private"] is True


def test_version_is_plain_semver():
    # Changesets writes semver; anything else would not round-trip through PEP 440 unchanged.
    assert re.fullmatch(r"\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?", VERSION)


def test_installed_metadata_matches():
    # Catches a stale `uv sync`: the environment must carry the version the source declares.
    assert version("upstash-hermes-memory") == VERSION
