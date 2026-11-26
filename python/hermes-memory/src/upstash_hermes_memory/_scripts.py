"""Lua scripts with Upstash's script flags, the Python counterpart of the TS SDK's scripts module.

Upstash Redis reads two flags from a script's shebang line:

- `flags=allow-key-locking` lets scripts for different keys run in parallel. Every script here
  touches only its `KEYS`.
- `script_name=agentkit-hermes-memory-py-<name>` names the script in Upstash's script metrics.
  Since that is usage reporting, it is only sent when telemetry is on (opt-in for this package,
  see `_telemetry`).

Other Redis servers reject the shebang. With `enable_upstash_script_flags` left as `None`, a
rejected script is run again without the flags, a warning is logged once, and the flags are left
off for that client from then on. `False` never sends them; `True` always does and raises on a
rejection.
"""

import logging
import os
import weakref
from typing import Any

from ._telemetry import OPT_OUT_ENV

SCRIPT_NAME_PREFIX = "agentkit-hermes-memory-py"

logger = logging.getLogger(__name__)

_flags_rejected: "weakref.WeakSet[Any]" = weakref.WeakSet()
_warned = False


def build_script(name: str, script: str, *, with_flags: bool, with_name: bool) -> str:
    """The script to send: with `with_flags`, prefixed by the Upstash shebang."""
    if not with_flags:
        return script
    script_name = f" script_name={SCRIPT_NAME_PREFIX}-{name}" if with_name else ""
    return f"#!lua{script_name} flags=allow-key-locking\n{script}"


def is_script_flag_error(error: BaseException) -> bool:
    """Whether the server refused the Upstash flags in the shebang (see the TS SDK for the cases)."""
    message = str(error)
    return (
        "shebang" in message.lower() or "near '#'" in message or "Unknown metadata value" in message
    )


def _warn_flags_rejected() -> None:
    global _warned
    if _warned:
        return
    _warned = True
    logger.warning(
        "Your Redis database doesn't support the flags the scripts are sent with to improve "
        "performance, so the scripts are sent without them. Pass "
        "enable_upstash_script_flags=False to send the scripts without the flags from the start "
        "and to hide this warning."
    )


def eval_script(
    redis: Any,
    name: str,
    script: str,
    keys: list[str],
    args: list[Any],
    *,
    enable_upstash_script_flags: bool | None = None,
    enable_telemetry: bool = False,
) -> Any:
    """Run the script with EVAL, with the Upstash flags unless they are off or were rejected."""

    def run(body: str) -> Any:
        return redis.execute(["EVAL", body, str(len(keys)), *keys, *args])

    try:
        rejected = redis in _flags_rejected
    except TypeError:  # a client that can't be weakly referenced
        rejected = False
    with_flags = enable_upstash_script_flags is not False and not rejected
    if not with_flags:
        return run(script)
    with_name = enable_telemetry and not os.environ.get(OPT_OUT_ENV)
    try:
        return run(build_script(name, script, with_flags=True, with_name=with_name))
    except Exception as error:
        if enable_upstash_script_flags is None and is_script_flag_error(error):
            try:
                _flags_rejected.add(redis)
            except TypeError:
                pass
            _warn_flags_rejected()
            return run(script)
        raise
