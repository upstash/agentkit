import tomllib
from pathlib import Path

from upstash_hermes_memory import VERSION


def test_version_matches_pyproject():
    # The telemetry constant and the published version must agree; sync-version.mjs keeps them so.
    pyproject = tomllib.loads((Path(__file__).parents[1] / "pyproject.toml").read_text())
    assert VERSION == pyproject["project"]["version"]
