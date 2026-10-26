"""Where a partition's bytes live, per provider.

Databento and Binance published keys both carry the provider twice: the
publisher's prefix ends with it and the stored partition prefix begins with it.
Those immutable paths are the authority, so the reader reproduces rather than
normalises them.

The invariant that matters is not the shape of either path -- it is that the
publisher and the reader compute the *same string*. Nothing else in the system
compares them, and a disagreement reads as absent data rather than as an error.
"""
from __future__ import annotations

import pytest

import archive_query as aq
import s3_publish

READER_ROOT = "curated"
DATABENTO_PUBLISHER_ROOT = "curated/databento"
BINANCE_PUBLISHER_ROOT = "curated/binance"

LIVE_DATABENTO_PREFIX = (
    "databento/XCME_FUTURE_ESH6_USD_CONTRACT-3092a3cd/candle/"
    "w606-ohlcv-v1-glbx-mdp3-ohlcv-1s-es-2025-12/2025-12-17"
)
BINANCE_PREFIX = "binance/BINANCE_SPOT_BTCUSDT_USDT_COIN-1a2b3c4d/candle_1m/w606-binance-v1/2026-01-02"


def _publisher_key(root, s3_prefix):
    return s3_publish.Store(_FakeClient(), "bucket", root).key(s3_prefix)


class _FakeClient:
    pass


def test_a_providerless_legacy_catalog_row_defaults_to_databento():
    """Probed against the live bucket on 2026-09-15. If this changes, every
    published Databento partition becomes unreachable."""
    key = aq.partition_key(READER_ROOT, LIVE_DATABENTO_PREFIX, None)
    assert key == (
        "curated/databento/databento/XCME_FUTURE_ESH6_USD_CONTRACT-3092a3cd/candle/"
        "w606-ohlcv-v1-glbx-mdp3-ohlcv-1s-es-2025-12/2025-12-17"
    )


def test_a_binance_catalog_row_uses_its_published_double_provider_path():
    assert aq.partition_key(READER_ROOT, BINANCE_PREFIX, "binance") == f"curated/binance/{BINANCE_PREFIX}"


@pytest.mark.parametrize("publisher_root,prefix,provider", [
    (DATABENTO_PUBLISHER_ROOT, LIVE_DATABENTO_PREFIX, None),
    (BINANCE_PUBLISHER_ROOT, BINANCE_PREFIX, "binance"),
])
def test_the_publisher_and_the_reader_agree_on_the_key(publisher_root, prefix, provider):
    """The load-bearing invariant. The two roots differ by provider because the
    history does, and only this comparison notices if they stop lining up."""
    assert _publisher_key(publisher_root, prefix) == aq.partition_key(READER_ROOT, prefix, provider)


def test_an_unknown_provider_is_refused_rather_than_defaulted():
    """Tardis has raw objects but no curated root. Defaulting it would resolve a
    partition to a key that does not exist and report it as a coverage gap."""
    with pytest.raises(aq.ArchiveQueryError) as refused:
        aq.partition_key(READER_ROOT, "tardis/inst/candle/v1/2026-01-02", "tardis")
    assert refused.value.detail["reason"] == "UNSUPPORTED_PARTITION_PROVIDER"
    assert refused.value.detail["provider"] == "tardis"


def test_the_reader_root_may_span_providers_but_never_escapes_curated():
    """A reader has to see every provider, so the bare curated root is allowed.
    The rail that stops it addressing raw/ or the bucket root is not."""
    assert s3_publish.Store(_FakeClient(), "b", "curated").prefix == "curated"
    for outside in ("raw", "raw/databento", "other/curated", "curatedish"):
        with pytest.raises(s3_publish.PublicationError, match="CURATED_NAMESPACE_REQUIRED"):
            s3_publish.Store(_FakeClient(), "b", outside)
    with pytest.raises(s3_publish.PublicationError, match="UNSAFE_OBJECT_PATH"):
        s3_publish.Store(_FakeClient(), "b", "")


def test_every_known_provider_resolves_under_curated_only_when_the_catalog_declares_it():
    for provider in aq.PROVIDER_ROOT_SEGMENT:
        key = aq.partition_key(READER_ROOT, f"{provider}/inst/candle/v1/2026-01-02", provider)
        assert key.startswith("curated/")


def test_a_declared_provider_and_stored_prefix_must_agree():
    with pytest.raises(aq.ArchiveQueryError) as refused:
        aq.partition_key(READER_ROOT, BINANCE_PREFIX, "databento")
    assert refused.value.detail["reason"] == "PARTITION_PROVIDER_PREFIX_MISMATCH"
