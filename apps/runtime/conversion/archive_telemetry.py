from __future__ import annotations

import threading

LATENCY_BUCKETS_MS = (5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000)

STAGES = (
    "admissionWaitMs",
    "serviceMs",
    "discoverMs",
    "fetchMs",
    "manifestMs",
    "cacheLookupMs",
    "downloadMs",
    "readerAcquireMs",
    "readerRoundTripMs",
    "queryMs",
)


class StageTelemetry:
    def __init__(self, stages=STAGES, buckets=LATENCY_BUCKETS_MS):
        self._stages = tuple(stages)
        self._buckets = tuple(buckets)
        self._lock = threading.Lock()
        self._state = {stage: self._empty() for stage in self._stages}

    def _empty(self):
        return {"count": 0, "totalMs": 0.0, "maxMs": 0.0, "buckets": [0] * (len(self._buckets) + 1)}

    def observe(self, stage, milliseconds):
        if stage not in self._state:
            raise ValueError(f"UNKNOWN_TELEMETRY_STAGE:{stage}")
        value = float(milliseconds)
        if value != value or value < 0.0:
            return
        index = len(self._buckets)
        for position, upper in enumerate(self._buckets):
            if value <= upper:
                index = position
                break
        with self._lock:
            entry = self._state[stage]
            entry["count"] += 1
            entry["totalMs"] += value
            if value > entry["maxMs"]:
                entry["maxMs"] = value
            entry["buckets"][index] += 1

    def snapshot(self):
        with self._lock:
            stages = {
                stage: {
                    "count": entry["count"],
                    "totalMs": entry["totalMs"],
                    "maxMs": entry["maxMs"],
                    "buckets": list(entry["buckets"]),
                }
                for stage, entry in self._state.items()
            }
        return {"latencyBucketsMs": list(self._buckets), "stages": stages}

    def reset(self):
        with self._lock:
            self._state = {stage: self._empty() for stage in self._stages}


DEFAULT_TELEMETRY = StageTelemetry()
