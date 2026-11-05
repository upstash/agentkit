"""Tags the redis client's telemetry header, the Python counterpart of the TS SDK's addTelemetry.

Off unless asked for: the Hermes plugin catalog requires telemetry to be opt-in (catalog rule 13),
so `enabled` defaults to False and the provider turns it on only for `UPSTASH_HERMES_TELEMETRY=1`.
"""

import os
from typing import Any

from ._version import VERSION

SDK_TELEMETRY = f"upstash-hermes-memory@{VERSION}"

_HEADER = "Upstash-Telemetry-Sdk"

OPT_IN_ENV = "UPSTASH_HERMES_TELEMETRY"
OPT_OUT_ENV = "UPSTASH_DISABLE_TELEMETRY"


def is_opt_in(value: str | None) -> bool:
    """Whether an `UPSTASH_HERMES_TELEMETRY` value turns telemetry on (`1`, `true`, `yes`, `on`)."""
    return (value or "").strip().lower() in ("1", "true", "yes", "on")


def add_telemetry(redis: Any, *, enabled: bool = False) -> None:
    """Append this package's tag to the `Upstash-Telemetry-Sdk` header, once per client.

    Does nothing unless `enabled`. upstash-redis only sends the header when the client allows
    telemetry, so a client created with `allow_telemetry=False` stays untagged, as does any
    process with `UPSTASH_DISABLE_TELEMETRY` set, which wins over an opt-in.
    """
    if not enabled or os.environ.get(OPT_OUT_ENV):
        return
    headers = getattr(redis, "_headers", None)
    if not isinstance(headers, dict) or _HEADER not in headers:
        return
    tags = headers[_HEADER].split(",")
    if SDK_TELEMETRY not in tags:
        headers[_HEADER] = ",".join([*tags, SDK_TELEMETRY])
