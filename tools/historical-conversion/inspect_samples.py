"""Bounded local inspection; no network or credentials."""
import csv
import gzip
import importlib.metadata
import json
from pathlib import Path
import databento_dbn as dbn

ROOT = Path(__file__).resolve().parents[2]
print(json.dumps({name: importlib.metadata.version(name) for name in ("databento-dbn", "duckdb", "psutil", "zstandard")}))
paths = [ROOT / "apps/runtime/data/conversion-prototype/samples/aapl-mbp10.dbn.zst", ROOT / "apps/runtime/test/contracts/fixtures/market-observation-v1/databento-mbp1.dbn"]
for path in paths:
    if not path.exists():
        continue
    decoder = dbn.DBNDecoder(compression=dbn.Compression.ZSTD if path.suffix == ".zst" else dbn.Compression.NONE)
    with path.open("rb") as f:
        seen = False
        for _ in range(16):
            chunk = f.read(65536)
            if not chunk:
                break
            for item in decoder.write_and_decode(chunk):
                if isinstance(item, dbn.Metadata):
                    print(json.dumps({"file": path.name, "version": item.version, "dataset": item.dataset, "schema": str(item.schema), "stype_in": str(item.stype_in), "stype_out": str(item.stype_out), "mappings": item.mappings, "symbols": item.symbols}, default=str))
                elif not seen:
                    print(json.dumps({"type": type(item).__name__, **{k: str(getattr(item, k)) for k in ("ts_event", "ts_recv", "instrument_id", "price", "size", "action", "side", "flags", "sequence")}, "levels": str(item.levels[:1])}))
                    seen = True
            if seen:
                break
path = ROOT / "apps/runtime/data/conversion-prototype/samples/btc-spot-trades.csv.gz"
if path.exists():
    with gzip.open(path, "rt", newline="") as f:
        reader = csv.DictReader(f)
        print(json.dumps({"file": path.name, "header": reader.fieldnames, "first": next(reader)}))
