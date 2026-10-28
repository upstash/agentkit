import shutil
import subprocess
import zipfile
from email.parser import Parser
from pathlib import Path

import pytest
import upstash_hermes_memory
from upstash_hermes_memory import VERSION

REPO_ROOT = Path(__file__).parents[3]


def test_public_api():
    assert set(upstash_hermes_memory.__all__) == {
        "VERSION",
        "AgentMemory",
        "ChatHistory",
        "MemoryRecord",
        "UpstashMemoryProvider",
        "register",
    }
    assert isinstance(VERSION, str)


def test_register_hands_hermes_one_provider():
    registered = []

    class Ctx:
        def register_memory_provider(self, provider):
            registered.append(provider)

    upstash_hermes_memory.register(Ctx())
    assert [p.name for p in registered] == ["upstash"]


@pytest.mark.skipif(shutil.which("uv") is None, reason="uv not on PATH")
def test_wheel_contents(tmp_path):
    # What publish-python.mjs uploads: build the wheel the same way and check what is inside it.
    subprocess.run(
        ["uv", "build", "--wheel", "--package", "upstash-hermes-memory", "--out-dir", tmp_path],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
    )
    (wheel,) = tmp_path.glob("*.whl")
    assert wheel.name.startswith(f"upstash_hermes_memory-{VERSION}-")

    dist_info = f"upstash_hermes_memory-{VERSION}.dist-info"
    with zipfile.ZipFile(wheel) as zf:
        names = zf.namelist()
        for module in ("__init__", "_version", "memory", "chat_history", "provider"):
            assert f"upstash_hermes_memory/{module}.py" in names
        # Tests and the private package.json are repo plumbing, not part of the distribution.
        assert not any(n.startswith("tests/") or n.endswith("package.json") for n in names)
        metadata = Parser().parsestr(zf.read(f"{dist_info}/METADATA").decode())
        entry_points = zf.read(f"{dist_info}/entry_points.txt").decode()

    assert metadata["Name"] == "upstash-hermes-memory"
    assert metadata["Version"] == VERSION
    assert metadata["Requires-Python"] == ">=3.11"
    assert any(r.startswith("upstash-redis") for r in metadata.get_all("Requires-Dist"))
    # How Hermes finds the provider once the package is pip-installed next to it.
    assert "[hermes_agent.memory_providers]" in entry_points
    assert "upstash = upstash_hermes_memory:register" in entry_points
