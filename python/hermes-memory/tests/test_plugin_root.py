"""The root `__init__.py` must pass Hermes's static memory-provider check for directory installs."""

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _registers_memory_provider(module: Path) -> bool:
    # Same rule as `_defines_memory_provider` in hermes-agent's plugins/memory/__init__.py: a
    # `register_memory_provider(...)` call in a root-level module, found by parsing, not importing.
    tree = ast.parse(module.read_text(encoding="utf-8"))
    return any(
        isinstance(node, ast.Call)
        and "register_memory_provider"
        in (getattr(node.func, "attr", None), getattr(node.func, "id", None))
        for node in ast.walk(tree)
    )


def test_root_init_registers_the_provider():
    assert _registers_memory_provider(ROOT / "__init__.py")
