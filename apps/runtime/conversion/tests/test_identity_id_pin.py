"""Pin `identity.instrument_id` against the real `identity.js` `instrument().id`
so the Python precomputation used for the authority plan (0.10) cannot
silently drift from the one true implementation the bridge actually uses."""
from __future__ import annotations

import json
import os
import shutil
import subprocess

import pytest

import identity

HERE = os.path.dirname(os.path.abspath(__file__))
IDENTITY_JS = os.path.normpath(os.path.join(HERE, "..", "..", "src", "data-contracts", "v1", "identity.js"))

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")

_CASES = [
    {"venue": "XNAS", "market": "EQUITY", "symbol": "AAPL", "currency": "USD", "sizeUnit": "SHARE", "contract": None},
    {"venue": "XCME", "market": "FUTURE", "symbol": "ESZ5", "currency": "USD", "sizeUnit": "CONTRACT", "contract": "ESZ5"},
]


def _node_ids():
    script = (
        f"const {{ instrument }} = require({json.dumps(IDENTITY_JS)});"
        f"const cases = {json.dumps(_CASES)};"
        "console.log(JSON.stringify(cases.map(c => instrument(c).id)));"
    )
    out = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def test_python_instrument_id_matches_the_real_node_implementation_byte_for_byte():
    assert [identity.instrument_id(c) for c in _CASES] == _node_ids()
