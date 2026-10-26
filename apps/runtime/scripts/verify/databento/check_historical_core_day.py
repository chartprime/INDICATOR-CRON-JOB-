"""Compare stored lifecycle changes and inference accounting with an independent source walk."""

from __future__ import annotations

import argparse
from collections import Counter
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import tempfile

import derive_historical_cme_core as core


def coordinate(values, tick, descending):
    if not isinstance(values, list) or len(values) > 10:
        raise ValueError("independent depth admission failed")
    result = {}
    previous = None
    for level in values:
        price, size = Decimal(level["price"]), Decimal(level["size"])
        key = price / tick
        if (price <= 0 or key != int(key) or key > 9007199254740991 or size <= 0 or size != int(size) or size > 9007199254740991
                or previous is not None and (key >= previous if descending else key <= previous)):
            raise ValueError("independent book geometry failed")
        result[int(key)] = int(size)
        previous = key
    return result


def changes(before, after, seeded, depth=10):
    output, lost, seeds = [], [], []
    for side in ("bid", "ask"):
        old, new = before[side], after[side]
        edge = min(new) if side == "bid" else max(new)
        prior_edge = (min(old) if side == "bid" else max(old)) if old else None
        for key in old.keys() | new.keys():
            a, b = old.get(key), new.get(key)
            if a == b and not seeded:
                continue
            outside = key < edge if side == "bid" else key > edge
            if b is None and len(new) == depth and outside:
                lost.append((side, key))
                continue
            prior_outside = prior_edge is not None and (key < prior_edge if side == "bid" else key > prior_edge)
            preexisting = seeded or a is None and len(old) == depth and prior_outside
            output.append((side, key, None if preexisting else a or 0, b or 0))
            if preexisting:
                seeds.append((side, key))
    return output, lost, seeds


def record(size=0, empty_at=None):
    return dict(size=size, added=0, cancelled=0, traded=0, tradedVisible=0, swept=0, absorbed=0,
                sweptVisible=0, absorbedVisible=0, pa=0, ps=0, ending=None, explained=0, emptied=empty_at)


class Reference:
    def __init__(self, tick):
        self.tick = Decimal(tick)
        self.previous = {"bid": {}, "ask": {}}
        self.records = {}
        self.active = False
        self.suspended = False
        self.pruned = None
        self.epoch = None
        self.date = None

    def settle(self, ts, forced=None):
        result = []
        for point, value in self.records.items():
            if value["ending"] is None:
                continue
            filled = 2 * value["explained"] >= value["ending"]
            if filled or point == forced or ts - value["emptied"] >= 1500:
                result.append((*point, "filled" if filled else "pulled", value["ending"], value["explained"]))
                value["ending"] = None
                value["explained"] = 0
        return result

    def step(self, row):
        ts = int(row["event_ns"]) // 1_000_000
        after = {side: coordinate(row[plural], self.tick, side == "bid") for side, plural in (("bid", "bids"), ("ask", "asks"))}
        valid = bool(after["bid"] and after["ask"] and max(after["bid"]) < min(after["ask"]))
        if row["continuity"] == "GAP_SUSPECTED":
            self.suspended = True
        elif self.suspended and row["continuity"] == "RESET" and valid:
            self.suspended = False
        valid = valid and not self.suspended
        reset = not self.active or row["continuity"] in ("RESET", "UNKNOWN") or self.epoch != row["book_epoch"] or self.date != row["date"]
        self.epoch, self.date = row["book_epoch"], row["date"]
        if not valid:
            self.active = False
            self.records.clear()
            self.previous = {"bid": {}, "ask": {}}
            self.pruned = None
            return [], [], [], []
        if reset:
            self.records.clear()
            self.previous = {"bid": {}, "ask": {}}
            self.pruned = None
        self.active = True
        delta, lost, seeds = changes(self.previous, after, reset)
        if row["observation_only"] and not reset:
            if delta or lost:
                raise ValueError("independent native echo changed the book")
        verdicts = []
        for point in seeds:
            if not reset and point in self.records:
                lost.append(point)
                del self.records[point]
        for point in lost:
            self.records.pop(point, None)
        for side, key, prior, amount in delta:
            point = (side, key)
            value = self.records.setdefault(point, record())
            if (side, key) in seeds:
                value["size"] = amount
                continue
            shrink = max(0, value["size"] - amount)
            swept = min(shrink, value["ps"])
            absorbed = min(shrink - swept, value["pa"])
            value["added"] += max(0, amount - value["size"])
            value["cancelled"] += shrink - swept - absorbed
            value["tradedVisible"] += swept + absorbed
            value["sweptVisible"] += swept
            value["absorbedVisible"] += absorbed
            value["pa"] = value["ps"] = 0
            if value["size"] and not amount:
                value["ending"], value["explained"], value["emptied"] = value["size"], swept + absorbed, ts
            elif not value["size"] and amount:
                verdicts += self.settle(ts, forced=point)
                value["emptied"] = None
            value["size"] = amount
        if not reset and not row["observation_only"]:
            for value in self.records.values():
                value["pa"] = value["ps"] = 0
            verdicts += self.settle(ts)
        if self.pruned is None or ts - self.pruned >= 1000:
            verdicts += self.settle(ts)
            for point, value in list(self.records.items()):
                if value["size"] == 0 and value["emptied"] is not None and ts - value["emptied"] > 60_000:
                    del self.records[point]
            self.pruned = ts
        trades = []
        trade = row.get("matched_trade")
        if trade and trade["side"] in ("BUY", "SELL"):
            side = "ask" if trade["side"] == "BUY" else "bid"
            price = Decimal(trade["price"]) / self.tick
            if price != int(price):
                raise ValueError("directional print off grid")
            point = (side, int(price))
            value = self.records.setdefault(point, record(empty_at=ts))
            quantity = int(trade["size"])
            best = min(after["ask"]) if side == "ask" else max(after["bid"])
            swept = abs(point[1] - best) > 1
            value["traded"] += quantity
            value["swept" if swept else "absorbed"] += quantity
            value["ps" if swept else "pa"] += quantity
            if value["ending"] is not None:
                value["explained"] += quantity
            trades.append((*point, quantity))
        self.previous = after
        return delta, lost, verdicts, trades


def stored_groups(connection, directory, manifest):
    group, key = [], None
    for part in manifest["parts"]:
        file = directory / part["name"]
        cursor = connection.execute("SELECT known_event,known_rank,known_position,known_ordinal,event_type,side,price_key,payload,known_ns "
            "FROM read_parquet(?) WHERE event_type IN ('level_size','engine_trade','engine_verdict','engine_level_state','observation_end') "
            "ORDER BY append_position", [str(file)])
        while batch := cursor.fetchmany(1000):
            for values in batch:
                current = tuple(values[:4])
                kind, side, price, encoded, known = values[4:]
                payload = json.loads(encoded)
                if kind == "observation_end" and payload["cause"] != "DEPTH_EXIT":
                    continue
                if key is not None and current != key:
                    yield key, group
                    group = []
                key = current
                if len(group) >= 20_000:
                    raise ValueError("stored source group exceeds admission")
                group.append((kind, side, price, payload, known))
    if key is not None:
        yield key, group


def reconcile(rows, groups, tick, expected_rows):
    reference = Reference(tick)
    groups = iter(groups)
    current = next(groups, None)
    counts = Counter()
    for row in rows:
        key = tuple(int(row[name]) for name in ("event_ns", "source_rank", "stable_position", "ordinal"))
        if current is not None and current[0] < key:
            raise ValueError("stored source cursor absent from source")
        events = current[1] if current is not None and current[0] == key else []
        delta, lost, verdicts, trades = reference.step(row)
        actual = {kind: [] for kind in ("level_size", "observation_end", "engine_verdict", "engine_trade")}
        for kind, side, price, payload, known in events:
            if known != int(row["known_ns"]):
                raise ValueError("stored inference knowledge differs from its source receipt high water")
            if kind == "engine_level_state":
                value = reference.records.get((side, price))
                state = payload["state"]
                if value is None or any(state[field] != value[field] for field in
                        ("size", "added", "cancelled", "traded", "tradedVisible", "swept", "absorbed")):
                    raise ValueError(f"independent level accounting disagrees at {key} {side} {price}")
                if state["hiddenTraded"] != value["absorbed"] - value["absorbedVisible"] or state["hiddenSwept"] != value["swept"] - value["sweptVisible"]:
                    raise ValueError("hidden and visible volume do not conserve source prints")
            elif kind == "level_size":
                actual[kind].append((side, price, payload["previous_size"], payload["size"]))
            elif kind == "observation_end":
                actual[kind].append((side, price))
            elif kind == "engine_verdict":
                actual[kind].append((side, price, payload["endedBy"], payload["endingSize"], payload["explained"]))
                counts["verdict_" + payload["endedBy"]] += 1
            else:
                if payload["late"] or payload["reclaimed"]:
                    raise ValueError("source-monotone candidate unexpectedly applied a late trade")
                actual[kind].append((side, price, payload["size"]))
        for kind, expected in (("level_size", delta), ("observation_end", lost), ("engine_verdict", verdicts), ("engine_trade", trades)):
            if Counter(actual[kind]) != Counter(expected):
                raise ValueError(f"independent {kind} disagrees at {key}")
            counts[kind] += len(expected)
        if current is not None and current[0] == key:
            current = next(groups, None)
        counts["source_rows"] += 1
        print_row = row.get("matched_trade")
        if print_row is not None:
            side = print_row["side"]
            counts["observed_" + side + "_count"] += 1
            counts["observed_" + side + "_volume"] += int(print_row["size"])
            if not reference.active:
                counts["outside_" + side + "_count"] += 1
                counts["outside_" + side + "_volume"] += int(print_row["size"])
        if counts["source_rows"] % 500_000 == 0:
            print(json.dumps({"checkedSourceRows": counts["source_rows"], "expected": expected_rows}), flush=True)
    if current is not None or counts["source_rows"] != expected_rows:
        raise ValueError("independent source coverage differs from complete day")
    return dict(counts)


def load_output(directory):
    for name, limit in (("config.json", 65536), ("result.json", 1024**2)):
        path = directory / name
        if path.is_symlink() or path.stat().st_size > limit:
            raise ValueError("combined envelope admission failed")
    config = json.loads((directory / "config.json").read_text())
    result = json.loads((directory / "result.json").read_text())
    derivation = hashlib.sha256(json.dumps(config["identity"], separators=(",", ":"), sort_keys=True).encode()).hexdigest()
    if result["identity"] != config["identity"] or config["derivationId"] != derivation or result["completion"]["derivationId"] != derivation:
        raise ValueError("combined output lineage differs from configuration")
    if type(config["expectedRows"]) is not int or not 0 < config["expectedRows"] <= 30_000_000 or result["completion"]["rows"] != config["expectedRows"]:
        raise ValueError("combined source count admission failed")
    manifests = {}
    with core.lifecycle.duckdb.connect(config={"threads": "1", "memory_limit": "128MB"}) as connection:
        for family in ("events", "states"):
            path = directory / family / "manifest.json"
            pin = result["families"][family]
            if path.is_symlink() or path.stat().st_size > 1024**2 or core.lifecycle.digest(path) != pin["manifest_sha256"]:
                raise ValueError("combined family pin failed")
            manifest = json.loads(path.read_text())
            if manifest["derivation_id"] != derivation or manifest["instrument_id"] != config["instrumentId"] or manifest["rows"] != pin["rows"]:
                raise ValueError("combined family identity failed")
            code = dict(config["identity"].get("code", []))
            writer = "historical_l2_lifecycles.py" if family == "events" else "historical_l2_seconds.py"
            if writer in code and manifest["writer_sha256"] != code[writer]:
                raise ValueError("sealed writer differs from pinned derivation code")
            if not isinstance(manifest["parts"], list) or not 1 <= len(manifest["parts"]) <= 1024:
                raise ValueError("combined parts admission failed")
            rows = size = 0
            for index, part in enumerate(manifest["parts"]):
                if (type(part["bytes"]) is not int or not 0 < part["bytes"] <= core.lifecycle.MAX_PART_BYTES
                        or type(part["rows"]) is not int or not 0 < part["rows"] <= core.lifecycle.MAX_PART_ROWS
                        or type(part["decoded_bytes"]) is not int or not 0 < part["decoded_bytes"] <= core.lifecycle.MAX_PART_DECODED):
                    raise ValueError("combined part admission failed")
                path = directory / family / part["name"]
                if part["name"] != f"part-{index:04d}.parquet" or path.is_symlink() or path.stat().st_size != part["bytes"] or core.lifecycle.digest(path) != part["sha256"]:
                    raise ValueError("combined part integrity failed")
                if connection.execute("SELECT sum(num_rows) FROM parquet_file_metadata(?)", [str(path)]).fetchone()[0] != part["rows"]:
                    raise ValueError("combined footer count failed")
                first, last = connection.execute("SELECT min(known_ns),max(known_ns) FROM read_parquet(?)", [str(path)]).fetchone()
                if (first, last) != (int(part["first_known_ns"]), int(part["last_known_ns"])):
                    raise ValueError("combined knowledge bounds failed")
                rows += part["rows"]
                size += part["bytes"]
            if rows != pin["rows"] or size != pin["bytes"] or len(manifest["parts"]) != pin["parts"]:
                raise ValueError("combined manifest totals failed")
            manifests[family] = manifest
    return config, result, manifests


def check(directory, rows):
    checker_pin = core.lifecycle.digest(Path(__file__))
    config, result, manifests = load_output(directory)
    with tempfile.TemporaryDirectory(dir=directory, prefix="verify-") as scratch:
        with core.lifecycle.duckdb.connect(config={"threads": "1", "memory_limit": "128MB", "temp_directory": scratch,
                                                   "max_temp_directory_size": "256MB"}) as connection:
            counts = reconcile(rows, stored_groups(connection, directory / "events", manifests["events"]), config["tickSize"], config["expectedRows"])
            state_flow = Counter()
            family_counts = Counter()
            for part in manifests["states"]["parts"]:
                file = directory / "states" / part["name"]
                for family, count in connection.execute("SELECT family,count(*) FROM read_parquet(?) GROUP BY family", [str(file)]).fetchall():
                    family_counts[family] += count
                cursor = connection.execute("SELECT payload FROM read_parquet(?) WHERE family='l2_level_state_1s' "
                                            "AND json_extract_string(payload,'$.row_kind')='coverage'", [str(file)])
                while batch := cursor.fetchmany(1000):
                    for encoded, in batch:
                        payload = json.loads(encoded)
                        for kind in ("flow", "outside_trust"):
                            state_flow[kind + "_count"] += payload[kind]["count"]
                            for side in ("BUY", "SELL", "UNKNOWN"):
                                state_flow[kind + "_" + side] += payload[kind][side]
            for side in ("BUY", "SELL", "UNKNOWN"):
                observed = result["completion"]["observed"][side]
                outside = result["completion"]["outsideTrust"][side]
                if (observed != {"count": counts.get("observed_" + side + "_count", 0), "volume": counts.get("observed_" + side + "_volume", 0)}
                        or outside != {"count": counts.get("outside_" + side + "_count", 0), "volume": counts.get("outside_" + side + "_volume", 0)}
                        or state_flow["flow_" + side] + state_flow["outside_trust_" + side] != observed["volume"]
                        or state_flow["outside_trust_" + side] != outside["volume"]):
                    raise ValueError("state/source observed or outside-trust flow differs")
            if (state_flow["flow_count"] + state_flow["outside_trust_count"] != sum(value["count"] for value in result["completion"]["observed"].values())
                    or state_flow["outside_trust_count"] != sum(value["count"] for value in result["completion"]["outsideTrust"].values())
                    or dict(family_counts) != {name: result["completion"]["outputRows"][name] for name in ("l2_level_state_1s", "l2_book_segment")}
                    or counts["engine_trade"] != result["completion"]["applied"]):
                raise ValueError("stored family/trade counts differ from complete source")
    if core.lifecycle.digest(Path(__file__)) != checker_pin:
        raise ValueError("checker changed during source walk; receipt refused")
    report = {"scope": "complete source walk; top-ten inferred lifecycle accounting, not order-level cancellation truth",
              "result_sha256": core.lifecycle.digest(directory / "result.json"), "derivation_id": config["derivationId"],
              "checker_sha256": checker_pin, "counts": counts, "families": result["families"]}
    (directory / "independent-check.json").write_text(json.dumps(report, sort_keys=True), encoding="utf-8")
    return report


def equity_source(config, depth, trade, quote, flow_report):
    from derive_historical_equity_core import joined_rows
    from verify_historical_topn_partition import ordered_depth_parts, verified_files

    if core.lifecycle.digest(flow_report) != config["identity"]["flowReportSha256"]:
        raise ValueError("equity flow proof differs from derivation")
    proof = json.loads(flow_report.read_text())
    plans, files = {}, {}
    for family, path in (("depth", depth), ("trade", trade), ("quote", quote)):
        plans[family], files[family] = verified_files(path)
        if plans[family]["partition"] != config["identity"][family] or plans[family]["partition"] != proof[family]:
            raise ValueError("equity checker source differs from accepted derivation")
    if proof.get("candidateOrder") != "quote-confirmed-first-depth-then-trade/1" or proof.get("independentFlowSamples", 0) < 1:
        raise ValueError("equity checker requires an independently accepted source order")
    with tempfile.TemporaryDirectory(dir=depth.parent, prefix="equity-check-") as scratch:
        with core.lifecycle.duckdb.connect(config={"threads": "1", "memory_limit": "256MB", "temp_directory": scratch,
                                                    "max_temp_directory_size": "4GB", "preserve_insertion_order": "false"}) as connection:
            parts = ordered_depth_parts(connection, plans["depth"], files["depth"])
            connection.execute("""
                CREATE TABLE anchors AS WITH first_depth AS (
                    SELECT event_ns, source_rank, stable_position, ordinal, receive_ns, sequence,
                           source_dataset, dbn_publisher_id FROM read_parquet(?)
                    QUALIFY row_number() OVER (
                        PARTITION BY source_dataset, dbn_publisher_id, sequence, event_ns, receive_ns
                        ORDER BY source_rank, stable_position, ordinal)=1
                ) SELECT d.event_ns,d.source_rank,d.stable_position,d.ordinal,t.record_id,t.side,t.price,t.size
                  FROM first_depth d JOIN read_parquet(?) t ON t.event_ns=d.event_ns AND t.receive_ns=d.receive_ns
                  AND t.sequence=d.sequence AND t.source_dataset=d.source_dataset AND t.dbn_publisher_id=d.dbn_publisher_id
            """, [files["depth"], files["trade"]])
            if connection.execute("SELECT count(*) FROM anchors").fetchone()[0] != plans["trade"]["partition"]["record_count"]:
                raise ValueError("equity checker trade anchors differ from source")
            if connection.execute("SELECT count(*) FROM (SELECT event_ns,source_rank,stable_position,ordinal "
                                  "FROM anchors GROUP BY ALL HAVING count(*)<>1)").fetchone()[0]:
                raise ValueError("equity checker has ambiguous trade anchors")
            yield from joined_rows(connection, parts, plans["depth"]["partition"]["date"], int(config["fromNs"]), config["expectedRows"],
                                   trade_observation=config["identity"]["method"].endswith("/2"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--raw", type=Path)
    parser.add_argument("--depth-plan", type=Path, required=True)
    parser.add_argument("--trade-plan", type=Path)
    parser.add_argument("--quote-plan", type=Path)
    parser.add_argument("--flow-report", type=Path)
    parser.add_argument("--native-order-report", type=Path)
    args = parser.parse_args()
    config, result, _manifests = load_output(args.output)
    if config["identity"].get("method") == "native-cme-full-day-encoding/1" and args.raw is not None:
        plan, _files, raw_hash = core.admit_source(args.raw, args.depth_plan, config["identity"]["depth"])
        if config["identity"]["rawSha256"] != raw_hash:
            raise ValueError("checker source differs from native derivation")
        records = core.native_records(args.raw, plan["partition"]["date"])
        try:
            report = check(args.output, core.normalized(records, instrument=config["instrumentId"], start=int(config["fromNs"]),
                           end=int(config["toNs"]), expected=config["expectedRows"], raw_hash=raw_hash))
        finally:
            records.close()
    elif (config["identity"].get("method") in ("equity-first-depth-full-day-encoding/1", "equity-first-depth-full-day-encoding/2")
          and all(path is not None for path in (args.trade_plan, args.quote_plan, args.flow_report))):
        if config["identity"]["method"].endswith("/2"):
            from verify_historical_equity_native import validate_receipt
            if args.native_order_report is None:
                parser.error("version 2 equity checker requires native ordering receipt")
            validate_receipt(args.native_order_report, config["identity"]["nativeOrderReportSha256"],
                             json.loads(args.flow_report.read_text()), config["identity"]["flowReportSha256"])
        records = equity_source(config, args.depth_plan, args.trade_plan, args.quote_plan, args.flow_report)
        try:
            report = check(args.output, records)
        finally:
            records.close()
    else:
        parser.error("source inputs do not match the pinned derivation method")
    print(json.dumps(report, sort_keys=True))
