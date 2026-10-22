"""Tags the redis client's telemetry header, the Python counterpart of the TS SDK's addTelemetry."""

import os
from typing import Any

from ._version import VERSION

SDK_TELEMETRY = f"upstash-hermes-memory@{VERSION}"

_HEADER = "Upstash-Telemetry-Sdk"


def add_telemetry(redis: Any, *, enabled: bool = True) -> None:
    """Append this package's tag to the `Upstash-Telemetry-Sdk` header, once per client.

    upstash-redis only sends the header when the client allows telemetry, so a client created
    with `allow_telemetry=False` stays untagged, as does any process with
    `UPSTASH_DISABLE_TELEMETRY` set.
    """
    if not enabled or os.environ.get("UPSTASH_DISABLE_TELEMETRY"):
        return
    headers = getattr(redis, "_headers", None)
    if not isinstance(headers, dict) or _HEADER not in headers:
        return
    tags = headers[_HEADER].split(",")
    if SDK_TELEMETRY not in tags:
        headers[_HEADER] = ",".join([*tags, SDK_TELEMETRY])
