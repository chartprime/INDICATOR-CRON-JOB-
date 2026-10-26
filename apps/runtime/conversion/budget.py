"""Conservative local scratch reservation, shared by split and partition stages.

Ceilings are fail-closed; the host must still enforce process/cgroup limits.
"""
import os
import shutil


def positive_env(name, default):
    value = int(os.environ.get(name, default))
    if value <= 0:
        raise ValueError(f"INVALID_LIMIT:{name}")
    return value


def check(root, additional=0):
    maximum = positive_env("TT_CONVERT_SCRATCH_BYTES", 8 * 1024**3)
    reserve = positive_env("TT_CONVERT_FREE_RESERVE_BYTES", 1024**3)
    used = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(root) for f in fs)
    if used + additional > maximum:
        raise RuntimeError(
            "SCRATCH_BUDGET_EXCEEDED:STAGE_OVER_BUDGET:"
            f"used={used}:additional={additional}:maximum={maximum}")
    free = shutil.disk_usage(root).free
    if free < reserve + additional:
        raise RuntimeError(
            "SCRATCH_BUDGET_EXCEEDED:FREE_BELOW_RESERVE:"
            f"free={free}:reserve={reserve}:additional={additional}")
    return maximum - used
