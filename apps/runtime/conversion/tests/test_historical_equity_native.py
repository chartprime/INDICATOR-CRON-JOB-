from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).parents[2] / "scripts/verify/databento"))
import verify_historical_equity_native as verifier


def source():
    records, rows = [], []
    for i, action in enumerate(("A", "T", "T", "C")):
        amount = 5 if i < 2 else 3
        native = SimpleNamespace(ts_event=100+i, ts_recv=200+i, sequence=i, flags=128,
            action=action, side="B", size=2, price=101_000_000_000,
            levels=[SimpleNamespace(bid_px=99_000_000_000,bid_sz=10,ask_px=101_000_000_000,ask_sz=amount)])
        row = {"event_ns":str(100+i),"receive_ns":str(200+i),"sequence":i,"native_flags":128,
            "stable_position":str(i),"lineage_row":str(i),
            "bids":[{"price":"99.000000000000","size":"10"}],
            "asks":[{"price":"101.000000000000","size":str(amount)}],
            "observation_only":i==1,"matched_trade":None if action!="T" else
            {"side":"BUY","price":"101.000000000000","size":"2"}}
        records.append(native)
        rows.append(row)
    return records,rows


def test_full_native_order_distinguishes_repeated_trades_from_changed_trade_books():
    records, rows = source()
    result=verifier.reconcile(iter(records),iter(rows),4)
    assert result == {"A":1,"T":2,"C":1,"rows":4,"trade_observations":1,"trade_changed_books":1}


@pytest.mark.parametrize("fault", ["order","book","flag","trade","observation","missing","extra","action"])
def test_native_order_refuses_wrong_or_incomplete_evidence(fault):
    records, rows = source()
    rows=deepcopy(rows)
    if fault=="order": rows[1]["stable_position"]="99"
    elif fault=="book": rows[1]["asks"][0]["size"]="6"
    elif fault=="flag": rows[1]["native_flags"]=0
    elif fault=="trade": rows[1]["matched_trade"]["size"]="3"
    elif fault=="observation": rows[1]["observation_only"]=False
    elif fault=="missing": rows.pop()
    elif fault=="extra": records.pop()
    else: records[1].action="F"
    with pytest.raises(ValueError): verifier.reconcile(iter(records),iter(rows),4)


def test_native_receipt_requires_exact_source_pins_and_complete_accounting(tmp_path,monkeypatch):
    monkeypatch.setattr(verifier.checker.core,"DATA_ROOT",tmp_path)
    path=tmp_path/"receipt.json"
    proof={"depth":{"record_count":4},"trade":{"record_count":2},"quote":{"record_count":5}}
    value={"scope":verifier.SCOPE,"flow_report_sha256":"b"*64,"raw_sha256":"c"*64,
        "method_sha256":"d"*64,"raw_bytes":100,**proof,
        "counts":{"rows":4,"A":1,"C":1,"T":2,"trade_observations":1,"trade_changed_books":1}}
    path.write_text(verifier.json.dumps(value))
    pin=verifier.checker.core.lifecycle.digest(path)
    assert verifier.validate_receipt(path,pin,proof,"b"*64)==value
    with pytest.raises(ValueError,match="differs from accepted"):
        verifier.validate_receipt(path,pin,{**proof,"trade":{"record_count":3}},"b"*64)
    with pytest.raises(ValueError,match="pin failed"):
        verifier.validate_receipt(path,"e"*64,proof,"b"*64)
    value["counts"]["trade_observations"]=0
    path.write_text(verifier.json.dumps(value))
    with pytest.raises(ValueError,match="accounting admission"):
        verifier.validate_receipt(path,verifier.checker.core.lifecycle.digest(path),proof,"b"*64)
