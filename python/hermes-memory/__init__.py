"""Entry point for directory installs (the Hermes plugin catalog).

The catalog clones this directory and imports its `__init__.py`, so it re-exports `register` from
the package under `src/`. pip installs skip this file and use the `hermes_agent.memory_providers`
entry point in pyproject.toml.
"""

from .src.upstash_hermes_memory import register

__all__ = ["register"]
