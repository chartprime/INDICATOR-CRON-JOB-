from __future__ import annotations

import json
from pathlib import Path

import jsonschema
import pytest

from writer import _COMMON_COLUMNS, _FAMILY_COLUMNS


SCHEMA_PATH = (
    Path(__file__).resolve().parents[4]
    / "docs/contracts/archive-query/v1/archive-query-v1.schema.json"
)
POINTER_SHA = "a" * 64
FINGERPRINT = "b" * 64
INSTRUMENT = '["XCME","FUTURE","NQU5","USD","CONTRACT"]'


def _schema():
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def _validator():
    schema = _schema()
    validator_class = jsonschema.validators.validator_for(schema)
    validator_class.check_schema(schema)
    return validator_class(schema)


def _request(**overrides):
    result = {
        "contractVersion": "archive-query/1",
        "instrumentId": INSTRUMENT,
        "family": "trade",
        "from": "1756684800000000000",
        "to": "1756771200000000000",
    }
    result.update(overrides)
    return result


def _base_row(**overrides):
    result = {
        "record_id": "6181f49fb719cff25a5a70e2be027ebe9d2db18c",
        "event_ns": "1756684800053320325",
        "source_rank": 0,
        "stable_position": "5",
        "ordinal": 0,
        "sequence": "8394549",
        "receive_ns": "1756684800053320400",
        "ingest_ns": "1756684800053320500",
        "time_precision": "nanosecond",
        "time_origin": "exchange",
        "instrument_id": INSTRUMENT,
        "venue": "XCME",
        "market": "FUTURE",
        "symbol": "NQU5",
        "currency": "USD",
        "size_unit": "contracts",
        "contract": "NQU5",
        "source_provider": "databento",
        "source_dataset": "GLBX.MDP3",
        "source_schema": "trades",
        "source_population": "all",
        "source_dataset_version": "w606-l1-v2",
        "source_method_version": "1",
        "source_symbol": "NQ",
        "mapping_version": "2025-09",
        "mapping_reference": "instrument-map-v1",
        "stream_id": "NQ/trade",
        "lineage_sha256": "c" * 64,
        "lineage_row": "12",
        "quality_state": "PUBLISHED",
        "quality_flags": [],
    }
    result.update(overrides)
    return result


def _trade_row(**overrides):
    result = _base_row(
        trade_entity_id="trade-1",
        price="25123.250000000000",
        size="2.000000000000",
        side="ask",
        trade_action="trade",
        valid_tick=True,
        replaces=None,
        dbn_publisher_id="1",
        dbn_source_flags=0,
        dbn_source_action="ADD",
    )
    result.update(overrides)
    return result


def _quote_row(**overrides):
    result = _base_row(
        bid_price="25123.000000000000",
        bid_size="4.000000000000",
        ask_price="25123.250000000000",
        ask_size="3.000000000000",
        dbn_source_flags=0,
        dbn_publisher_id="1",
        dbn_source_action="ADD",
    )
    result.update(overrides)
    return result


def _candle_row(**overrides):
    result = _base_row(
        open_ns="1756684800000000000",
        close_ns="1756684860000000000",
        open="25123.000000000000",
        high="25125.000000000000",
        low="25122.500000000000",
        close="25124.000000000000",
        volume="42.000000000000",
        buy_volume="23.000000000000",
        closed=True,
        method="ohlcv-1m",
        quote_volume="1055208.000000000000",
        taker_buy_quote_volume="577852.000000000000",
        taker_sell_base_volume="19.000000000000",
        taker_sell_quote_volume="477356.000000000000",
        trade_count="318",
    )
    result.update(overrides)
    return result


def _depth_row(**overrides):
    result = _base_row(
        depth_action="update",
        depth_model="mbp-10",
        depth_limit=10,
        bids=[{"price": "25123.000000000000", "size": "4.000000000000"}],
        asks=[{"price": "25123.250000000000", "size": "3.000000000000"}],
        first_sequence="1",
        last_sequence="2",
        previous_sequence=None,
        batch_id="batch-1",
        batch_end=True,
        reset=False,
        book_epoch=1,
        continuity="continuous",
        dbn_source_flags=0,
        dbn_publisher_id="1",
    )
    result.update(overrides)
    return result


def _trade_minute_row(**overrides):
    """A derived row as it goes on the wire: its bucket and its payload, and
    none of the identity envelope a `trade` row carries."""
    result = {
        "event_ns": "1756684800000000000",
        "open_ns": "1756684800000000000",
        "close_ns": "1756684860000000000",
        "volume": "42.000000000000",
        "buy_volume": "23.000000000000",
        "sell_volume": "19.000000000000",
        "undefined_volume": "0.000000000000",
        "buy_notional": "577852.000000000000",
        "sell_notional": "477356.000000000000",
        "trade_count": "318",
        "method": "trade_minute/1",
    }
    result.update(overrides)
    return result


def _trade_level_row(**overrides):
    result = {
        "event_ns": "1756684800000000000",
        "open_ns": "1756684800000000000",
        "close_ns": "1756684860000000000",
        "tick_size": "0.250000000000",
        "price_bucket": "100493",
        "volume": "7.000000000000",
        "buy_volume": "4.000000000000",
        "sell_volume": "3.000000000000",
        "trade_count": "5",
        "method": "trade_level/1",
    }
    result.update(overrides)
    return result


def _response(family="trade", rows=None, **overrides):
    if rows is None:
        rows = [_trade_row()]
    result = {
        "contractVersion": "archive-query/1",
        "pointer": {
            "dataset_version": "w606-l1-v2-glbx-mdp3-mbp-1-nq-2025-09",
            "catalog_key": "catalog-w606-l1-v2-glbx-mdp3-mbp-1-nq-2025-09.sqlite",
            "catalog_sha256": POINTER_SHA,
            "publisher_fence": 58,
        },
        "pointerToken": "dG9rZW4tMQ",
        "family": family,
        "rows": rows,
        "nextCursor": None,
        "queryFingerprint": FINGERPRINT,
        "coverage": {
            "requested": {"from": "1756684800000000000", "to": "1756771200000000000"},
            "served": {"from": "1756684800000000000", "to": "1756771200000000000"},
            "partitions": 1,
            "states": {"PUBLISHED": 1},
        },
        "scan": {"partitionsRead": 1, "partitionsSelected": 1, "partsOpened": 1,
                 "exactScanBytes": 3360000, "bytesRead": 3360000, "cacheHits": 1,
                 "cacheMisses": 0, "fetchMs": 1.0, "queryMs": 1.0},
    }
    result.update(overrides)
    return result


def test_the_schema_is_itself_a_valid_json_schema():
    _validator()


def test_the_root_rejects_arbitrary_json():
    validator = _validator()
    for document in ({"hello": "world"}, {}, [], "string", 42):
        assert not validator.is_valid(document), document


def test_each_message_kind_validates():
    assert _validator().is_valid(_request())
    assert _validator().is_valid(_response())
    assert _validator().is_valid(
        {
            "contractVersion": "archive-query/1",
            "error": "RANGE_TOO_LARGE",
            "estimatedScanBytes": 268435457,
            "effectiveMaxScanBytes": 268435456,
        }
    )
    assert _validator().is_valid(
        {"contractVersion": "archive-query/1", "error": "POINTER_TOKEN_INVALID"}
    )
    assert _validator().is_valid(
        {"contractVersion": "archive-query/1", "error": "CACHE_CAPACITY_EXCEEDED"}
    )
    assert _validator().is_valid(
        {
            "contractVersion": "archive-query/1",
            "error": "WINDOW_TOO_LARGE",
            "family": "trade",
            "requestedWindowNs": "691200000000000",
            "maxWindowNs": "604800000000000",
        }
    )


def test_a_request_cannot_supply_a_raw_catalog_pointer():
    validator = _validator()
    raw = _request(
        pointer={
            "dataset_version": "v",
            "catalog_key": "../../etc/passwd",
            "catalog_sha256": POINTER_SHA,
            "publisher_fence": 1,
        }
    )
    assert not validator.is_valid(raw)
    assert validator.is_valid(_request(pointerToken="dG9rZW4tMQ"))


def test_a_response_issues_the_token_needed_to_pin_later_pages():
    validator = _validator()
    response = _response()
    del response["pointerToken"]
    assert not validator.is_valid(response)


def test_a_cursor_is_bound_to_its_whole_query_not_just_the_pointer():
    payload = {
        "version": 1,
        "expiresAt": 1,
        "queryFingerprint": FINGERPRINT,
        "pointerSha256": POINTER_SHA,
        "eventNs": "1756684800053320325",
        "sourceRank": 0,
        "stablePosition": "5",
        "ordinal": 0,
        "tag": "c" * 64,
    }
    schema = _schema()
    cursor_schema = {**schema, "$ref": "#/$defs/cursorPayload"}
    cursor_validator = jsonschema.validators.validator_for(cursor_schema)(cursor_schema)
    assert cursor_validator.is_valid(payload)
    missing_fingerprint = {key: value for key, value in payload.items() if key != "queryFingerprint"}
    assert not cursor_validator.is_valid(missing_fingerprint)


def test_a_scan_bound_above_the_effective_cap_is_refused():
    validator = _validator()
    cap = _schema()["$defs"]["scanBytes"]["maximum"]
    assert cap == 268435456
    assert validator.is_valid(_request(maxScanBytes=cap))
    assert not validator.is_valid(_request(maxScanBytes=cap + 1))


def test_range_too_large_carries_the_estimate_and_effective_cap():
    validator = _validator()
    error = {"contractVersion": "archive-query/1", "error": "RANGE_TOO_LARGE"}
    assert not validator.is_valid(error)
    for missing in ("estimatedScanBytes", "effectiveMaxScanBytes"):
        candidate = {
            "contractVersion": "archive-query/1",
            "error": "RANGE_TOO_LARGE",
            "estimatedScanBytes": 268435457,
            "effectiveMaxScanBytes": 268435456,
        }
        del candidate[missing]
        assert not validator.is_valid(candidate), missing


def test_window_too_large_carries_durations_not_a_fabricated_byte_estimate():
    validator = _validator()
    error = {
        "contractVersion": "archive-query/1",
        "error": "WINDOW_TOO_LARGE",
        "family": "trade",
        "requestedWindowNs": "691200000000000",
        "maxWindowNs": "604800000000000",
    }
    assert validator.is_valid(error)
    for missing in ("family", "requestedWindowNs", "maxWindowNs"):
        candidate = dict(error)
        del candidate[missing]
        assert not validator.is_valid(candidate), missing


def test_an_unmeasured_family_cannot_be_admitted_by_a_placeholder_estimate():
    validator = _validator()
    assert validator.is_valid(
        {"contractVersion": "archive-query/1", "error": "ESTIMATE_UNVERIFIED", "family": "depth"}
    )
    assert not validator.is_valid(
        {"contractVersion": "archive-query/1", "error": "ESTIMATE_UNVERIFIED"}
    )


def test_rows_are_complete_family_shapes_not_an_open_array():
    validator = _validator()
    assert not validator.is_valid(_response(rows=[{"whatever": True}]))
    assert validator.is_valid(_response("quote", [_quote_row()]))
    assert validator.is_valid(_response("candle", [_candle_row()]))
    assert validator.is_valid(_response("depth", [_depth_row()]))
    assert not validator.is_valid(_response("trade", [_quote_row()]))


def test_a_derived_row_carries_its_payload_without_the_identity_envelope():
    # The families that existed before the derived aggregates keep the full
    # envelope; a bucket carries only what a consumer can use, which is about a
    # quarter of the bytes. Both shapes have to validate, and neither may
    # validate as the other.
    validator = _validator()
    assert validator.is_valid(_response("trade_minute_1m", [_trade_minute_row()]))
    assert validator.is_valid(_response("trade_level_1m", [_trade_level_row()]))
    assert not validator.is_valid(_response("trade_minute_1m", [_trade_level_row()]))
    assert not validator.is_valid(_response("trade", [_trade_minute_row()]))
    assert not validator.is_valid(
        _response("trade_minute_1m", [{k: v for k, v in _trade_minute_row().items() if k != "volume"}]))


def test_a_derived_row_may_not_smuggle_extra_fields():
    assert not _validator().is_valid(
        _response("trade_minute_1m", [_trade_minute_row(record_id="rec-1")]))


def test_row_contract_field_names_match_the_persisted_writer_layout():
    schema = _schema()["$defs"]
    assert set(schema["archiveRowBase"]["properties"]) == set(_COMMON_COLUMNS)
    for family, columns in _FAMILY_COLUMNS.items():
        row = schema[f"{family}Row"]
        family_properties = row["allOf"][1]["properties"]
        assert set(family_properties) == set(columns)

    assert len(_COMMON_COLUMNS) + len(_FAMILY_COLUMNS["trade"]) == 41
    assert len(_COMMON_COLUMNS) + len(_FAMILY_COLUMNS["quote"]) == 38


@pytest.mark.parametrize(
    "field,value",
    [
        ("event_ns", 1756684800053320325),
        ("stable_position", 5),
        ("sequence", 8394549),
        ("receive_ns", 1756684800053320400),
        ("ingest_ns", 1756684800053320500),
        ("lineage_row", 12),
        ("dbn_publisher_id", 1),
        ("price", 25123.25),
        ("size", 2.0),
    ],
)
def test_exact_64_bit_and_decimal_values_are_never_json_numbers(field, value):
    assert not _validator().is_valid(_response(rows=[_trade_row(**{field: value})]))


def test_unknown_row_fields_cannot_bypass_the_contract():
    row = _trade_row(unreviewed_new_column="anything")
    assert not _validator().is_valid(_response(rows=[row]))


def test_pointer_fence_never_crosses_node_exact_integer_precision():
    response = _response()
    response["pointer"]["publisher_fence"] = 9007199254740992
    assert not _validator().is_valid(response)


def test_a_window_must_be_well_formed():
    validator = _validator()
    assert not validator.is_valid(_request(**{"from": "not-a-number"}))
    assert not validator.is_valid(_request(**{"from": 1756684800000000000}))


def test_d14_targets_are_pinned_to_the_documented_lenient_admission_floor():
    targets = _schema()["$defs"]["targets"]["properties"]
    assert {name: definition["const"] for name, definition in targets.items()} == {
        "catalogResolveP95Ms": 10,
        "warmPagedReadP95Ms": 100,
        "coldFirstTouchP95Ms": 5000,
        "concurrentWarmReadsP95Ms": 500,
        "concurrentWarmReaders": 8,
        "defaultPageLimit": 1000,
        "synchronousMaxScanBytes": 268435456,
    }
