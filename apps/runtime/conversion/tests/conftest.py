import shutil
from collections import namedtuple

import pytest

_DiskUsage = namedtuple("_DiskUsage", ["total", "used", "free"])


@pytest.fixture(autouse=True)
def _stop_pooled_readers():
    # Reader processes are pooled and live past a single query on purpose. A
    # suite this size would otherwise finish holding one child per tmp_path.
    yield
    try:
        import archive_service
    except ImportError:
        return
    archive_service.shutdown_readers()


@pytest.fixture(autouse=True)
def _ample_disk(monkeypatch):
    # The backfill refuses to start below 50 GB free. Measuring the machine
    # running the tests made them pass or fail by its disk; a test about the
    # refusal sets its own reading.
    monkeypatch.setattr(shutil, "disk_usage", lambda path: _DiskUsage(1 << 50, 0, 1 << 50))
