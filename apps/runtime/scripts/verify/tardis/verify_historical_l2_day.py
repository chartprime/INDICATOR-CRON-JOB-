"""Read-only full-day comparison of retained incremental books and wide snapshots.

Run with the scoped converter environment on the host. No object is written.
The wide file samples selected update groups; this verifies those matching
states and ordering, not the existence of every packet between observations.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import heapq
import json
import subprocess
from decimal import Decimal, InvalidOperation
from itertools import groupby


def object_key(exchange: str, kind: str, symbol: str, day: str, remote: str) -> str:
    year, month, date = day.split("-")
    path = (f"raw/tardis/exchange={exchange}/data_type={kind}/symbol={symbol}/"
            f"year={year}/month={month}/day={date}/"
            f"{exchange}_{kind}_{day}_{symbol}.csv.gz")
    return f"{remote.rstrip('/')}/{path}"


class Source:
    def __init__(self, key: str):
        self.process = subprocess.Popen(["rclone", "cat", key], stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL)
        assert self.process.stdout is not None
        self.stream = gzip.open(self.process.stdout, "rt", newline="")
        self.reader = csv.DictReader(self.stream)

    def close(self) -> None:
        self.stream.close()
        if self.process.wait() != 0:
            raise RuntimeError("source read failed")


class Side:
    def __init__(self, bid: bool):
        self.bid = bid
        self.levels: dict[Decimal, tuple[Decimal, int]] = {}
        self.heap: list[tuple[Decimal, int, Decimal]] = []
        self.version = 0

    def update(self, price: Decimal, amount: Decimal) -> None:
        self.version += 1
        if amount == 0:
            self.levels.pop(price, None)
        else:
            self.levels[price] = (amount, self.version)
            heapq.heappush(self.heap, (-price if self.bid else price, self.version, price))
        if len(self.heap) > 4 * len(self.levels) + 10_000:
            self.heap = [(-p if self.bid else p, v, p) for p, (_, v) in self.levels.items()]
            heapq.heapify(self.heap)

    def top(self, count: int) -> list[tuple[Decimal, Decimal]]:
        held = []
        while self.heap and len(held) < count:
            item = heapq.heappop(self.heap)
            _, version, price = item
            current = self.levels.get(price)
            if current is not None and current[1] == version:
                held.append(item)
        for item in held:
            heapq.heappush(self.heap, item)
        return [(price, self.levels[price][0]) for _, _, price in held]


def pair(row: dict[str, str]) -> tuple[int, int]:
    return int(row["local_timestamp"]), int(row["timestamp"])


def level(row: dict[str, str], side: str, index: int) -> tuple[Decimal, Decimal] | None:
    price = row[f"{side}[{index}].price"]
    amount = row[f"{side}[{index}].amount"]
    if not price or not amount:
        return None
    return Decimal(price), Decimal(amount)


def verify(exchange: str, symbol: str, day: str, remote: str,
           focus_local_us: tuple[int, int] | None = None,
           uncross_overlap: bool = False) -> dict[str, object]:
    incremental = Source(object_key(exchange, "incremental_book_L2", symbol, day, remote))
    snapshots = Source(object_key(exchange, "book_snapshot_25", symbol, day, remote))
    result: dict[str, object] = {
        "exchange": exchange, "symbol": symbol, "day": day, "rows": 0, "groups": 0,
        "snapshotGroups": 0, "matchedReferences": 0, "unmatchedReferences": 0,
        "mismatchedReferences": 0, "invalidBooks": 0, "maxGroupRows": 0,
        "maxBidLevels": 0, "maxAskLevels": 0, "mixedSnapshotGroups": 0,
        "firstMismatches": [], "snapshotPairs": [], "mismatchRanges": [], "mismatchRangeCount": 0,
        "focusIntermediateCrossings": 0, "focusFirstCrossings": [],
        "overlapRemovals": 0,
    }
    bids, asks = Side(True), Side(False)
    seeded = False
    reference = next(snapshots.reader, None)
    last_pair = None
    mismatch_range = None
    try:
        for group_key, rows in groupby(incremental.reader, pair):
            if last_pair is not None and group_key < last_pair:
                raise RuntimeError("incremental receive/event order regressed")
            last_pair = group_key
            count = 0
            flags = set()
            for row in rows:
                count += 1
                flags.add(row["is_snapshot"])
                if count > 100_000:
                    raise RuntimeError("timestamp group exceeds 100000 rows")
                if row["exchange"] != exchange or row["symbol"] != symbol:
                    raise RuntimeError("incremental identity mismatch")
                if row["is_snapshot"] == "true":
                    if count == 1:
                        bids, asks = Side(True), Side(False)
                        seeded = True
                        result["snapshotGroups"] += 1
                        result["snapshotPairs"].append(list(group_key))
                elif row["is_snapshot"] != "false":
                    raise RuntimeError("invalid snapshot flag")
                if row["side"] not in ("bid", "ask"):
                    raise RuntimeError("invalid side")
                try:
                    price, amount = Decimal(row["price"]), Decimal(row["amount"])
                except InvalidOperation as error:
                    raise RuntimeError("invalid decimal") from error
                if not price.is_finite() or not amount.is_finite() or price <= 0 or amount < 0:
                    raise RuntimeError("invalid price or amount")
                if seeded:
                    (bids if row["side"] == "bid" else asks).update(price, amount)
                    if uncross_overlap and row["is_snapshot"] == "false" and amount > 0:
                        opposite = asks if row["side"] == "bid" else bids
                        while True:
                            facing = opposite.top(1)
                            if not facing or (price < facing[0][0] if row["side"] == "bid"
                                              else price > facing[0][0]):
                                break
                            opposite.update(facing[0][0], Decimal(0))
                            result["overlapRemovals"] += 1
                    if focus_local_us is not None and focus_local_us[0] <= group_key[0] <= focus_local_us[1]:
                        interim_bid, interim_ask = bids.top(1), asks.top(1)
                        if interim_bid and interim_ask and interim_bid[0][0] >= interim_ask[0][0]:
                            result["focusIntermediateCrossings"] += 1
                            if len(result["focusFirstCrossings"]) < 12:
                                result["focusFirstCrossings"].append({
                                    "pair": list(group_key), "rowInGroup": count,
                                    "update": [row["side"], row["price"], row["amount"]],
                                    "bid": [str(value) for value in interim_bid[0]],
                                    "ask": [str(value) for value in interim_ask[0]],
                                })
            result["rows"] += count
            result["groups"] += 1
            if len(flags) > 1:
                result["mixedSnapshotGroups"] += 1
            result["maxGroupRows"] = max(result["maxGroupRows"], count)
            result["maxBidLevels"] = max(result["maxBidLevels"], len(bids.levels))
            result["maxAskLevels"] = max(result["maxAskLevels"], len(asks.levels))
            best_bid, best_ask = bids.top(1), asks.top(1)
            if seeded and (not best_bid or not best_ask or best_bid[0][0] >= best_ask[0][0]):
                result["invalidBooks"] += 1
                seeded = False
            while reference is not None and pair(reference) < group_key:
                result["unmatchedReferences"] += 1
                reference = next(snapshots.reader, None)
            while reference is not None and pair(reference) == group_key:
                if reference["exchange"] != exchange or reference["symbol"] != symbol:
                    raise RuntimeError("snapshot identity mismatch")
                expected_bid = [level(reference, "bids", i) for i in range(25)]
                expected_ask = [level(reference, "asks", i) for i in range(25)]
                expected_bid = [item for item in expected_bid if item is not None]
                expected_ask = [item for item in expected_ask if item is not None]
                actual_bid, actual_ask = bids.top(25), asks.top(25)
                if not seeded or actual_bid != expected_bid or actual_ask != expected_ask:
                    result["mismatchedReferences"] += 1
                    if mismatch_range is None:
                        mismatch_range = {"firstPair": list(group_key), "lastPair": list(group_key), "count": 0}
                    mismatch_range["lastPair"] = list(group_key)
                    mismatch_range["count"] += 1
                    if len(result["firstMismatches"]) < 12:
                        result["firstMismatches"].append({
                            "group": result["groups"], "pair": list(group_key),
                            "bidsEqual": actual_bid == expected_bid,
                            "asksEqual": actual_ask == expected_ask,
                            "expectedBids": [[str(p), str(a)] for p, a in expected_bid[:3]],
                            "actualBids": [[str(p), str(a)] for p, a in actual_bid[:3]],
                            "expectedAsks": [[str(p), str(a)] for p, a in expected_ask[:3]],
                            "actualAsks": [[str(p), str(a)] for p, a in actual_ask[:3]],
                        })
                else:
                    result["matchedReferences"] += 1
                    if mismatch_range is not None:
                        result["mismatchRangeCount"] += 1
                        if len(result["mismatchRanges"]) < 30:
                            result["mismatchRanges"].append(mismatch_range)
                        mismatch_range = None
                reference = next(snapshots.reader, None)
        if mismatch_range is not None:
            result["mismatchRangeCount"] += 1
            if len(result["mismatchRanges"]) < 30:
                result["mismatchRanges"].append(mismatch_range)
        while reference is not None:
            result["unmatchedReferences"] += 1
            reference = next(snapshots.reader, None)
    finally:
        incremental.close()
        snapshots.close()
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--exchange", choices=("binance", "binance-futures"), required=True)
    parser.add_argument("--symbol", choices=("BTCUSDT", "ETHUSDT"), required=True)
    parser.add_argument("--day", required=True)
    parser.add_argument("--remote", default="ttconvert:chartprime-historical-data")
    parser.add_argument("--focus-local-us", nargs=2, type=int, metavar=("FROM", "TO"))
    parser.add_argument("--uncross-overlap", action="store_true")
    arguments = parser.parse_args()
    focus = tuple(arguments.focus_local_us) if arguments.focus_local_us is not None else None
    outcome = verify(arguments.exchange, arguments.symbol, arguments.day, arguments.remote,
                     focus, arguments.uncross_overlap)
    print(json.dumps(outcome, sort_keys=True))
    if (outcome["matchedReferences"] == 0 or outcome["unmatchedReferences"] != 0
            or outcome["mismatchedReferences"] != 0 or outcome["invalidBooks"] != 0):
        raise SystemExit(1)
