from __future__ import annotations

import importlib.util
import random
from decimal import Decimal
from pathlib import Path


SCRIPT = Path(__file__).parents[2] / "scripts" / "verify" / "tardis" / "verify_historical_l2_day.py"
SPEC = importlib.util.spec_from_file_location("verify_historical_l2_day", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_lazy_price_heaps_match_an_independent_sort_after_replacements_and_deletions():
    rng = random.Random(73019)
    for bid in (True, False):
        side = MODULE.Side(bid)
        oracle = {}
        for step in range(12_000):
            price = Decimal(rng.randrange(100, 600)) / 100
            amount = Decimal(rng.randrange(0, 100)) / 100
            side.update(price, amount)
            if amount:
                oracle[price] = amount
            else:
                oracle.pop(price, None)
            if step % 37 == 0:
                expected = sorted(oracle.items(), key=lambda item: item[0], reverse=bid)[:25]
                assert side.top(25) == expected
                assert side.top(25) == expected


def test_source_object_key_is_one_explicit_provider_day():
    assert MODULE.object_key("binance", "incremental_book_L2", "BTCUSDT", "2026-08-05", "remote:bucket") == (
        "remote:bucket/raw/tardis/exchange=binance/data_type=incremental_book_L2/"
        "symbol=BTCUSDT/year=2026/month=08/day=05/"
        "binance_incremental_book_L2_2026-08-05_BTCUSDT.csv.gz"
    )
