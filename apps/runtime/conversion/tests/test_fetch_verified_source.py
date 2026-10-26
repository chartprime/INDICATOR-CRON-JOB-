from __future__ import annotations

import hashlib
import importlib
import io
from pathlib import Path
import sys

import pytest


sys.path.insert(0, str(Path(__file__).parents[2] / "scripts" / "verify" / "databento"))
reader = importlib.import_module("fetch_verified_part")
KEY = "raw/databento/dataset=GLBX.MDP3/schema=mbp-10/symbol=ES/year=2026/month=08/day=05/source.dbn.zst"


@pytest.fixture
def source(tmp_path, monkeypatch):
    monkeypatch.setattr(reader, "DATA_ROOT", tmp_path)
    return {"host": "ttadmin@example.test", "relative_key": KEY, "expected_bytes": 3,
            "expected_sha256": hashlib.sha256(b"dbn").hexdigest(), "output": tmp_path / "source.dbn.zst"}


def test_raw_source_is_an_explicit_opt_in(source):
    with pytest.raises(ValueError, match="invalid curated part key"):
        reader.fetch(**source)


@pytest.mark.parametrize("replacement", ["../", "schema=mbp-1", "curated/databento", "x;echo"])
def test_raw_source_refuses_wrong_schema_prefix_and_shell_paths(source, replacement):
    source["relative_key"] = KEY.replace("schema=mbp-10", replacement)
    with pytest.raises(ValueError, match="invalid raw DBN key"):
        reader.fetch_dbn(**source)


@pytest.mark.parametrize("size", [True, 0, reader.MAX_DBN_BYTES + 1])
def test_raw_source_refuses_unbounded_or_invalid_admission(source, size):
    source["expected_bytes"] = size
    with pytest.raises(ValueError, match="invalid expected byte count"):
        reader.fetch_dbn(**source)


def test_raw_source_reuses_only_the_same_verified_identity(source):
    source["output"].write_bytes(b"dbn")
    reader.fetch_dbn(**source)
    source["output"].write_bytes(b"bad")
    with pytest.raises(FileExistsError, match="different identity"):
        reader.fetch_dbn(**source)
    assert source["output"].read_bytes() == b"bad"


def test_nasdaq_native_depth_is_explicitly_admitted_without_allowing_other_datasets(source):
    source["relative_key"]=KEY.replace("GLBX.MDP3","XNAS.ITCH")
    source["output"].write_bytes(b"dbn")
    reader.fetch_dbn(**source)
    source["relative_key"]=KEY.replace("GLBX.MDP3","XNYS.PILLAR")
    with pytest.raises(ValueError,match="invalid raw DBN key"):
        reader.fetch_dbn(**source)


def test_raw_source_cannot_write_outside_pilot_data(source):
    source["output"] = source["output"].parent.parent / "source.dbn.zst"
    with pytest.raises(ValueError, match="matching format under ignored"):
        reader.fetch_dbn(**source)


@pytest.mark.parametrize("payload", [b"too large", b"bad"])
def test_failed_source_copy_never_admits_or_leaves_partial_files(source, monkeypatch, payload):
    appdata = source["output"].parent / "appdata"
    key = appdata / "Terminal-L1-L2" / "ssh-bootstrap" / "id_ed25519"
    key.parent.mkdir(parents=True)
    key.write_text("test identity placeholder", encoding="utf-8")
    monkeypatch.setenv("LOCALAPPDATA", str(appdata))

    class Process:
        stdout = io.BytesIO(payload)

        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

        def wait(self):
            return 0

        def kill(self):
            pass

    monkeypatch.setattr(reader.subprocess, "Popen", lambda *_args, **_kwargs: Process())
    with pytest.raises(RuntimeError, match="source exceeds|source identity differs"):
        reader.fetch_dbn(**source)
    assert not source["output"].exists()
    assert list(source["output"].parent.glob("*.part")) == []
