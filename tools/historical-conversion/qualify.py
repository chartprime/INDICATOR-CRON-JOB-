"""Read local samples; retain reproducible measurements. No remote activity."""
import json
from pathlib import Path
import platform
import statistics
import subprocess
import sys
import time
import uuid
import psutil
from convert import REPO, HERE, query


def run():
    root = REPO / "apps/runtime/data/conversion-prototype"
    output = root / ("q-" + uuid.uuid4().hex[:8])
    output.mkdir()
    report = {"scope": "bounded sample qualification, not capacity SLA", "python": sys.version, "platform": platform.platform(), "runs": []}
    for filename, kind, family in [("btc-spot-trades.csv.gz", "tardis-trades", "trade"), ("aapl-mbp10.dbn.zst", "databento-mbp", "depth")]:
        stdout = output / (filename + ".result.json")
        stderr = output / (filename + ".stderr.txt")
        command = [sys.executable, str(HERE / "convert.py"), str(root / "samples" / filename), str(output / "converted"), "--kind", kind, "--max-rows", "10000"]
        start = time.perf_counter()
        samples = []
        with stdout.open("wb") as out, stderr.open("wb") as err:
            child = subprocess.Popen(command, stdout=out, stderr=err)
            owned = psutil.Process(child.pid)
            while child.poll() is None:
                total = 0
                try:
                    for process in [owned] + owned.children(recursive=True):
                        try:
                            total += process.memory_info().rss
                        except (psutil.NoSuchProcess, psutil.AccessDenied):
                            pass
                except psutil.NoSuchProcess:
                    pass
                samples.append(total)
                if time.perf_counter() - start > 360:
                    for process in owned.children(recursive=True):
                        process.kill()
                    child.kill()
                    child.wait()
                    raise RuntimeError("QUALIFICATION_DEADLINE")
                time.sleep(0.02)
            if child.returncode:
                raise RuntimeError(stderr.read_text())
        wall = time.perf_counter() - start
        result = json.loads(stdout.read_text())
        manifest = result["manifest"]
        end = str(int(manifest["maximumEventNs"]) + 1)
        timings = []
        for _ in range(5):
            begin = time.perf_counter()
            response = query(result["directory"], family, manifest["minimumEventNs"], end, 100)
            timings.append({"wholeCallMs": (time.perf_counter() - begin)*1000, "sqlMs": response["querySeconds"]*1000, "rows": len(response["rows"])})
        repeated = subprocess.run(command, capture_output=True, check=True, timeout=60)
        assert json.loads(repeated.stdout)["reused"] is True
        report["runs"].append({"input": filename, "wallSeconds": wall, "sampledProcessTreePeakRssBytes": max(samples), "rssSampleIntervalMs": 20,
                               "manifest": manifest, "queries": timings, "medianQueryWholeCallMs": statistics.median(x["wholeCallMs"] for x in timings),
                               "repeatReuse": True, "cacheQualification": "OS cache not cleared; new DuckDB connection each call, includes full output-hash verification"})
        print(filename, manifest["rawRows"], "rows", round(wall, 3), "seconds", flush=True)
    (output / "qualification.json").write_text(json.dumps(report, indent=2))
    print(str(output / "qualification.json"))


if __name__ == "__main__":
    run()
