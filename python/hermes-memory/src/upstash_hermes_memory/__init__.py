"""Upstash Redis memory provider for Hermes Agent.

Hermes stopped taking new memory providers in its own repository: they ship as standalone plugins
and are listed in its plugin catalog. This package is that plugin, and it lives in the AgentKit
monorepo rather than in a repository of its own so the Python port reads and writes exactly the
keys and Redis Search indexes the TypeScript SDK does. A memory saved from an AI SDK app is then
recalled by a Hermes agent on the same database.
"""

from ._version import VERSION
from .chat_history import ChatHistory
from .memory import AgentMemory, MemoryRecord
from .provider import UpstashMemoryProvider

__all__ = [
    "VERSION",
    "AgentMemory",
    "ChatHistory",
    "MemoryRecord",
    "UpstashMemoryProvider",
    "register",
]


def register(ctx) -> None:
    """Hermes plugin entry point (`hermes_agent.memory_providers`)."""
    ctx.register_memory_provider(UpstashMemoryProvider())
