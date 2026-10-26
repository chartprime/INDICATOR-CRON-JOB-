import gzip
import json
from pathlib import Path
import shutil
import tempfile
import unittest

from convert import convert, query, verify_commit, REPO, digest


HEADER = "exchange,symbol,timestamp,local_timestamp,id,side,price,amount\n"
ROW = "binance,BTCUSDT,1757116800189377,1757116800192418,5218120362,buy,110660.123456789,0.00117\n"


class ConversionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="w606-test-")
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def sample(self, content=HEADER + ROW):
        path = self.root / "sample.csv.gz"
        with gzip.open(path, "wt", newline="") as f:
            f.write(content)
        return path

    def test_roundtrip_exact_prices_times_and_counts(self):
        source = self.sample()
        r = convert(source, self.root / "out", "tardis-trades")
        self.assertEqual(r["manifest"]["scope"], "COMPLETE_INPUT")
        self.assertEqual(r["manifest"]["rawRows"], 1)
        result = query(r["directory"], "trade", "1757116800189377000", "1757116800189377001")
        record = result["rows"][0]
        self.assertEqual(record["time"]["eventNs"], "1757116800189377000")
        self.assertEqual(record["data"]["price"], {"coefficient": "110660123456789", "scale": 9})
        self.assertIn("PROTOTYPE_INGEST_TIME_UNAVAILABLE", record["quality"]["flags"])
        self.assertEqual(query(r["directory"], "trade", "1757116800189377001", "1757116800189377002")["rows"], [])

    def test_repeat_reuses_verified_commit(self):
        source = self.sample()
        a = convert(source, self.root / "out", "tardis-trades")
        b = convert(source, self.root / "out", "tardis-trades")
        self.assertTrue(b["reused"])
        self.assertEqual(a["directory"], b["directory"])

    def test_repacked_path_same_raw_yields_same_logical_content(self):
        source = self.sample()
        copy = self.root / "copy.csv.gz"
        shutil.copyfile(source, copy)
        a = convert(source, self.root / "one", "tardis-trades")
        b = convert(copy, self.root / "two", "tardis-trades")
        self.assertEqual(a["manifest"]["logicalSha256"], b["manifest"]["logicalSha256"])

    def test_interruption_never_publishes_and_rerun_succeeds(self):
        source = self.sample()
        output = self.root / "out"
        with self.assertRaisesRegex(RuntimeError, "INJECTED_INTERRUPTION"):
            convert(source, output, "tardis-trades", fail_after_batch=1)
        self.assertTrue(all(p.name.startswith(".stage-") for p in output.iterdir()))
        stage = next(output.iterdir())
        self.assertFalse((stage / "manifest.json").exists())
        self.assertEqual(json.loads((stage / "failure.json").read_text())["status"], "FAILED_UNPUBLISHED")
        result = convert(source, output, "tardis-trades")
        self.assertEqual(verify_commit(Path(result["directory"]))["rawRows"], 1)

    def test_bad_numeric_quarantines_and_blocks_commit(self):
        source = self.sample(HEADER + ROW.replace("110660.123456789", "NaN"))
        output = self.root / "out"
        with self.assertRaisesRegex(ValueError, "QUARANTINED_ROWS_BLOCK_COMMIT"):
            convert(source, output, "tardis-trades")
        stage = next(output.iterdir())
        reject = json.loads((stage / "rejected.ndjson").read_text())
        self.assertEqual(reject["reason"], "INVALID_DECIMAL")
        self.assertEqual(reject["lineage"]["sha256"], digest(source))
        self.assertFalse((stage / "manifest.json").exists())

    def test_csv_malformed_fails_unpublished(self):
        with self.assertRaisesRegex(ValueError, "RAGGED_CSV"):
            convert(self.sample(HEADER + ROW.rstrip() + ",extra\n"), self.root / "out", "tardis-trades")

    def test_csv_duplicate_headers_fail(self):
        with self.assertRaisesRegex(ValueError, "INVALID_CSV_HEADER"):
            convert(self.sample(HEADER.rstrip() + ",amount\n"), self.root / "out", "tardis-trades")

    def test_truncated_gzip_never_commits_complete_input(self):
        source = self.sample()
        source.write_bytes(source.read_bytes()[:-8])
        with self.assertRaises(EOFError):
            convert(source, self.root / "out", "tardis-trades")

    def test_prefix_limit_is_explicit(self):
        source = self.sample(HEADER + ROW + ROW.replace("5218120362", "5218120363"))
        result = convert(source, self.root / "out", "tardis-trades", max_rows=1)
        self.assertEqual(result["manifest"]["scope"], "PREFIX_SAMPLE")
        self.assertEqual(result["manifest"]["rawRows"], 1)

    def test_modified_output_fails_reuse_and_query(self):
        source = self.sample()
        result = convert(source, self.root / "out", "tardis-trades")
        target = Path(result["directory"]) / "observations.parquet"
        with target.open("ab") as f:
            f.write(b"corruption")
        with self.assertRaisesRegex(ValueError, "OUTPUT_HASH_MISMATCH"):
            convert(source, self.root / "out", "tardis-trades")
        with self.assertRaisesRegex(ValueError, "OUTPUT_HASH_MISMATCH"):
            query(result["directory"], "trade", 1, 2)

    def test_real_public_dbn_uses_maintained_decoder(self):
        source = REPO / "apps/runtime/test/contracts/fixtures/market-observation-v1/databento-tbbo.dbn"
        result = convert(source, self.root / "out", "databento-mbp")
        self.assertEqual(result["manifest"]["familyCounts"], {"quote": 2, "trade": 2})
        self.assertEqual(result["manifest"]["metadata"]["version"], 2)
        self.assertEqual(result["manifest"]["scope"], "COMPLETE_INPUT")

    def test_input_and_query_limits(self):
        source = self.sample()
        with self.assertRaisesRegex(ValueError, "INVALID_PROTOTYPE_LIMIT"):
            convert(source, self.root / "out", "tardis-trades", max_rows=100001)
        with self.assertRaisesRegex(ValueError, "OUTPUT_MUST_NOT_CONTAIN_SOURCE"):
            convert(source, self.root, "tardis-trades")


if __name__ == "__main__":
    unittest.main(verbosity=2)
