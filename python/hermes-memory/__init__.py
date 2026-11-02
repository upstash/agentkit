"""Entry point for directory installs (the Hermes plugin catalog).

The catalog clones this directory and imports its `__init__.py`. pip installs skip this file and use
the `hermes_agent.memory_providers` entry point in pyproject.toml.

`register` is defined here, not re-exported from `src/`: Hermes decides whether a directory plugin is
a memory provider by parsing (never importing) its root-level modules for a
`register_memory_provider(...)` call or a `MemoryProvider` subclass (`_defines_memory_provider` in
hermes-agent's plugins/memory/__init__.py). A re-export alone fails that check, so a catalog install
could not be activated with `memory.provider: upstash`.
"""

from .src.upstash_hermes_memory import UpstashMemoryProvider

__all__ = ["register"]


def register(ctx) -> None:
    """Hermes plugin entry point for directory installs."""
    ctx.register_memory_provider(UpstashMemoryProvider())
